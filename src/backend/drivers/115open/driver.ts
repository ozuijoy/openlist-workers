// 115 Open (115網盤開放平台) driver
// Re-ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/115_open
// (driver.go — StorageDriver interface implementation)
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { sha1, hmacSha1Base64 } from "../../pkg/crypto"
import { Pan115Addition, Pan115File } from "./types"
import { Pan115Client, ERR_OBJECT_NOT_FOUND } from "./util"

/** OpenList Go base.UserAgent（與 Go 驅動一致，115 防盜鏈校驗通過率高） */
const OPENLIST_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/142.0.0.0 OpenList/425.6.30"

/** CF Workers 免費版單次 invocation 子請求預算（留餘量） */
const SUBREQUEST_LIMIT = 45

function pan115FileToFileItem(f: Pan115File): FileItem {
  const isDir = f.fc === "0"
  return {
    name: f.fn,
    size: f.fs || 0,
    is_dir: isDir,
    created: f.uppt ? new Date(f.uppt * 1000).toISOString() : undefined,
    modified: f.upt
      ? new Date(f.upt * 1000).toISOString()
      : new Date().toISOString(),
    sign: f.fid,
    type: calcFileType(f.fn, isDir),
    thumb: f.thumbnail || f.fco || "",
    raw_url: "",
  }
}

export function normalizePan115Addition(a: any): Pan115Addition {
  const norm = { ...(a || {}) } as any
  norm.order_by = norm.order_by || "file_name"
  norm.order_direction = norm.order_direction || "asc"
  norm.page_size = norm.page_size || 200
  // 相容 OpenList Go 原版欄位名（root_folder_id → root_id）
  if ((norm.root_folder_id || norm.root_folder_id === "0") && !norm.root_id) {
    norm.root_id = String(norm.root_folder_id)
  }
  return norm as Pan115Addition
}

export class Pan115Driver implements StorageDriver {
  private client: Pan115Client
  private addition: Pan115Addition
  private pageSize = 200
  /** root 非默認時，路徑前綴（Go Init 計算 parentPath） */
  private parentPath = "/"
  /** cache: 物理路徑 → fid（複用） */
  private fidCache = new Map<string, string>()
  /** CF subrequest 預算 */
  private budget = { used: 0, limit: SUBREQUEST_LIMIT }
  /**
   * 下載鏈接快取（Go LinkCacheMode=UA 等價）：按 文件ID+UA 快取，TTL 30 分鐘。
   * 115 免費用戶 downurl 介面有每日配額（code 406），快取顯著減少調用次數。
   */
  private linkCache = new Map<string, { url: string; expire: number }>()
  private static readonly LINK_TTL_MS = 30 * 60 * 1000

  constructor(
    addition: Pan115Addition,
    onTokenUpdate?: (tokens: {
      access_token: string
      refresh_token: string
    }) => void,
  ) {
    this.addition = normalizePan115Addition(addition)
    this.client = new Pan115Client(this.addition, onTokenUpdate)
  }

  async init(): Promise<void> {
    const a = this.addition
    // page_size 1~1150（Go Init 限制）
    let ps = a.page_size || 200
    if (ps <= 0) ps = 200
    if (ps > 1150) ps = 1150
    this.pageSize = ps

    // 驗證 token（失敗即掛載失敗，給出明確錯誤）
    try {
      await this.client.userInfo()
    } catch (e: any) {
      if (e?.code === ERR_OBJECT_NOT_FOUND) throw e
      const msg = String(e?.message || e)
      if (
        msg.includes("fetch") ||
        msg.includes("ECONN") ||
        msg.includes("abort")
      ) {
        throw new Error(
          `115 網盤網路連接失敗（${msg}）：proapi.115.com 可能無法從當前部署環境訪問` +
            `（資料中心 IP 可能被 115 攔截），請稍後重試或更換部署環境。`,
        )
      }
      throw new Error(
        `115 網盤 token 驗證失敗：${msg}。請確認 access_token / refresh_token 有效。`,
      )
    }

    // 非根目錄掛載 → 計算路徑前綴（Go Init parentPath）
    const rootId = this.getRootId()
    if (rootId !== "0") {
      try {
        const info = await this.client.getFolderInfo(rootId)
        if (info.file_id !== "0") {
          this.parentPath = `/${info.file_name}`
          const paths = [...(info.paths || [])].reverse()
          for (const p of paths) {
            this.parentPath = `/${p.file_name}${this.parentPath}`
          }
        }
      } catch (e: any) {
        console.warn("[115open] init root path resolve failed:", e.message)
      }
    }
  }

  private getRootId(): string {
    return (this.addition.root_id || "0").trim() || "0"
  }

  private reserve(): boolean {
    if (this.budget.used >= this.budget.limit) {
      console.warn(
        `[115open] 已達 Cloudflare subrequest 預算上限(${this.budget.limit})，結果已截斷`,
      )
      return false
    }
    this.budget.used++
    return true
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    this.budget.used = 0
    const cid = await this.resolveFolderId(physicalPath)
    const items: FileItem[] = []
    let offset = 0
    for (;;) {
      if (!this.reserve()) break
      const { files, count } = await this.client.getFiles({
        cid,
        limit: this.pageSize,
        offset,
        asc: this.addition.order_direction === "asc",
        o: this.addition.order_by || "file_name",
        showDir: true,
      })
      for (const f of files) {
        items.push(pan115FileToFileItem(f))
        this.fidCache.set(f.fid, f.fid)
      }
      if (items.length >= count || files.length === 0) break
      offset += files.length
    }
    return sortFileItems(
      items,
      this.addition.order_by || "file_name",
      this.addition.order_direction,
    )
  }

  /** 解析物理路徑 → 文件夾 fid（逐層 getFolderInfoByPath，帶快取） */
  private async resolveFolderId(physicalPath: string): Promise<string> {
    const rootId = this.getRootId()
    const clean =
      "/" +
      String(physicalPath || "")
        .split("/")
        .filter(Boolean)
        .join("/")
    if (clean === "/" || clean === `/${rootId}`) return rootId

    const cached = this.fidCache.get(clean)
    if (cached) return cached

    // 用 GetFolderInfoByPath 一次性解析（Go Get 邏輯）
    const fullPath = `/${rootId === "0" ? "" : rootId}${clean === "/" ? "" : clean}`
    try {
      if (!this.reserve()) throw new Error("subrequest budget exceeded")
      const info = await this.client.getFolderInfoByPath(fullPath)
      if (info.file_id) {
        this.fidCache.set(clean, info.file_id)
        return info.file_id
      }
    } catch (e: any) {
      // folder/get_info 只支持目錄路徑：參數錯誤(990002)/不存在(430004) → 回退逐層
      if (e?.code !== ERR_OBJECT_NOT_FOUND && e?.code !== 990002) throw e
    }
    // 逐層解析
    const segs = clean.split("/").filter(Boolean)
    let cid = rootId
    let prefix = ""
    for (const rawSeg of segs) {
      const decodedSeg = (() => {
        try {
          return decodeURIComponent(rawSeg)
        } catch {
          return rawSeg
        }
      })()
      prefix = `${prefix}/${rawSeg}`
      const cachedId = this.fidCache.get(prefix)
      if (cachedId) {
        cid = cachedId
        continue
      }
      if (!this.reserve()) throw new Error("subrequest budget exceeded")
      const { files } = await this.client.getFiles({
        cid,
        limit: 1000,
        offset: 0,
        asc: true,
        o: "file_name",
        showDir: true,
      })
      const folder = files.find(
        (f) =>
          f.fc === "0" &&
          (f.fn === rawSeg || f.fn === decodedSeg || f.fid === rawSeg),
      )
      if (!folder) throw new Error(`folder not found: ${rawSeg}`)
      cid = folder.fid
      this.fidCache.set(prefix, cid)
    }
    return cid
  }

  /** 解析物理路徑 → 文件（Go getFromParent 邏輯：列父目錄匹配，拿完整 pick_code） */
  private async resolveFile(physicalPath: string): Promise<Pan115File> {
    const clean =
      "/" +
      String(physicalPath || "")
        .split("/")
        .filter(Boolean)
        .join("/")
    const segs = clean.split("/").filter(Boolean)
    const rawName = segs.pop() || ""
    if (!rawName) throw new Error(`file not found: ${clean}`)
    const decodedName = (() => {
      try {
        return decodeURIComponent(rawName)
      } catch {
        return rawName
      }
    })()
    const parentPath = "/" + segs.join("/")

    const parentId = await this.resolveFolderId(parentPath)
    // 分頁列出父目錄找文件（列表介面返回完整 pick_code；
    // folder/get_info 只支持目錄路徑，對文件路徑不可用）
    let offset = 0
    for (;;) {
      if (!this.reserve()) throw new Error("subrequest budget exceeded")
      const { files, count } = await this.client.getFiles({
        cid: parentId,
        limit: Math.max(this.pageSize, 1000),
        offset,
        asc: true,
        o: "file_name",
        showDir: true,
      })
      const hit = files.find(
        (f) =>
          f.fn === rawName ||
          f.fn === decodedName ||
          f.fid === rawName ||
          f.fid === decodedName,
      )
      if (hit) return hit
      if (files.length === 0 || offset + files.length >= count) break
      offset += files.length
    }
    throw new Error(`file not found: ${rawName}`)
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    this.budget.used = 0
    const clean =
      "/" +
      String(physicalPath || "")
        .split("/")
        .filter(Boolean)
        .join("/")
    if (clean === "/" || clean === `/${this.getRootId()}`) {
      return {
        name: this.getRootId(),
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: this.getRootId(),
        type: 1,
        raw_url: "",
      }
    }
    const file = await this.resolveFile(physicalPath)
    const item = pan115FileToFileItem(file)
    if (file.fc !== "0" && file.pc) {
      try {
        // 鏈接快取（Go LinkCacheMode=UA）：同一 文件+UA 複用鏈接，節省 downurl 配額
        const cacheKey = `${file.fid}|${OPENLIST_UA}`
        const cached = this.linkCache.get(cacheKey)
        if (cached && cached.expire > Date.now()) {
          item.raw_url = cached.url
          item.raw_url_headers = { "User-Agent": OPENLIST_UA }
        } else {
          if (!this.reserve()) throw new Error("subrequest budget exceeded")
          const resp = await this.client.downUrl(file.pc, OPENLIST_UA)
          const entry = resp[file.fid]
          if (entry?.url?.url) {
            item.raw_url = entry.url.url
            item.raw_url_headers = { "User-Agent": OPENLIST_UA }
            this.linkCache.set(cacheKey, {
              url: entry.url.url,
              expire: Date.now() + Pan115Driver.LINK_TTL_MS,
            })
          }
        }
      } catch (e: any) {
        const msg = String(e?.message || e)
        if (msg.includes("406")) {
          console.warn(
            "[115open] downurl 配額用盡（406）：已使用快取或稍後重試",
          )
        } else {
          console.warn(`[115open] downUrl warning for ${file.fn}:`, e.message)
        }
      }
    }
    return item
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    this.budget.used = 0
    const segs = String(physicalPath || "")
      .split("/")
      .filter(Boolean)
    const dirName = segs.pop() || "新文件夾"
    const parentPath = "/" + segs.join("/")
    const parentId = await this.resolveFolderId(parentPath)
    if (!this.reserve()) throw new Error("subrequest budget exceeded")
    await this.client.mkdir(parentId, dirName)
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    this.budget.used = 0
    const file = await this.resolveFile(physicalPath)
    if (!this.reserve()) throw new Error("subrequest budget exceeded")
    await this.client.updateFile(file.fid, newName)
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    this.budget.used = 0
    const file = await this.resolveFile(physicalPath)
    if (!this.reserve()) throw new Error("subrequest budget exceeded")
    await this.client.delFile(file.fid, file.pid || this.getRootId())
  }

  async move(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhys: string,
    _dstPhys: string,
  ): Promise<void> {
    this.budget.used = 0
    const file = await this.resolveFile(srcPhys)
    const dstId = await this.resolveFolderId(dstDir)
    if (!this.reserve()) throw new Error("subrequest budget exceeded")
    await this.client.move(file.fid, dstId)
  }

  async copy(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhys: string,
    _dstPhys: string,
  ): Promise<void> {
    this.budget.used = 0
    const file = await this.resolveFile(srcPhys)
    const dstId = await this.resolveFolderId(dstDir)
    if (!this.reserve()) throw new Error("subrequest budget exceeded")
    await this.client.copy(dstId, file.fid)
  }

  // ---- Upload（OSS 直傳：秒傳 → 二次校驗 → PUT Object） ----

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    if (content.length < 1) {
      throw new Error("115 網盤不允許上傳空文件")
    }
    this.budget.used = 0
    const segs = String(physicalPath || "")
      .split("/")
      .filter(Boolean)
    const fileName = segs.pop() || "file"
    const parentPath = "/" + segs.join("/")
    const parentId = await this.resolveFolderId(parentPath)
    const target = parentId

    const fileSize = content.length
    const sha1Full = (await sha1(content)).toUpperCase()
    const preSize = Math.min(128 * 1024, fileSize)
    const sha1128k = (await sha1(content.subarray(0, preSize))).toUpperCase()

    // 1. UploadInit（秒傳）
    if (!this.reserve()) throw new Error("subrequest budget exceeded")
    let initResp = await this.client.uploadInit({
      fileName,
      fileSize,
      target,
      fileId: sha1Full,
      preId: sha1128k,
    })
    if (initResp.status === 2) return // 秒傳成功

    // 2. 二次校驗（status 6/7/8）
    if ([6, 7, 8].includes(initResp.status) && initResp.sign_check) {
      const parts = initResp.sign_check.split("-")
      const start = parseInt(parts[0], 10)
      const end = parseInt(parts[1], 10)
      if (Number.isFinite(start) && Number.isFinite(end)) {
        const signVal = (
          await sha1(content.subarray(start, end + 1))
        ).toUpperCase()
        if (!this.reserve()) throw new Error("subrequest budget exceeded")
        initResp = await this.client.uploadInit({
          fileName,
          fileSize,
          target,
          fileId: sha1Full,
          preId: sha1128k,
          signKey: initResp.sign_key,
          signVal,
        })
        if (initResp.status === 2) return // 校驗後秒傳成功
      }
    }

    // 3. 獲取 OSS 上傳憑證
    if (!this.reserve()) throw new Error("subrequest budget exceeded")
    const token = await this.client.uploadGetToken()
    if (!initResp.bucket || !initResp.object || !token.endpoint) {
      throw new Error("115 上傳初始化失敗：缺少 OSS 上傳信息")
    }

    // 4. OSS PUT Object（單請求上傳，含 V1 簽名）
    await this.ossPutObject(token, initResp, content)
  }

  private async ossPutObject(
    token: {
      endpoint: string
      AccessKeyId: string
      AccessKeySecret: string
      SecurityToken: string
    },
    initResp: { bucket: string; object: string; callback: any },
    content: Buffer,
  ): Promise<void> {
    const endpoint = token.endpoint.startsWith("http")
      ? token.endpoint
      : `https://${token.endpoint}`
    const url = `${endpoint.replace(/\/$/, "")}/${initResp.object}`
    const cb = Buffer.from(initResp.callback?.callback || "", "utf8").toString(
      "base64",
    )
    const cbv = Buffer.from(
      initResp.callback?.callback_var || "",
      "utf8",
    ).toString("base64")

    const date = new Date().toUTCString()
    const contentType = "application/octet-stream"
    const ossHeaders = `x-oss-callback:${cb}\nx-oss-callback-var:${cbv}\nx-oss-security-token:${token.SecurityToken}\n`
    const canonicalResource = `/${initResp.bucket}/${initResp.object}`
    const stringToSign = `PUT\n\n${contentType}\n${date}\n${ossHeaders}${canonicalResource}`
    const signature = await hmacSha1Base64(stringToSign, token.AccessKeySecret)

    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        Date: date,
        Authorization: `OSS ${token.AccessKeyId}:${signature}`,
        "x-oss-security-token": token.SecurityToken,
        "x-oss-callback": cb,
        "x-oss-callback-var": cbv,
        "Content-Length": String(content.length),
      },
      body: content as unknown as BodyInit,
    })
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300)
      throw new Error(`115 OSS 上傳失敗（HTTP ${res.status}）：${text}`)
    }
  }
}
