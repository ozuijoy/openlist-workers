// 123 Cloud Drive (123Pan) driver
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/123
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { Pan123Addition, Pan123File, Pan123UploadResp } from "./types"
import { Pan123Client } from "./util"

/** 分片會話上傳：會話令牌中攜帶的資料（不透明地往返於前後端） */
interface Pan123SessionData {
  bucket: string
  key: string
  uploadId: string
  fileId: number
  storageNode: string
  size: number
  partCount: number
  chunkSize: number
}

function encodeSession(s: Pan123SessionData): string {
  return Buffer.from(JSON.stringify(s), "utf8").toString("base64")
}

function decodeSession(token: string): Pan123SessionData {
  const s = JSON.parse(Buffer.from(token, "base64").toString("utf8"))
  if (!s || !s.bucket || !s.key || !s.uploadId) {
    throw new Error("[123Pan] invalid upload session")
  }
  return s as Pan123SessionData
}

function sessionToUpload(s: Pan123SessionData): Pan123UploadResp["data"] {
  return {
    AccessKeyId: "",
    SecretAccessKey: "",
    SessionToken: "",
    Bucket: s.bucket,
    Key: s.key,
    UploadId: s.uploadId,
    FileId: s.fileId,
    StorageNode: s.storageNode,
    EndPoint: "",
    Reuse: false,
  }
}

function pan123FileToFileItem(f: Pan123File): FileItem {
  const isDir = f.Type === 1
  return {
    name: f.FileName,
    size: f.Size || 0,
    is_dir: isDir,
    modified: f.UpdateAt
      ? new Date(f.UpdateAt).toISOString()
      : new Date().toISOString(),
    sign: String(f.FileId),
    type: calcFileType(f.FileName, isDir),
    thumb: "",
    raw_url: "",
  }
}

export class Pan123Driver implements StorageDriver {
  private client: Pan123Client
  private addition: Pan123Addition
  /** cache: physical path → folder FileId (string) */
  private pathIdCache = new Map<string, string>()
  /**
   * Cloudflare Workers subrequest 預算（免費版單次 invocation 最多 50 個子請求）。
   * 所有分頁/路徑解析調用共享該預算；超出時截斷並告警，避免
   * "Too many subrequests by single Worker invocation" 錯誤。
   */
  private budget = { used: 0, limit: 45 }

  constructor(
    addition: Pan123Addition,
    onTokenUpdate?: (token: string) => void,
  ) {
    // 官方驅動方式：必填 123 網盤手機號 + 密碼登入（無默認令牌）。
    // access_token 為登入後自動持久化的會話令牌（可選，用戶無需手動填寫）。
    this.addition = addition
    this.client = new Pan123Client(addition, onTokenUpdate)
  }

  async init(): Promise<void> {
    await this.client.login()
  }

  /**
   * Resolve a physical path ("0/a/b") to the FileId of its last folder.
   * Walks the tree from the root id, listing each level to find the
   * folder by name, caching results. Each level consumes at most one
   * page of subrequests (findName early-termination).
   */
  private async resolveFolderId(physicalPath: string): Promise<string> {
    const rootId = this.client.getRootId()
    const clean =
      "/" +
      String(physicalPath || "")
        .split("/")
        .filter(Boolean)
        .join("/")
    if (clean === "/" || clean === `/${rootId}`) {
      return rootId
    }

    // Find the longest cached prefix
    const segs = clean.split("/").filter(Boolean)
    let cachedLen = 0
    let parentId = rootId
    let prefix = ""
    for (let i = 0; i < segs.length; i++) {
      const p = "/" + segs.slice(0, i + 1).join("/")
      const id = this.pathIdCache.get(p)
      if (id !== undefined) {
        parentId = id
        cachedLen = i + 1
        prefix = p
      } else {
        break
      }
    }

    for (let i = cachedLen; i < segs.length; i++) {
      const rawName = segs[i]
      const decodedName = (() => {
        try {
          return decodeURIComponent(rawName)
        } catch {
          return rawName
        }
      })()

      const files = await this.client.getFiles(parentId, {
        findName: decodedName,
        findIsDir: true,
        budget: this.budget,
      })
      const folder = files.find(
        (f) =>
          f.Type === 1 &&
          (f.FileName === rawName ||
            f.FileName === decodedName ||
            String(f.FileId) === rawName ||
            String(f.FileId) === decodedName),
      )
      if (!folder) {
        throw new Error(`folder not found: ${rawName}`)
      }
      parentId = String(folder.FileId)
      prefix = "/" + segs.slice(0, i + 1).join("/")
      this.pathIdCache.set(prefix, parentId)
    }
    return parentId
  }

  /**
   * 上傳場景：確保目錄存在，缺失的層級自動遞歸創建。
   * 與 resolveFolderId 的區別是——目錄不存在時不拋 "folder not found"，
   * 而是調用 mkdir 創建。用於上傳文件夾 / 上傳到尚不存在的子目錄。
   */
  private async ensureFolderId(physicalPath: string): Promise<string> {
    const rootId = this.client.getRootId()
    const clean =
      "/" +
      String(physicalPath || "")
        .split("/")
        .filter(Boolean)
        .join("/")
    if (clean === "/" || clean === `/${rootId}`) {
      return rootId
    }

    const segs = clean.split("/").filter(Boolean)
    let parentId = rootId
    let prefix = ""
    for (let i = 0; i < segs.length; i++) {
      const rawName = segs[i]
      const decodedName = (() => {
        try {
          return decodeURIComponent(rawName)
        } catch {
          return rawName
        }
      })()
      prefix = "/" + segs.slice(0, i + 1).join("/")

      let id = this.pathIdCache.get(prefix)
      if (id === undefined) {
        let files = await this.client.getFiles(parentId, {
          findName: decodedName,
          findIsDir: true,
          budget: this.budget,
        })
        let folder = files.find(
          (f) =>
            f.Type === 1 &&
            (f.FileName === rawName || f.FileName === decodedName),
        )
        if (folder) {
          id = String(folder.FileId)
        } else {
          // 目錄不存在：創建。併發上傳多個文件時可能被別的請求搶先創建，
          // mkdir 報"已存在"則忽略，隨後重新查詢拿到 FileId。
          try {
            const createdId = await this.client.mkdir(parentId, decodedName)
            if (createdId) {
              id = createdId
            }
          } catch {
            // ignore: directory may already exist
          }
          if (id === undefined) {
            files = await this.client.getFiles(parentId, {
              findName: decodedName,
              findIsDir: true,
              budget: this.budget,
            })
            folder = files.find(
              (f) => f.Type === 1 && f.FileName === decodedName,
            )
            if (!folder) {
              throw new Error(`[123Pan] 自動創建目錄失敗: ${rawName}`)
            }
            id = String(folder.FileId)
          }
        }
        this.pathIdCache.set(prefix, id)
      }
      parentId = id
    }
    return parentId
  }

  /**
   * Resolve a physical path to a file: parent folder id + matching file.
   * physicalPath segments: rootId/name1/name2/.../targetName
   */
  private async resolveFile(physicalPath: string): Promise<{
    file: Pan123File
    parentId: string
    name: string
  }> {
    const segs = String(physicalPath || "")
      .split("/")
      .filter(Boolean)
    if (segs.length === 0) throw new Error("invalid path")
    const rawName = segs[segs.length - 1]
    const decodedName = (() => {
      try {
        return decodeURIComponent(rawName)
      } catch {
        return rawName
      }
    })()
    const parentPath = "/" + segs.slice(0, segs.length - 1).join("/")
    const parentId = await this.resolveFolderId(parentPath)
    const files = await this.client.getFiles(parentId, {
      findName: decodedName,
      budget: this.budget,
    })
    const file = files.find(
      (f) =>
        String(f.FileId) === rawName ||
        String(f.FileId) === decodedName ||
        f.FileName === rawName ||
        f.FileName === decodedName,
    )
    if (!file) throw new Error(`file not found: ${rawName}`)
    return { file, parentId, name: rawName }
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    // 每次外部調用重置 subrequest 預算（45 頁上限，低於 CF 50 次限制）
    this.budget.used = 0
    const folderId = await this.resolveFolderId(physicalPath)
    const files = await this.client.getFiles(folderId, { budget: this.budget })
    const items = files.map(pan123FileToFileItem)
    return sortFileItems(
      items,
      this.addition.order_by || "file_name",
      this.addition.order_direction,
    )
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    // 每次外部調用重置 subrequest 預算
    this.budget.used = 0
    const segs = String(physicalPath || "")
      .split("/")
      .filter(Boolean)
    // Storage root → folder
    if (
      segs.length === 0 ||
      segs[segs.length - 1] === this.client.getRootId()
    ) {
      const rootId = this.client.getRootId()
      return {
        name: rootId,
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: rootId,
        type: 1,
        raw_url: "",
      }
    }

    const { file } = await this.resolveFile(physicalPath)
    const item = pan123FileToFileItem(file)
    if (file.Type !== 1) {
      try {
        item.raw_url = await this.client.getDownloadLink(file)
        if (!item.raw_url) {
          item.raw_url_error =
            "123 網盤未返回下載鏈接（DownloadUrl 為空）。常見原因：access_token/cookie 失效，或該文件已刪除/被限制下載。請到管理後台更新 access_token 後重試。"
        }
      } catch (e: any) {
        item.raw_url_error =
          `123 網盤獲取下載鏈接失敗：${e?.message || String(e)}。` +
          (String(e?.message || "").includes("登入失敗")
            ? "當前部署出口 IP 可能被 123 風控，請配置有效的 access_token（瀏覽器登入 123 網盤後複製 Bearer 令牌）。"
            : "請檢查 access_token/cookie 是否有效，或在 123 網盤網頁端確認該文件可下載。")
        console.warn(
          `[123Pan] getDownloadLink warning for ${file.FileName}:`,
          e.message,
        )
      }
    } else {
      item.raw_url_error = "該條目是文件夾，不可作為文件下載。"
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
    await this.client.mkdir(parentId, dirName)
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    this.budget.used = 0
    const { file } = await this.resolveFile(physicalPath)
    await this.client.rename(String(file.FileId), newName)
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    this.budget.used = 0
    const { file } = await this.resolveFile(physicalPath)
    await this.client.remove(String(file.FileId), file)
  }

  async move(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhysical: string,
    _dstPhysical: string,
  ): Promise<void> {
    this.budget.used = 0
    const { file } = await this.resolveFile(srcPhysical)
    const dstParts = String(dstDir).split("/").filter(Boolean)
    const targetParentId = await this.resolveFolderId("/" + dstParts.join("/"))
    await this.client.move([String(file.FileId)], targetParentId)
  }

  async copy(): Promise<void> {
    throw new Error("[123Pan] Copy is not supported by 123 Cloud Drive API")
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    this.budget.used = 0
    const segs = String(physicalPath || "")
      .split("/")
      .filter(Boolean)
    if (segs.length === 0) throw new Error("invalid upload path")
    const rawName = segs[segs.length - 1]
    const decodedName = (() => {
      try {
        return decodeURIComponent(rawName)
      } catch {
        return rawName
      }
    })()
    const parentPath = "/" + segs.slice(0, segs.length - 1).join("/")
    const parentId = await this.ensureFolderId(parentPath)
    await this.client.uploadFile(parentId, decodedName, content)
  }

  // ---- 分片會話上傳（解決大文件整體緩衝導致的記憶體/請求體超限卡死）----

  /**
   * 創建分片上傳會話。前端逐片上傳，每片獨立 HTTP 請求：
   * Worker 記憶體佔用恆定（單片大小），不受 CF 請求體/記憶體上限約束，
   * 且瀏覽器端能看到每片的真實上傳進度。
   * @param physicalDir 目標目錄的物理路徑（不含文件名）
   * @param fileName 文件名
   * @param size 文件總字節數
   * @param md5 文件 MD5（啟用秒傳時由前端計算；可為空）
   */
  async createUploadSession(
    _virtualDir: string,
    physicalDir: string,
    fileName: string,
    size: number,
    md5: string,
  ): Promise<{
    reuse: boolean
    partCount: number
    chunkSize: number
    session: string
  }> {
    this.budget.used = 0
    const parentId = await this.ensureFolderId(physicalDir || "/")
    const upload = await this.client.createUpload(
      fileName,
      parentId,
      size,
      md5 || "",
    )
    const chunkSize = 16 * 1024 * 1024 // 16MB
    // 秒傳命中或未分配 Key：文件已存在，無需實際上傳
    if (upload.Reuse || upload.Key === "") {
      return { reuse: true, partCount: 0, chunkSize, session: "" }
    }
    const partCount = Math.max(1, Math.ceil(size / chunkSize))
    const session = encodeSession({
      bucket: upload.Bucket,
      key: upload.Key,
      uploadId: upload.UploadId,
      fileId: upload.FileId,
      storageNode: upload.StorageNode,
      size,
      partCount,
      chunkSize,
    })
    return { reuse: false, partCount, chunkSize, session }
  }

  /**
   * 上傳單個分片：獲取該片的預簽名 URL 並把內容轉發給 123pan。
   */
  async uploadPart(
    session: string,
    partNumber: number,
    content: Buffer,
  ): Promise<void> {
    this.budget.used = 0
    const s = decodeSession(session)
    const url = await this.client.getPartUploadUrl(
      sessionToUpload(s),
      partNumber,
      s.partCount,
    )
    const res = await fetch(url, { method: "PUT", body: content as any })
    if (res.status !== 200) {
      const text = await res.text().catch(() => "")
      throw new Error(
        `[123Pan] 上傳第 ${partNumber}/${s.partCount} 分片失敗：HTTP ${res.status} ${text}`,
      )
    }
  }

  /**
   * 完成分片上傳會話。
   */
  async completeUploadSession(session: string): Promise<void> {
    this.budget.used = 0
    const s = decodeSession(session)
    await this.client.completeUpload(
      sessionToUpload(s),
      s.size,
      s.partCount > 1,
    )
  }
}
