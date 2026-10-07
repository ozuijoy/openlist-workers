import { Hono } from "hono"
import {
  flushPendingDriverState,
  listItems,
  getItem,
  makeDirectory,
  renameItem,
  removeItems,
  moveItems,
  copyItems,
  putItem,
  getDriver,
} from "../internal/op/storage"
import { resolveShare } from "../internal/op/share"
import { resolvePath } from "../internal/model/db"
import { getUserFromContext } from "./middlewares"
import { canWrite, getActualPath, isAdmin } from "../pkg/permission"
import {
  getNearestMeta,
  canAccess,
  getReadme,
  getHeader,
  canWriteContentBypassUserPerms,
  isHidden,
  canWrite as canWriteMeta,
} from "../pkg/meta"
import type { Meta } from "../pkg/meta"
import {
  getSignPolicy,
  signDownloadPath,
  isEncryptPath,
  getSignExpiresIn,
} from "../pkg/sign"
import { safeErrorMessage } from "../pkg/errs"
import { encodeDownloadPath } from "../pkg/path"
import { search } from "../internal/op/search"
import {
  getDisableIndex,
  resolveCacheExpiration,
} from "../internal/driver/storageopts"
import { parseZip, extractZipEntry, ZipArchive } from "../internal/archive/zip"
import { assertSafeUrl, getTrustedHosts } from "../pkg/http"
import { seedRouter } from "./seed"

/**
 * 該路徑所屬儲存是否禁止目錄列表（對齊 Go handles.FsList 的 DisableIndex 判斷）。
 * 儲存無法解析時返回 false，避免誤傷虛擬目錄。
 */
async function isStorageIndexDisabled(reqPath: string): Promise<boolean> {
  try {
    const resolved = await resolvePath(reqPath)
    if (!resolved?.storage) return false
    return getDisableIndex(resolved.storage)
  } catch {
    return false
  }
}
import {
  clampChunkSize,
  deleteSession,
  findReceivingSession,
  getSession,
  MultipartSession,
  newUploadId,
  pruneSessions,
  putSession,
  snapshot as mpSnapshot,
} from "../internal/upload/multipart"

export const fsRouter = new Hono()
fsRouter.route("/seed", seedRouter)

const getStorageRequestContext = (c: any) => {
  try {
    const executionCtx = c.executionCtx
    if (!executionCtx || typeof executionCtx.waitUntil !== "function") {
      return undefined
    }
    return {
      waitUntil: (promise: Promise<unknown>) => executionCtx.waitUntil(promise),
      env: c.env, // 傳遞 env 用於請求級 KV 快取複用
    }
  } catch {
    return undefined
  }
}

// ---- 寫操作權限校驗 ----
// 遊客（未登入 / 無憑證 / token 無效）一律 403，普通用戶需具備
// WRITE_CONTENT 權限位，管理員放行。修復「任何人可匿名上傳/刪除文件」
// 的安全漏洞，同時讓 /fs/list 的 write 欄位如實反映請求者身份。
const permissionDenied = (c: any) =>
  c.json({ code: 403, message: "Permission denied", data: null }, 403)

// ---- 上傳大小限制（M-5：防止超大請求體被整體讀入記憶體導致 Worker OOM）----
// 單次整體上傳（/put /form）與分片單片（/upload/part）分開設限，
// 均可通過環境變量 MAX_UPLOAD / MAX_UPPART 覆蓋。
const DEFAULT_MAX_UPLOAD = 25 * 1024 * 1024 // 25MB
const DEFAULT_MAX_UPPART = 16 * 1024 * 1024 // 16MB

function getUploadSizeLimit(c: any, part: boolean): number {
  const env = c.env || {}
  const key = part ? "MAX_UPPART" : "MAX_UPLOAD"
  const raw =
    env[key] || (typeof process !== "undefined" ? process.env?.[key] : "")
  if (raw) {
    const n = parseInt(String(raw), 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return part ? DEFAULT_MAX_UPPART : DEFAULT_MAX_UPLOAD
}

/** 返回超限時的上限字節數；未超限或無法判斷（無 Content-Length）返回 null */
function exceedsUploadLimit(c: any, part = false): number | null {
  const contentLength = parseInt(c.req.header("Content-Length") || "0", 10)
  if (!contentLength) return null
  const max = getUploadSizeLimit(c, part)
  return contentLength > max ? max : null
}

// 分享請求錯誤統一出口：
// - 密碼錯誤 → 403，前端據此彈出提取碼輸入框（State.NeedPassword）
// - 其他（不存在/禁用/過期/超次數/為空）→ 400，前端顯示友好提示
const shareErrorResponse = (c: any, error?: string) => {
  const isWrongPassword = error === "wrong password"
  const msg = error || "share error"
  return c.json(
    {
      code: isWrongPassword ? 403 : 400,
      message: msg,
      data: null,
    },
    isWrongPassword ? 403 : 400,
  )
}

// GET sub-directories of a path (used by FolderTree in metas/storages editors)
fsRouter.post("/dirs", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const user = await getUserFromContext(c)
  const rawPath = body.path || "/"
  const isShare = rawPath.startsWith("/@s")
  if (!isShare && (!user || user.disabled)) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const requestContext = getStorageRequestContext(c)
  let reqPath = rawPath
  if (!body.force_root || !isAdmin(user)) {
    reqPath = getActualPath(user, reqPath)
  }
  try {
    // Share path support for completeness
    if (reqPath.startsWith("/@s")) {
      const shareRes = await resolveShare(reqPath, body.password || "", c.env)
      if (!shareRes.ok) {
        return shareErrorResponse(c, shareRes.error)
      }
      if (shareRes.virtualList) {
        const dirs = []
        for (const f of shareRes.share.files || []) {
          try {
            const { item } = await getItem(f, requestContext)
            if (item.is_dir) {
              const segs = String(f).split("/").filter(Boolean)
              dirs.push({
                name: segs[segs.length - 1] || f,
                modified: item.modified || new Date().toISOString(),
              })
            }
          } catch {
            // skip unlistable share items
          }
        }
        return c.json({ code: 200, message: "success", data: dirs })
      }
      const { content } = await listItems(shareRes.realPath!, requestContext)
      const dirs = content
        .filter((item: any) => item.is_dir)
        .map((item: any) => ({
          name: item.name,
          modified: item.modified || new Date().toISOString(),
        }))
      return c.json({ code: 200, message: "success", data: dirs })
    }

    const { content } = await listItems(reqPath, requestContext)
    const dirs = content
      .filter((item: any) => item.is_dir)
      .map((item: any) => ({
        name: item.name,
        modified: item.modified || new Date().toISOString(),
      }))
    return c.json({ code: 200, message: "success", data: dirs })
  } catch (err: any) {
    return c.json({ code: 500, message: safeErrorMessage(err), data: null })
  }
})

fsRouter.post("/list", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const user = await getUserFromContext(c)
  const isShare = (body.path || "/").startsWith("/@s")
  if (!isShare && (!user || user.disabled)) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const requestContext = getStorageRequestContext(c)
  const reqPath = getActualPath(user, body.path || "/")
  const page = parseInt(body.page, 10) || 1
  const perPage = parseInt(body.per_page, 10) || 0

  const paginateItems = <T>(items: T[]) => {
    const total = items.length
    if (perPage <= 0) {
      return { content: items, total }
    }
    const pageNum = Math.max(1, page)
    const start = (pageNum - 1) * perPage
    const end = start + perPage
    return {
      content: items.slice(start, end),
      total,
    }
  }

  try {
    // Share path: /@s/{shareId}/...
    if (reqPath.startsWith("/@s")) {
      const shareRes = await resolveShare(reqPath, body.password || "", c.env)
      if (!shareRes.ok) {
        return shareErrorResponse(c, shareRes.error)
      }

      // Multi-file share root → virtual list of the shared items
      if (shareRes.virtualList) {
        const items = []
        for (const f of shareRes.share.files || []) {
          const segs = String(f).split("/").filter(Boolean)
          const name = segs[segs.length - 1] || f
          try {
            const { item } = await getItem(f, requestContext)
            items.push({
              name,
              size: item.size || 0,
              is_dir: !!item.is_dir,
              modified: item.modified || new Date().toISOString(),
              sign: "",
              thumb: item.thumb || "",
              type: item.type ?? 0,
            })
          } catch {
            // If getItem failed, probe by listing — a listable path is a folder
            try {
              await listItems(f, requestContext)
              items.push({
                name,
                size: 0,
                is_dir: true,
                modified: new Date().toISOString(),
                sign: "",
                thumb: "",
                type: 1,
              })
            } catch {
              items.push({
                name,
                size: 0,
                is_dir: false,
                modified: new Date().toISOString(),
                sign: "",
                thumb: "",
                type: 0,
              })
            }
          }
        }
        const { content, total } = paginateItems(items)
        return c.json({
          code: 200,
          message: "success",
          data: {
            content,
            total,
            readme: shareRes.share.readme || "",
            header: shareRes.share.header || "",
            write: false,
            write_content_bypass: false,
            provider: "Share",
          },
        })
      }

      // Mapped to a real path — fall through to normal listing
      const { content, provider } = await listItems(
        shareRes.realPath!,
        requestContext,
      )
      const normalized = content.map((item: any) => ({
        name: item.name,
        size: item.size,
        is_dir: item.is_dir,
        created: item.created || item.modified || new Date().toISOString(),
        modified: item.modified || new Date().toISOString(),
        sign: item.sign || "",
        thumb: item.thumb || "",
        type: item.type ?? 0,
      }))
      const { content: pagedContent, total } = paginateItems(normalized)
      return c.json({
        code: 200,
        message: "success",
        data: {
          content: pagedContent,
          total,
          readme: shareRes.share.readme || "",
          header: shareRes.share.header || "",
          write: false,
          write_content_bypass: false,
          provider,
        },
      })
    }

    // 普通路徑：應用 meta 權限（密碼 + read_users + readme/header + hide 過濾）
    const meta = await getNearestMeta(reqPath, c.env)
    if (!canAccess(user, meta, reqPath, body.password || "")) {
      return c.json(
        { code: 403, message: "Access denied (wrong password or not in read_users)", data: null },
        403,
      )
    }

    // disable_index（對齊 Go handles.FsList）：該儲存禁止目錄列表時，
    // 即使有讀權限也不返回內容，避免分享單文件後被逐級瀏覽整個儲存。
    if (await isStorageIndexDisabled(reqPath)) {
      return c.json(
        { code: 403, message: "Index is disabled for this storage", data: null },
        403,
      )
    }

    const { content, provider, storage } = await listItems(
      reqPath,
      requestContext,
    )
    // write：用戶寫權限 + meta.write_users 白名單（對齊 Go common.CanWrite）
    const writable = canWrite(user) && canWriteMeta(user, meta, reqPath)
    const writeContentBypass = canWriteContentBypassUserPerms(meta, reqPath)
    // 下載簽名（對齊 Go server/common.Sign + handles.isEncrypt）：
    //   目錄不簽名；sign_all（或 TS 擴展的 link_expiration）開啟、
    //   或該目錄被設了密碼的 meta 覆蓋時，為文件項簽發 HMAC 簽名。
    // 必須與 raw.ts 的 needDownloadSign 保持對稱，否則直鏈會驗籤失敗。
    // 注意：不能回退 item.sign —— sign 由本層統一簽發，驅動不參與
    //（歷史上 webdav/autoindex 驅動曾把遠程路徑/URL 塞進該欄位）。
    const signPolicy = await getSignPolicy(c)
    const encrypt = await isEncryptPath(c, reqPath)
    const signNeeded = signPolicy.enabled || encrypt
    const signExpiresIn = signNeeded
      ? signPolicy.expiresIn || (await getSignExpiresIn(c))
      : 0
    // Normalize each item to the full Obj shape expected by the frontend
    const normalized = await Promise.all(
      content
        .filter((item: any) => !isHidden(meta, reqPath, item.name))
        .map(async (item: any) => {
          const fullPath = `${reqPath}/${item.name}`.replace(/\/{2,}/g, "/")
          const sign =
            !item.is_dir && signNeeded
              ? await signDownloadPath(c, fullPath, signExpiresIn)
              : ""
          // hashinfo / hash_info：從驅動透傳哈希信息（Go ObjResp 欄位）
          // 驅動不支持時為空字符串/空對象，保持與 Go 響應結構相容
          const hashInfoStr: string = (item as any).hashinfo || (item as any).hash_info_str || ""
          const hashInfo: Record<string, string> = (item as any).hash_info || {}
          return {
            name: item.name,
            size: item.size,
            is_dir: item.is_dir,
            created: item.created || item.modified || new Date().toISOString(),
            modified: item.modified || new Date().toISOString(),
            sign,
            thumb: item.thumb || "",
            type: item.type ?? 0,
            hashinfo: hashInfoStr,
            hash_info: hashInfo,
          }
        }),
    )

    let storagePageSize = 0
    if (storage) {
      storagePageSize = parseInt(storage.page_size, 10) || 0
      if (!storagePageSize && storage.addition) {
        try {
          const addition =
            typeof storage.addition === "string"
              ? JSON.parse(storage.addition)
              : storage.addition
          storagePageSize = parseInt(addition?.page_size, 10) || 0
        } catch {}
      }
    }

    const effectivePerPage =
      perPage > 0 ? perPage : storagePageSize > 0 ? storagePageSize : 0
    const paginateStorageItems = <T>(items: T[]) => {
      const total = items.length
      if (effectivePerPage <= 0) {
        return { content: items, total }
      }
      const pageNum = Math.max(1, page)
      const start = (pageNum - 1) * effectivePerPage
      const end = start + effectivePerPage
      return {
        content: items.slice(start, end),
        total,
      }
    }

    // direct_upload_tools：從 storage 透傳支持的直傳工具列表（對齊 Go FsListResp）
    // storage 不支持時為空數組，保持與 Go 響應結構相容
    const directUploadTools: string[] = (() => {
      if (!storage) return []
      const tools: string[] = []
      const driver = (storage as any)
      // S3 系列驅動支持 s3_presigned 直傳
      if (/^(s3|minio|cos|oss|r2|b2|cloudflare_r2)/i.test(driver.driver || "")) {
        tools.push("s3_presigned")
      }
      // 驅動自聲明的 direct_upload_tools 欄位（驅動擴展點）
      if (Array.isArray(driver.direct_upload_tools)) {
        for (const t of driver.direct_upload_tools) {
          if (!tools.includes(t)) tools.push(t)
        }
      }
      return tools
    })()

    const { content: pagedContent, total } = paginateStorageItems(normalized)
    // cache_expiration：由 custom_cache_policies 按路徑覆蓋後得出（分鐘）。
    // 對齊 Go 的路徑級快取策略；前端/上層可據此決定該目錄的列表快取時長。
    const cacheExpiration = storage
      ? resolveCacheExpiration(storage, reqPath)
      : undefined
    return c.json({
      code: 200,
      message: "success",
      data: {
        content: pagedContent,
        total,
        readme: getReadme(meta, reqPath),
        header: getHeader(meta, reqPath),
        write: writable,
        write_content_bypass: writeContentBypass,
        provider,
        direct_upload_tools: directUploadTools,
        page_size: effectivePerPage > 0 ? effectivePerPage : undefined,
        cache_expiration: cacheExpiration,
      },
    })
  } catch (err: any) {
    return c.json({ code: 500, message: safeErrorMessage(err), data: null })
  }
})

fsRouter.post("/get", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const user = await getUserFromContext(c)
  const isShare = (body.path || "/").startsWith("/@s")
  if (!isShare && (!user || user.disabled)) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const requestContext = getStorageRequestContext(c)
  const reqPath = getActualPath(user, body.path || "/")
  try {
    // Share path: /@s/{shareId}/...
    if (reqPath.startsWith("/@s")) {
      const shareRes = await resolveShare(reqPath, body.password || "", c.env)
      if (!shareRes.ok) {
        return shareErrorResponse(c, shareRes.error)
      }

      // Multi-file share root: report as a virtual folder so the frontend lists it
      if (shareRes.virtualList) {
        const shareId = reqPath.split("/").filter(Boolean)[1] || "share"
        return c.json({
          code: 200,
          message: "success",
          data: {
            name: shareId,
            size: 0,
            is_dir: true,
            modified: new Date().toISOString(),
            sign: "",
            thumb: "",
            type: 1,
            raw_url: "",
            readme: shareRes.share.readme || "",
            header: shareRes.share.header || "",
            provider: "Share",
            related: [],
            write: false,
            write_content_bypass: false,
          },
        })
      }

      // Mapped to a real path — get with share-aware raw_url (/sd/{shareId}...)
      const shareId = reqPath.split("/").filter(Boolean)[1] || ""
      const { item, provider } = await getItem(
        shareRes.realPath!,
        requestContext,
      )
      const subPath = reqPath.replace(/^\/@s\/[^/]+/, "")
      return c.json({
        code: 200,
        message: "success",
        data: {
          name: item.name,
          size: item.size,
          is_dir: item.is_dir,
          created:
            (item as any).created || item.modified || new Date().toISOString(),
          modified: item.modified,
          sign: item.sign || "",
          thumb: (item as any).thumb || "",
          type: item.type ?? 0,
          raw_url: `/api/sd/${shareId}${subPath}`,
          readme: shareRes.share.readme || "",
          header: shareRes.share.header || "",
          provider,
          related: [],
          write: false,
          write_content_bypass: false,
        },
      })
    }

    // 普通路徑：應用 meta 權限（密碼 + read_users + readme/header）
    const meta = await getNearestMeta(reqPath, c.env)
    if (!canAccess(user, meta, reqPath, body.password || "")) {
      return c.json(
        { code: 403, message: "Access denied (wrong password or not in read_users)", data: null },
        403,
      )
    }

    const { item, provider, rawUrl } = await getItem(reqPath, requestContext)
    // 與 /fs/list 同源邏輯，見上方註釋
    const signPolicy = await getSignPolicy(c)
    const signNeeded = signPolicy.enabled || (await isEncryptPath(c, reqPath))
    const sign =
      !item.is_dir && signNeeded
        ? await signDownloadPath(
            c,
            reqPath,
            signPolicy.expiresIn || (await getSignExpiresIn(c)),
          )
        : ""
    // raw_url 必須自帶簽名（Issue #66）。
    //
    // 前端把本介面的 raw_url 直接當下載地址使用：預覽頁的「下載」按鈕就是
    // <a href={raw_url}>（pages/home/previews/download.tsx），圖片/視頻預覽也
    // 直接把它塞進 <img>/<video> 的 src，都不會再自己拼 ?sign=。而 raw_url
    // 指向的是需要驗籤的 /p 或 /d 端點（前綴由 getItem 按 canProxy() 選定）：
    // sign_all、儲存級 enable_sign、密碼 meta 覆蓋任一命中時，缺簽名一律
    // 401 "sign verify failed"——外部表現就是「預覽頁能正常打開，一點下載就 401」。
    //
    // 對齊 Go server/handles/fsread.go FsGet：
    //   if isEncrypt(meta, reqPath) || setting.GetBool(conf.SignAll) {
    //       query = "?sign=" + sign.Sign(reqPath)
    //   }
    //   rawURL = fmt.Sprintf("%s/p%s%s", common.GetApiUrl(c), ..., query)
    const rawUrlWithSign =
      sign && rawUrl && !/[?&]sign=/.test(rawUrl)
        ? `${rawUrl}${rawUrl.includes("?") ? "&" : "?"}sign=${sign}`
        : rawUrl
    const writable = canWrite(user) && canWriteMeta(user, meta, reqPath)
    const writeContentBypass = canWriteContentBypassUserPerms(meta, reqPath)

    // Related：查找同目錄中文件名前綴相同的文件（字幕 .srt/.ass/.vtt、NFO 等）
    // 對齊 Go server/handles/fsread.go getRelated 邏輯：
    //   stem = 去掉最後一個擴展名的文件名；related = 同目錄中 stem 相同的其他文件
    let related: any[] = []
    if (!item.is_dir) {
      try {
        const parentPath = reqPath.includes("/")
          ? reqPath.slice(0, reqPath.lastIndexOf("/")) || "/"
          : "/"
        const stem = item.name.includes(".")
          ? item.name.slice(0, item.name.lastIndexOf("."))
          : item.name
        const { content: siblings } = await listItems(parentPath, requestContext)
        related = siblings
          .filter((s: any) => {
            if (s.name === item.name || s.is_dir) return false
            const sStem = s.name.includes(".")
              ? s.name.slice(0, s.name.lastIndexOf("."))
              : s.name
            return sStem === stem
          })
          .map((s: any) => ({
            name: s.name,
            size: s.size,
            is_dir: false,
            modified: s.modified || new Date().toISOString(),
            sign: "",
            thumb: (s as any).thumb || "",
            type: s.type ?? 0,
          }))
      } catch {
        // 獲取關聯文件失敗不影響主文件響應
        related = []
      }
    }

    return c.json({
      code: 200,
      message: "success",
      data: {
        name: item.name,
        size: item.size,
        is_dir: item.is_dir,
        created:
          (item as any).created || item.modified || new Date().toISOString(),
        modified: item.modified,
        sign,
        thumb: (item as any).thumb || "",
        type: item.type ?? 0,
        raw_url: rawUrlWithSign,
        readme: getReadme(meta, reqPath),
        header: getHeader(meta, reqPath),
        provider,
        related,
        write: writable,
        write_content_bypass: writeContentBypass,
      },
    })
  } catch (err: any) {
    return c.json({ code: 500, message: safeErrorMessage(err), data: null })
  }
})

function validateFileName(name: any): string {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("Invalid or empty file name")
  }
  const clean = name.trim()
  if (
    clean === "." ||
    clean === ".." ||
    clean.includes("/") ||
    clean.includes("\\") ||
    clean.includes("\0")
  ) {
    throw new Error(`Illegal file name '${clean}'`)
  }
  return clean
}

function validateDirPath(p: any): string {
  if (typeof p !== "string") {
    throw new Error("Path must be a string")
  }
  if (p.includes("\0")) {
    throw new Error("Path contains illegal null byte")
  }
  return p
}

fsRouter.post("/mkdir", async (c) => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return permissionDenied(c)
  const body = await c.req.json().catch(() => ({}))
  const rawPath = body.path || "/"
  try {
    validateDirPath(rawPath)
  } catch (e: any) {
    return c.json({ code: 400, message: e.message, data: null }, 400)
  }
  const reqPath = getActualPath(user, rawPath)
  const requestContext = getStorageRequestContext(c)
  try {
    await makeDirectory(reqPath, requestContext)
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null })
  }
})

fsRouter.post("/rename", async (c) => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return permissionDenied(c)
  const { path: oldPath, name: newName } = await c.req.json().catch(() => ({}))
  let cleanName = ""
  try {
    validateDirPath(oldPath || "/")
    cleanName = validateFileName(newName)
  } catch (e: any) {
    return c.json({ code: 400, message: e.message, data: null }, 400)
  }
  const requestContext = getStorageRequestContext(c)
  try {
    const actualOldPath = getActualPath(user, oldPath || "/")
    await renameItem(actualOldPath, cleanName, requestContext)
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null })
  }
})

fsRouter.post("/remove", async (c) => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return permissionDenied(c)
  const { dir, names } = await c.req.json().catch(() => ({}))
  if (!Array.isArray(names) || names.length === 0) {
    return c.json(
      {
        code: 400,
        message: "Parameter 'names' must be a non-empty array",
        data: null,
      },
      400,
    )
  }
  let cleanNames: string[] = []
  try {
    validateDirPath(dir || "/")
    cleanNames = names.map((n: string) => validateFileName(n))
  } catch (e: any) {
    return c.json({ code: 400, message: e.message, data: null }, 400)
  }
  const requestContext = getStorageRequestContext(c)
  try {
    const actualDir = getActualPath(user, dir || "/")
    await removeItems(actualDir, cleanNames, requestContext)
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null })
  }
})

fsRouter.post("/move", async (c) => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return permissionDenied(c)
  const { src_dir, dst_dir, names } = await c.req.json().catch(() => ({}))
  if (!Array.isArray(names) || names.length === 0) {
    return c.json(
      {
        code: 400,
        message: "Parameter 'names' must be a non-empty array",
        data: null,
      },
      400,
    )
  }
  let cleanNames: string[] = []
  try {
    validateDirPath(src_dir || "/")
    validateDirPath(dst_dir || "/")
    cleanNames = names.map((n: string) => validateFileName(n))
  } catch (e: any) {
    return c.json({ code: 400, message: e.message, data: null }, 400)
  }
  const requestContext = getStorageRequestContext(c)
  try {
    const actualSrcDir = getActualPath(user, src_dir || "/")
    const actualDstDir = getActualPath(user, dst_dir || "/")
    await moveItems(actualSrcDir, actualDstDir, cleanNames, requestContext)
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null })
  }
})

fsRouter.post("/copy", async (c) => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return permissionDenied(c)
  const { src_dir, dst_dir, names } = await c.req.json().catch(() => ({}))
  if (!Array.isArray(names) || names.length === 0) {
    return c.json(
      {
        code: 400,
        message: "Parameter 'names' must be a non-empty array",
        data: null,
      },
      400,
    )
  }
  let cleanNames: string[] = []
  try {
    validateDirPath(src_dir || "/")
    validateDirPath(dst_dir || "/")
    cleanNames = names.map((n: string) => validateFileName(n))
  } catch (e: any) {
    return c.json({ code: 400, message: e.message, data: null }, 400)
  }
  const requestContext = getStorageRequestContext(c)
  try {
    const actualSrcDir = getActualPath(user, src_dir || "/")
    const actualDstDir = getActualPath(user, dst_dir || "/")
    await copyItems(actualSrcDir, actualDstDir, cleanNames, requestContext)
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null })
  }
})

fsRouter.put("/put", async (c) => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return permissionDenied(c)
  const rawPath = decodeURIComponent(c.req.header("File-Path") || "")
  if (!rawPath.trim()) {
    return c.json(
      { code: 400, message: "Missing File-Path header", data: null },
      400,
    )
  }
  try {
    validateDirPath(rawPath)
  } catch (e: any) {
    return c.json({ code: 400, message: e.message, data: null }, 400)
  }
  const reqPath = getActualPath(user, rawPath)
  const requestContext = getStorageRequestContext(c)
  const tooLarge = exceedsUploadLimit(c)
  if (tooLarge !== null) {
    return c.json(
      {
        code: 413,
        message: `File too large (max ${tooLarge} bytes)`,
        data: null,
      },
      413,
    )
  }
  try {
    const buffer = await c.req.arrayBuffer()
    await putItem(reqPath, Buffer.from(buffer), requestContext)
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null })
  }
})

fsRouter.put("/form", async (c) => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return permissionDenied(c)
  const rawPath = decodeURIComponent(c.req.header("File-Path") || "")
  if (!rawPath.trim()) {
    return c.json(
      { code: 400, message: "Missing File-Path header", data: null },
      400,
    )
  }
  try {
    validateDirPath(rawPath)
  } catch (e: any) {
    return c.json({ code: 400, message: e.message, data: null }, 400)
  }
  const reqPath = getActualPath(user, rawPath)
  const requestContext = getStorageRequestContext(c)
  const tooLarge = exceedsUploadLimit(c)
  if (tooLarge !== null) {
    return c.json(
      {
        code: 413,
        message: `File too large (max ${tooLarge} bytes)`,
        data: null,
      },
      413,
    )
  }
  try {
    const form = await c.req.formData()
    const file = form.get("file")
    if (!file || typeof file === "string") {
      return c.json({
        code: 400,
        message: "missing file in form data",
        data: null,
      })
    }
    const buffer = Buffer.from(await (file as File).arrayBuffer())
    await putItem(reqPath, buffer, requestContext)
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null })
  }
})

// ---- 分片會話上傳：解決大文件整體緩衝導致的卡死/OOM ----
// 流程：POST /fs/upload/create 建會話 → PUT /fs/upload/part 逐片上傳
//      → POST /fs/upload/complete 收尾。每片是獨立 HTTP 請求，Worker
//      記憶體佔用恆定，不受 CF Workers 請求體/記憶體上限約束。

fsRouter.post("/upload/create", async (c) => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return permissionDenied(c)
  const {
    path: rawPath,
    file_name,
    size,
    md5,
  } = await c.req.json().catch(() => ({}))
  // 根目錄上傳時調用方可能傳 ""，歸一化為 "/"
  const dirPath = getActualPath(user, rawPath || "/")
  const requestContext = getStorageRequestContext(c)
  if (!file_name) {
    return c.json({
      code: 400,
      message: "path and file_name are required",
      data: null,
    })
  }
  try {
    const resolved = await resolvePath(dirPath)
    if (resolved.isVirtual) {
      throw new Error("failed get storage: storage not found")
    }
    const driver = await getDriver(resolved.storage!.driver, resolved.storage)
    if (typeof (driver as any).createUploadSession !== "function") {
      // 當前儲存不支持分片會話上傳：返回 null，前端自動回退到流式上傳
      return c.json({ code: 200, message: "success", data: null })
    }
    let info
    try {
      info = await (driver as any).createUploadSession(
        dirPath,
        resolved.physical!,
        file_name,
        Number(size) || 0,
        md5 || "",
      )
    } finally {
      await flushPendingDriverState(
        resolved.storage!.driver,
        resolved.storage,
        driver,
        requestContext,
      )
    }
    return c.json({ code: 200, message: "success", data: info })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null })
  }
})

fsRouter.put("/upload/part", async (c) => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return permissionDenied(c)
  const session = c.req.header("X-Upload-Session") || ""
  const partNumber = parseInt(c.req.header("X-Part-Number") || "0", 10)
  const rawDirPath = decodeURIComponent(c.req.header("Upload-Path") || "")
  const dirPath = getActualPath(user, rawDirPath)
  const requestContext = getStorageRequestContext(c)
  if (!session || !(partNumber >= 1) || !dirPath) {
    return c.json({
      code: 400,
      message: "missing X-Upload-Session / X-Part-Number / Upload-Path",
      data: null,
    })
  }
  const tooLarge = exceedsUploadLimit(c, true)
  if (tooLarge !== null) {
    return c.json(
      {
        code: 413,
        message: `Part too large (max ${tooLarge} bytes)`,
        data: null,
      },
      413,
    )
  }
  try {
    const resolved = await resolvePath(dirPath)
    if (resolved.isVirtual) {
      throw new Error("failed get storage: storage not found")
    }
    const driver = await getDriver(resolved.storage!.driver, resolved.storage)
    if (typeof (driver as any).uploadPart !== "function") {
      throw new Error("storage does not support chunked upload")
    }
    const buffer = Buffer.from(await c.req.arrayBuffer())
    let result
    try {
      result = await (driver as any).uploadPart(session, partNumber, buffer)
    } finally {
      await flushPendingDriverState(
        resolved.storage!.driver,
        resolved.storage,
        driver,
        requestContext,
      )
    }
    return c.json({ code: 200, message: "success", data: result ?? null })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null })
  }
})

fsRouter.post("/upload/complete", async (c) => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return permissionDenied(c)
  const {
    path: rawPath,
    session,
    partMd5s,
  } = await c.req.json().catch(() => ({}))
  // 根目錄上傳時調用方可能傳 ""，歸一化為 "/"
  const dirPath = getActualPath(user, rawPath || "/")
  const requestContext = getStorageRequestContext(c)
  if (!session) {
    return c.json({
      code: 400,
      message: "path and session are required",
      data: null,
    })
  }
  try {
    const resolved = await resolvePath(dirPath)
    if (resolved.isVirtual) {
      throw new Error("failed get storage: storage not found")
    }
    const driver = await getDriver(resolved.storage!.driver, resolved.storage)
    if (typeof (driver as any).completeUploadSession !== "function") {
      throw new Error("storage does not support chunked upload")
    }
    try {
      await (driver as any).completeUploadSession(session, partMd5s)
    } finally {
      await flushPendingDriverState(
        resolved.storage!.driver,
        resolved.storage,
        driver,
        requestContext,
      )
    }
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null })
  }
})

fsRouter.post("/add_offline_download", async (c) => {
  const user = await getUserFromContext(c)
  if (!user || user.disabled) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const { path: rawPath, urls } = await c.req.json().catch(() => ({}))
  const reqPath = getActualPath(user, rawPath || "/")
  if (!urls || urls.length === 0) {
    return c.json({ code: 400, message: "No URLs provided" })
  }

  return c.json(
    {
      code: 501,
      message:
        "capability unavailable: this runtime has no durable offline-download adapter; use /fs/seed/offline_download with an approved source and a streaming-capable target driver",
      data: { path: reqPath, accepted: 0 },
    },
    501,
  )
})

fsRouter.post("/search", async (c) => {
  const user = await getUserFromContext(c)
  if (!user || user.disabled) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const body = await c.req.json().catch(() => ({}))
  const parentPath = getActualPath(user, body.parent || "/")
  try {
    const result = await search(
      {
        parent: parentPath,
        keywords: body.keywords || "",
        scope: body.scope !== undefined ? parseInt(body.scope, 10) : 0,
        page: body.page ? parseInt(body.page, 10) : 1,
        per_page: body.per_page ? parseInt(body.per_page, 10) : 30,
      },
      c.env,
    )
    return c.json({ code: 200, message: "success", data: result })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})

fsRouter.post("/other", async (c) => {
  const user = await getUserFromContext(c)
  if (!user || user.disabled) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const body = await c.req.json().catch(() => ({}))
  const reqPath = getActualPath(user, body.path || "/")
  const method = body.method
  if (!method) {
    return c.json(
      { code: 400, message: "Missing required parameter 'method'", data: null },
      400,
    )
  }
  // FIX(H-8): `other` is a driver-specific privileged entry point. S3 uses it
  // to mint presigned direct-upload URLs (s3/driver.ts:371-378), which is a
  // write — it must obey the same gate as /fs/put. Without this, a guest could
  // obtain a direct-upload URL and bypass the upload permission check.
  if (!canWrite(user)) return permissionDenied(c)
  try {
    const resolved = await resolvePath(reqPath)
    if (resolved.isVirtual || !resolved.storage) {
      throw new Error("failed get storage: storage not found")
    }
    const driver = await getDriver(resolved.storage.driver, resolved.storage)
    if (typeof (driver as any).other === "function") {
      const data = await (driver as any).other(method, resolved.relative, body)
      return c.json({ code: 200, message: "success", data })
    }
    return c.json(
      {
        code: 500,
        message: `Driver '${resolved.storage.driver}' does not support other method '${method}'`,
        data: null,
      },
      500,
    )
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})

// ---- batch_rename / regex_rename（與 Go server/handles/fsbatch.go 對齊）----

fsRouter.post("/batch_rename", async (c) => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return permissionDenied(c)
  const { src_dir, rename_objects } = await c.req.json().catch(() => ({}))
  if (!Array.isArray(rename_objects) || rename_objects.length === 0) {
    return c.json(
      { code: 400, message: "rename_objects is required", data: null },
      400,
    )
  }
  const dirPath = getActualPath(user, src_dir || "/")
  const requestContext = getStorageRequestContext(c)
  try {
    for (const obj of rename_objects) {
      const srcName = obj?.src_name
      const newName = obj?.new_name
      if (!srcName || !newName) continue
      validateFileName(newName)
      const fullPath = `${dirPath}/${srcName}`.replace(/\/{2,}/g, "/")
      await renameItem(fullPath, newName, requestContext)
    }
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})

fsRouter.post("/regex_rename", async (c) => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return permissionDenied(c)
  const { src_dir, src_name_regex, new_name_regex } = await c.req
    .json()
    .catch(() => ({}))
  if (!src_name_regex) {
    return c.json(
      { code: 400, message: "src_name_regex is required", data: null },
      400,
    )
  }
  const dirPath = getActualPath(user, src_dir || "/")
  const requestContext = getStorageRequestContext(c)
  try {
    const srcRegex = new RegExp(src_name_regex)
    const { content } = await listItems(dirPath, requestContext)
    for (const item of content) {
      if (!item.is_dir && srcRegex.test(item.name)) {
        const newName = item.name.replace(srcRegex, new_name_regex || "")
        validateFileName(newName)
        const fullPath = `${dirPath}/${item.name}`.replace(/\/{2,}/g, "/")
        await renameItem(fullPath, newName, requestContext)
      }
    }
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})

// ---- recursive_move（與 Go FsRecursiveMove 對齊：遞歸枚舉文件後扁平移動到 dst_dir）----

fsRouter.post("/recursive_move", async (c) => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return permissionDenied(c)
  const { src_dir, dst_dir, conflict_policy } = await c.req
    .json()
    .catch(() => ({}))
  const srcPath = getActualPath(user, src_dir || "/")
  const dstPath = getActualPath(user, dst_dir || "/")
  const policy = conflict_policy || "overwrite"
  const requestContext = getStorageRequestContext(c)
  try {
    // 預取目標目錄現有文件名（用於 cancel/skip 衝突策略）
    let existing = new Set<string>()
    if (policy !== "overwrite") {
      const dst = await listItems(dstPath, requestContext)
      existing = new Set(dst.content.map((f) => f.name))
    }
    const queue: string[] = [srcPath]
    let count = 0
    while (queue.length > 0) {
      const dir = queue.shift()!
      const { content } = await listItems(dir, requestContext)
      for (const item of content) {
        if (item.is_dir) {
          queue.push(`${dir}/${item.name}`.replace(/\/{2,}/g, "/"))
        } else {
          if (existing.has(item.name)) {
            if (policy === "cancel") {
              return c.json(
                {
                  code: 403,
                  message: `file [${item.name}] exists`,
                  data: null,
                },
                403,
              )
            }
            if (policy === "skip") continue
          }
          if (policy !== "overwrite") existing.add(item.name)
          await moveItems(dir, dstPath, [item.name], requestContext)
          count++
        }
      }
    }
    return c.json({
      code: 200,
      message: `Successfully moved ${count} files`,
      data: null,
    })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})

// ---- remove_empty_directory（與 Go FsRemoveEmptyDirectory 對齊）----

fsRouter.post("/remove_empty_directory", async (c) => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return permissionDenied(c)
  const { src_dir } = await c.req.json().catch(() => ({}))
  const srcPath = getActualPath(user, src_dir || "/")
  const requestContext = getStorageRequestContext(c)
  try {
    const removeEmptyDirs = async (dir: string): Promise<void> => {
      const { content } = await listItems(dir, requestContext)
      for (const item of content) {
        if (item.is_dir) {
          await removeEmptyDirs(`${dir}/${item.name}`.replace(/\/{2,}/g, "/"))
        }
      }
      if (dir === srcPath) return // 不刪除根目錄本身
      const after = await listItems(dir, requestContext)
      if (after.content.length === 0) {
        const parent = dir.split("/").slice(0, -1).join("/") || "/"
        const name = dir.split("/").pop()!
        await removeItems(parent, [name], requestContext)
      }
    }
    await removeEmptyDirs(srcPath)
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})

// ---- link（與 Go Link 對齊，admin 權限，返回真實直鏈）----

fsRouter.post("/link", async (c) => {
  const user = await getUserFromContext(c)
  if (!isAdmin(user)) return permissionDenied(c)
  const { path } = await c.req.json().catch(() => ({}))
  const reqPath = getActualPath(user, path || "/")
  const requestContext = getStorageRequestContext(c)
  try {
    const resolved = await resolvePath(reqPath)
    if (resolved.isVirtual || !resolved.storage) {
      return c.json(
        { code: 500, message: "storage not found", data: null },
        500,
      )
    }
    const driver = await getDriver(resolved.storage.driver, resolved.storage)
    try {
      const item = await driver.get(reqPath, resolved.physical ?? "/")
      if (item && item.raw_url) {
        return c.json({
          code: 200,
          message: "success",
          data: { url: item.raw_url },
        })
      }
    } finally {
      await flushPendingDriverState(
        resolved.storage.driver,
        resolved.storage,
        driver,
        requestContext,
      )
    }
    // 無直鏈（如本地/加密驅動）：返回代理下載地址。
    //
    // 對齊 Go server/handles/fsmanage.go Link：
    //   fmt.Sprintf("%s/p%s?d&sign=%s", GetApiUrl(c), EncodePath(rawPath, true), sign.Sign(rawPath))
    // 即路徑逐段編碼 + **無條件**帶簽名（Go 不看 needSign；這裡同樣補齊，
    // 否則在 sign_all / enable_sign / 密碼 meta 生效時複製出來的鏈接必然 401）。
    // 「?d」（強制 attachment 下載）TS 側無對應語義，故不追加。
    const sign = await signDownloadPath(c, reqPath, await getSignExpiresIn(c))
    return c.json({
      code: 200,
      message: "success",
      data: {
        url: `/api/p${encodeDownloadPath(reqPath)}?sign=${encodeURIComponent(sign)}`,
      },
    })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})

// ---- get_direct_upload_info（與 Go FsGetDirectUploadInfo 對齊）----

fsRouter.post("/get_direct_upload_info", async (c) => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return permissionDenied(c)
  const { path, file_name, file_size } = await c.req.json().catch(() => ({}))
  const reqPath = getActualPath(user, path || "/")
  try {
    const resolved = await resolvePath(reqPath)
    if (resolved.isVirtual || !resolved.storage) {
      return c.json({ code: 200, message: "success", data: null })
    }
    const driver = await getDriver(resolved.storage.driver, resolved.storage)
    const d = driver as any
    // 優先使用驅動的直傳能力
    if (typeof d.getDirectUploadInfo === "function") {
      const info = await d.getDirectUploadInfo(
        resolved.relative,
        file_name,
        file_size,
      )
      return c.json({ code: 200, message: "success", data: info })
    }
    // 回退到 other("direct_upload") / other("get_direct_upload_info")
    if (typeof d.other === "function") {
      for (const m of ["direct_upload", "get_direct_upload_info"]) {
        try {
          const info = await d.other(m, resolved.relative, {
            file_name,
            file_size,
          })
          if (info) return c.json({ code: 200, message: "success", data: info })
        } catch {
          // 嘗試下一個 method
        }
      }
    }
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})

// ---- Multipart 分片上傳（與官方前端 multipart.ts API 契約對齊）----
// 服務層會話管理器：/fs/multipart/init | chunk | complete | status
// 內部橋接到驅動層 createUploadSession / uploadPart / completeUploadSession。

function splitUploadPath(uploadPath: string): { dir: string; name: string } {
  const clean = uploadPath.startsWith("/") ? uploadPath : "/" + uploadPath
  const parts = clean.split("/").filter(Boolean)
  const name = parts.pop() || ""
  const dir = "/" + parts.join("/")
  return { dir, name }
}

fsRouter.post("/multipart/init", async (c) => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return permissionDenied(c)

  const rawPath = decodeURIComponent(c.req.header("File-Path") || "")
  const size = parseInt(c.req.header("X-File-Size") || "0", 10)
  const rawChunk = parseInt(c.req.header("X-Chunk-Size") || "0", 10)
  const md5 = c.req.header("X-File-Md5") || ""

  if (!rawPath.trim() || size <= 0) {
    return c.json(
      { code: 400, message: "Missing File-Path / X-File-Size header", data: null },
      400,
    )
  }

  const { dir, name } = splitUploadPath(rawPath)
  const actualDir = getActualPath(user, dir)
  const requestContext = getStorageRequestContext(c)

  try {
    const resolved = await resolvePath(actualDir)
    if (resolved.isVirtual) {
      throw new Error("failed get storage: storage not found")
    }
    const driver = await getDriver(resolved.storage!.driver, resolved.storage)
    if (typeof (driver as any).createUploadSession !== "function") {
      // 儲存不支持分片：返回 data:null，前端自動回退到流式上傳
      return c.json({ code: 200, message: "success", data: null })
    }

    const chunkSize = clampChunkSize(rawChunk)
    const totalChunks = Math.max(1, Math.ceil(size / chunkSize))

    // 斷點續傳：同 path+size 的未完成會話直接複用
    let session: MultipartSession
    let resumed = false
    const existing = findReceivingSession(rawPath, size)
    if (existing) {
      session = existing
      resumed = true
    } else {
      const info = await (driver as any).createUploadSession(
        actualDir,
        resolved.physical!,
        name,
        size,
        md5,
      )
      session = {
        upload_id: newUploadId(),
        state: "receiving",
        attempt: 0,
        path: rawPath,
        size,
        chunk_size: chunkSize,
        total_chunks: totalChunks,
        received: new Set<number>(),
        driver_session: info?.session || "",
        partMd5s: new Array(totalChunks).fill(undefined),
        storage_driver: resolved.storage!.driver,
        created_at: Date.now(),
      }
      // 秒傳：驅動返回 reuse 標記
      if (info?.reuse) {
        session.state = "completed"
        session.received = new Set(
          Array.from({ length: totalChunks }, (_, i) => i),
        )
      }
      putSession(session)
    }
    await flushPendingDriverState(
      resolved.storage!.driver,
      resolved.storage,
      driver,
      requestContext,
    )
    return c.json({
      code: 200,
      message: "success",
      data: { ...mpSnapshot(session), resumed },
    })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})

fsRouter.put("/multipart/chunk", async (c) => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return permissionDenied(c)

  const uploadId = c.req.header("X-Upload-Id") || ""
  const chunkIndex = parseInt(c.req.header("X-Chunk-Index") || "-1", 10)
  const session = uploadId ? getSession(uploadId) : undefined

  if (!session) {
    return c.json(
      { code: 404, message: "upload session not found", data: null },
      404,
    )
  }
  if (chunkIndex < 0 || chunkIndex >= session.total_chunks) {
    return c.json({ code: 400, message: "invalid X-Chunk-Index", data: null }, 400)
  }

  // 冪等：已收分片直接返回當前快照
  if (session.received.has(chunkIndex)) {
    return c.json({ code: 200, message: "success", data: mpSnapshot(session) })
  }

  const tooLarge = exceedsUploadLimit(c, true)
  if (tooLarge !== null) {
    return c.json(
      { code: 413, message: `Part too large (max ${tooLarge} bytes)`, data: null },
      413,
    )
  }

  const requestContext = getStorageRequestContext(c)
  try {
    const resolved = await resolvePath(
      getActualPath(user, splitUploadPath(session.path).dir),
    )
    if (resolved.isVirtual) throw new Error("failed get storage: storage not found")
    const driver = await getDriver(resolved.storage!.driver, resolved.storage)
    if (typeof (driver as any).uploadPart !== "function") {
      throw new Error("storage does not support chunked upload")
    }
    const buffer = Buffer.from(await c.req.arrayBuffer())
    let result
    try {
      result = await (driver as any).uploadPart(
        session.driver_session,
        chunkIndex + 1,
        buffer,
      )
    } finally {
      await flushPendingDriverState(
        resolved.storage!.driver,
        resolved.storage,
        driver,
        requestContext,
      )
    }
    session.received.add(chunkIndex)
    if (result?.partMd5) session.partMd5s[chunkIndex] = result.partMd5
    putSession(session)
    return c.json({ code: 200, message: "success", data: mpSnapshot(session) })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})

fsRouter.post("/multipart/complete", async (c) => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return permissionDenied(c)

  const uploadId = c.req.header("X-Upload-Id") || ""
  const session = uploadId ? getSession(uploadId) : undefined
  if (!session) {
    return c.json(
      { code: 404, message: "upload session not found", data: null },
      404,
    )
  }
  if (session.state === "completed") {
    return c.json({ code: 200, message: "success", data: mpSnapshot(session) })
  }

  const requestContext = getStorageRequestContext(c)
  try {
    const resolved = await resolvePath(
      getActualPath(user, splitUploadPath(session.path).dir),
    )
    if (resolved.isVirtual) throw new Error("failed get storage: storage not found")
    const driver = await getDriver(resolved.storage!.driver, resolved.storage)
    if (typeof (driver as any).completeUploadSession !== "function") {
      throw new Error("storage does not support chunked upload")
    }
    try {
      await (driver as any).completeUploadSession(
        session.driver_session,
        session.partMd5s.filter((x) => x !== undefined),
      )
    } finally {
      await flushPendingDriverState(
        resolved.storage!.driver,
        resolved.storage,
        driver,
        requestContext,
      )
    }
    session.state = "completed"
    putSession(session)
    deleteSession(session.upload_id)
    return c.json({ code: 200, message: "success", data: mpSnapshot(session) })
  } catch (e: any) {
    session.state = "failed_permanent"
    session.error = safeErrorMessage(e)
    putSession(session)
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})

fsRouter.get("/multipart/status", async (c) => {
  const uploadId = c.req.query("upload_id") || ""
  const session = uploadId ? getSession(uploadId) : undefined
  if (!session) {
    return c.json(
      { code: 404, message: "upload session not found", data: null },
      404,
    )
  }
  return c.json({ code: 200, message: "success", data: mpSnapshot(session) })
})

// ---- 歸檔（Archive）----
// ZIP（Store/Deflate）：Worker 內置 DecompressionStream，完整支持。
// tar/tar.gz/tgz/tar.bz2/tar.xz：需要對應解壓實現，當前運行時若無
//   原生支持則返回 501（能力不足，非請求錯誤），前端可據此提示用戶。
// 7z/rar：Worker 運行時無原生解析庫，明確返回 501。
// 歸檔內容在記憶體中解析，受 Worker 記憶體限制，適合中小型歸檔。

type ArchiveFormat = "zip" | "tar" | "tar.gz" | "tar.bz2" | "tar.xz" | "7z" | "rar"

function detectArchiveFormat(name: string): ArchiveFormat | null {
  const lower = name.toLowerCase()
  if (lower.endsWith(".zip")) return "zip"
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz"
  if (lower.endsWith(".tar.bz2") || lower.endsWith(".tbz2")) return "tar.bz2"
  if (lower.endsWith(".tar.xz") || lower.endsWith(".txz")) return "tar.xz"
  if (lower.endsWith(".tar")) return "tar"
  if (lower.endsWith(".7z")) return "7z"
  if (lower.endsWith(".rar")) return "rar"
  return null
}

/** 當前運行時實際可解析的格式（ZIP 始終可用；其他格式按需擴展） */
function isNativelySupported(fmt: ArchiveFormat): boolean {
  return fmt === "zip"
}

/** 下載歸檔文件字節（複用驅動 get() 的 raw_url + SSRF 防護） */
async function fetchArchiveBytes(
  c: any,
  user: any,
  virtualPath: string,
): Promise<ArrayBuffer> {
  const actual = getActualPath(user, virtualPath)
  const resolved = await resolvePath(actual)
  if (resolved.isVirtual) throw new Error("failed get storage: storage not found")
  const driver = await getDriver(resolved.storage!.driver, resolved.storage)
  let item: any
  try {
    item = await driver.get(virtualPath, resolved.physical!)
  } finally {
    await flushPendingDriverState(
      resolved.storage!.driver,
      resolved.storage,
      driver,
      getStorageRequestContext(c),
    )
  }
  if (!item || !item.raw_url) {
    throw new Error("archive driver did not return download link")
  }
  // 管理員配置的受信儲存 endpoint host（內網自建 S3/WebDAV/MinIO）+ 全局
  // 環境變量 SSRF_ALLOWED_HOSTS 加入白名單
  const trustedHosts = getTrustedHosts(resolved.storage?.addition, c.env)
  assertSafeUrl(item.raw_url, "Archive download", trustedHosts)
  const resp = await fetch(item.raw_url, {
    headers: item.raw_url_headers || {},
  })
  if (!resp.ok) throw new Error(`archive download failed: HTTP ${resp.status}`)
  return await resp.arrayBuffer()
}

/** 將扁平條目構建為樹形結構（對齊 Go ArchiveContentResp） */
function buildArchiveTree(archive: ZipArchive): any[] {
  const root: any[] = []
  const dirMap = new Map<string, any>()

  for (const e of archive.entries) {
    const parts = e.name.split("/").filter(Boolean)
    if (parts.length === 0) continue

    let current = root
    let currentPath = ""
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const isLast = i === parts.length - 1
      currentPath = currentPath ? `${currentPath}/${part}` : `/${part}`

      if (isLast) {
        current.push({
          name: part,
          size: e.size,
          is_dir: false,
          modified: e.modified || new Date().toISOString(),
          type: calcFileTypeSafe(part, false),
          children: [] as any[],
        })
      } else {
        let dir = dirMap.get(currentPath)
        if (!dir) {
          dir = {
            name: part,
            size: 0,
            is_dir: true,
            modified: e.modified || new Date().toISOString(),
            type: 1,
            children: [] as any[],
          }
          dirMap.set(currentPath, dir)
          current.push(dir)
        }
        current = dir.children
      }
    }
  }
  return root
}

function calcFileTypeSafe(name: string, isDir: boolean): number {
  const ext = name.split(".").pop()?.toLowerCase() || ""
  if (isDir) return 1
  const video = ["mp4", "mkv", "webm", "avi", "mov", "flv", "m3u8"]
  const audio = ["mp3", "flac", "wav", "aac", "ogg", "m4a"]
  const image = ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico"]
  const text = ["txt", "md", "json", "js", "ts", "css", "html", "xml", "yml", "log"]
  if (video.includes(ext)) return 2
  if (audio.includes(ext)) return 3
  if (image.includes(ext)) return 4
  if (text.includes(ext)) return 5
  return 6
}

fsRouter.post("/archive/meta", async (c) => {
  const user = await getUserFromContext(c)
  if (!user || user.disabled) return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  const body = await c.req.json().catch(() => ({}))
  const path = String(body.path || c.req.query("path") || "").trim()
  if (!path) return c.json({ code: 400, message: "path is required", data: null }, 400)
  const fmt = detectArchiveFormat(path)
  if (!fmt) {
    return c.json({ code: 400, message: "unrecognized archive format", data: null }, 400)
  }
  if (!isNativelySupported(fmt)) {
    return c.json({
      code: 501,
      message: `archive format '${fmt}' is recognized but not supported in this runtime (Worker supports ZIP only); use the Go backend for ${fmt} archives`,
      data: null,
    }, 501)
  }
  try {
    const bytes = await fetchArchiveBytes(c, user, path)
    const archive = parseZip(bytes)
    const tree = buildArchiveTree(archive)
    return c.json({
      code: 200,
      message: "success",
      data: {
        comment: "",
        encrypted: false,
        content: tree,
        raw_url: "",
        sign: "",
      },
    })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})

fsRouter.post("/archive/list", async (c) => {
  const user = await getUserFromContext(c)
  if (!user || user.disabled) return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  const body = await c.req.json().catch(() => ({}))
  const path = String(body.path || c.req.query("path") || "").trim()
  const innerPath = String(body.inner_path || "").trim().replace(/\/+/g, "/")
  if (!path) return c.json({ code: 400, message: "path is required", data: null }, 400)
  const fmtList = detectArchiveFormat(path)
  if (!fmtList) {
    return c.json({ code: 400, message: "unrecognized archive format", data: null }, 400)
  }
  if (!isNativelySupported(fmtList)) {
    return c.json({
      code: 501,
      message: `archive format '${fmtList}' is recognized but not supported in this runtime; use the Go backend for ${fmtList} archives`,
      data: null,
    }, 501)
  }
  try {
    const bytes = await fetchArchiveBytes(c, user, path)
    const archive = parseZip(bytes)
    const prefix = innerPath ? innerPath.replace(/^\/+|\/+$/g, "") + "/" : ""
    const items = archive.entries
      .filter((e) => {
        if (!prefix) return !e.name.includes("/")
        return e.name.startsWith(prefix) && e.name !== prefix.slice(0, -1)
      })
      .map((e) => {
        const rel = prefix ? e.name.slice(prefix.length) : e.name
        return {
          name: rel.split("/")[0],
          size: e.size,
          is_dir: false,
          modified: e.modified || new Date().toISOString(),
          type: calcFileTypeSafe(rel.split("/")[0], false),
        }
      })
    // 去重（扁平列表）
    const seen = new Set<string>()
    const content = items.filter((it) => {
      if (seen.has(it.name)) return false
      seen.add(it.name)
      return true
    })
    return c.json({
      code: 200,
      message: "success",
      data: { content, total: content.length },
    })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})

fsRouter.post("/archive/decompress", async (c) => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return c.json({ code: 403, message: "Permission denied", data: null }, 403)
  const body = await c.req.json().catch(() => ({}))
  const srcDir = String(body.src_dir || "").trim()
  const dstDir = String(body.dst_dir || "").trim()
  const names: string[] = Array.isArray(body.name) ? body.name : body.name ? [String(body.name)] : []
  const innerPath = String(body.inner_path || "").trim().replace(/\/+/g, "/")
  if (!names.length || !dstDir) {
    return c.json({ code: 400, message: "src_dir/dst_dir/name are required", data: null }, 400)
  }
  try {
    let count = 0
    for (const name of names) {
      const srcPath = srcDir ? `${srcDir}/${name}` : `/${name}`
      const fmtDecomp = detectArchiveFormat(name)
      if (!fmtDecomp || !isNativelySupported(fmtDecomp)) {
        return c.json({ code: 400, message: `unsupported archive format: ${name} (only ZIP is supported)`, data: null }, 400)
      }
      const bytes = await fetchArchiveBytes(c, user, srcPath)
      const archive = parseZip(bytes)
      const prefix = innerPath ? innerPath.replace(/^\/+|\/+$/g, "") + "/" : ""
      for (const entry of archive.entries) {
        if (prefix && !entry.name.startsWith(prefix)) continue
        const rel = prefix ? entry.name.slice(prefix.length) : entry.name
        if (!rel || rel.endsWith("/")) continue
        const targetPath = `${dstDir.replace(/\/+$/, "")}/${rel}`
        const content = await extractZipEntry(bytes, entry)
        await putItem(targetPath, Buffer.from(content), getStorageRequestContext(c))
        count++
      }
    }
    return c.json({ code: 200, message: "success", data: { task: null, count } })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})
