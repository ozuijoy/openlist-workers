/**
 * 驅動代理能力聲明 + 下載（302 / 代理）決策，對齊 Go 版 OpenList。
 *
 * Go 側對應實現：
 *   - internal/driver/config.go     Config.MustProxy() / Config.DefaultProxy()
 *   - internal/op/driver.go         web_proxy / webdav_policy 表單默認值分支
 *   - server/common/check.go        ShouldProxy()（/d：MustProxy || WebProxy || proxy_types）
 *   - server/handles/down.go        canProxy()（/p：再加 webdav_policy=use_proxy_url
 *                                   與 text_types，不滿足則 403 proxy not allowed）
 *   - internal/model/storage.go     Proxy.Webdav302() / Proxy.WebdavProxyURL()
 *
 * 本模塊保持**純函數**（不讀資料庫）：全局設置 proxy_types / text_types 由調用方
 * 從 db 讀出後作為參數傳入，便於單測。
 *
 * 取值語義（與 Go 完全一致）：
 *   - 未配置（undefined / ""）：回退到驅動默認值（DefaultProxy()）
 *   - "302_redirect"    ：302 重定向到真實直鏈
 *   - "use_proxy_url"   ：重定向到管理員配置的下載代理地址（down_proxy_url）
 *   - "native_proxy"    ：由本服務原生代理轉發字節流
 */

import { parseAdditionLoose } from "./storageopts"

export type ProxyMode = "302_redirect" | "use_proxy_url" | "native_proxy"

export type ProxyPolicySource =
  | "force" // 驅動能力強制代理（MustProxy）
  | "web_proxy" // 儲存級 web_proxy 開關
  | "proxy_path" // 請求命中 /p、/sd 等代理前綴
  | "proxy_types" // 全局設置 proxy_types 命中的擴展名（Go: ShouldProxy 第三條）
  | "storage_policy" // 儲存級 webdav_policy
  | "driver_default" // 驅動默認值（PreferProxy）

export interface ProxyDecision {
  /** 最終生效的下載模式 */
  mode: ProxyMode
  /** 是否必須走服務端代理（302 已被排除） */
  needsProxy: boolean
  /** 決策來源，便於日誌排查 */
  source: ProxyPolicySource
}

/**
 * ============================================================================
 * 驅動代理能力 ↔ Go drivers/&lt;name&gt;/meta.go 的對應關係（本文件是唯一真相）
 * ============================================================================
 *
 * 維護本文件時請對照 Go 側 `driver.Config` 的以下欄位：
 *
 * | Go config 欄位        | 語義                         | 本文件對應               |
 * |----------------------|------------------------------|--------------------------|
 * | `OnlyProxy: true`    | 無可用直鏈，必須代理          | DRIVER_FORCE_PROXY       |
 * | `NoLinkURL: true`    | Link() 不返回可公開 URL      | DRIVER_FORCE_PROXY       |
 * | `PreferProxy: true`  | 優先代理，但直鏈可用          | DRIVER_PREFER_PROXY      |
 * | `ProxyRangeOption`   | 支持 proxy_range 開關        | PROXY_RANGE_DRIVERS      |
 *
 * 注意：**權威來源是各驅動的 meta.go**（Go 側按驅動註冊），下表是同步後的快照。
 * Go 側增刪驅動時請同步更新此處；admin.ts 的表單欄位與運行時決策都從這裡派生，
 * 不要在別處再抄一份。
 *
 * --- OnlyProxy / NoLinkURL（MustProxy，強制 native_proxy，表單不提供 302）---
 *   weiyun        drivers/weiyun/meta.go
 *   sftp          drivers/sftp/meta.go
 *   ftp           drivers/ftp/meta.go
 *   smb           drivers/smb/meta.go
 *   crypt         drivers/crypt/meta.go
 *   virtual       drivers/virtual/meta.go
 *   strm          drivers/strm/meta.go
 *   meganz        drivers/mega/meta.go
 *   protondrive   drivers/proton_drive/meta.go
 *   chunk         drivers/chunk/meta.go
 *   googledrive   drivers/google_drive/meta.go
 *   googlephoto   drivers/google_photo/meta.go
 *   quarkopen     drivers/quark_open/meta.go
 *   quarkuc       drivers/quark_uc/meta.go（Go 註冊名為 "UC"）
 *   chaoxing      drivers/chaoxing/meta.go
 *   local         drivers/local/meta.go（TS 走本地文件分支，不經驅動下載鏈路，
 *                 但 /p 端點判定仍需把它算作「允許代理」）
 *
 *   bunny_storage 在 Go 裡是**運行時條件**（配了儲存區且未綁 CDN 域名才強制代理），
 *                 由 driverMustProxyForStorage() 處理。
 *
 * --- PreferProxy（DefaultProxy()：web_proxy 未配置時的表單默認值）---
 *   webdav        drivers/webdav/meta.go
 *   baidunetdisk  drivers/baidu_netdisk/meta.go
 *   123pan        drivers/123/meta.go
 *   123open       drivers/123_open/meta.go
 *   123panshare   drivers/123_share/meta.go
 *
 * --- ProxyRangeOption（表單顯示 proxy_range）---
 *   139yun        drivers/139/meta.go
 *   alias         drivers/alias/meta.go
 *   alistv3       drivers/alist_v3/meta.go
 *   openlist      drivers/openlist/meta.go
 *
 * 未登記的驅動一律視為「不強制代理、不默認代理」→ 默認 302_redirect。
 *
 * --- 與 Go 的差異 ---
 * 1. `PreferProxy` 在 Go 裡僅用於**表單默認值**；本文件讓它在運行時也生效（僅當儲存
 *    的 `web_proxy` 未配置時兜底），否則 TS 存量資料（web_proxy 為 null）會把默認
 *    應當代理的驅動判成直鏈。
 * 2. Go 的透明代理會轉發**全部**客戶端請求頭（僅按 proxy_ignore_headers 過濾）；
 *    本 TS 實現僅轉發少量必要的頭（客戶端 Range + 兜底 User-Agent + 驅動聲明的頭），
 *    以免把客戶端 Cookie / Authorization 洩露給第三方上游。proxy_ignore_headers
 *    仍然作用於這些會轉發的頭（見 server/proxy_request.ts 的 buildUpstreamHeaders）。
 * 3. Go 的多執行緒 RangeReader（Config.Concurrency/PartSize 與
 *    internal/stream.GetRangeReaderFromLink）未實現：TS 用「透傳客戶端 Range，
 *    上游拒絕/忽略時去掉 Range 重試一次」達到同等可用性，但不做並行分片下載。
 */

/** 強制代理（Go: Config.MustProxy() = OnlyProxy || NoLinkURL） */
const DRIVER_FORCE_PROXY = new Set<string>([
  "weiyun",
  "sftp",
  "ftp",
  "smb",
  "crypt",
  "virtual",
  "strm",
  "meganz",
  "protondrive",
  "chunk",
  "googledrive",
  "googlephoto",
  "quarkopen",
  "quarkuc",
  "chaoxing",
  "local",
])

/** 默認代理（Go: Config.DefaultProxy() = PreferProxy） */
const DRIVER_PREFER_PROXY = new Set<string>([
  "webdav",
  "baidunetdisk",
  "123pan",
  "123open",
  "123panshare",
])

/**
 * 允許 `proxy_range` 的驅動（等價 Go 的 Config.ProxyRangeOption）。
 * 供 admin.ts 決定是否展示 proxy_range 表單項。
 *
 * 注意：透傳客戶端 Range 是**默認行為**（對齊 Go 透明代理總是轉發客戶端頭），
 * 該開關僅在這幾個驅動上作為「可顯式關閉」的入口，Go 裡 139Yun 實例默認
 * `d.ProxyRange = true` 的差異因此不再需要單獨表達。
 */
export const PROXY_RANGE_DRIVERS = new Set([
  "139yun",
  "alias",
  "alistv3",
  "openlist",
])

/** 管理員自定義下載代理地址的欄位（落在 storage.addition 內） */
const PROXY_URL_ADDITION_KEYS = [
  "down_proxy_url",
  "download_proxy_url",
  "proxy_url",
]

/**
 * 規範化驅動名：去除非字母數字並轉小寫。
 * 與 server/raw.ts 中的同名邏輯保持一致，用於把 admin 表單裡的驅動名
 * （如 "123Pan"、"GitHub API"）與儲存行上的 driver 值對齊。
 */
export function normalizeDriverName(driver: string | undefined | null): string {
  return String(driver ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
}

/**
 * 歸一化擴展名列表（全局設置裡是逗號分隔字符串，Go: conf.SlicesMap）。
 * 與 Go 的 utils.Ext 一致：小寫、不帶點。
 */
export function normalizeExtList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.join(",") : value
  return String(raw ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean)
}

/**
 * 取路徑的擴展名（小寫、不帶點）；無擴展名返回 ""。
 *
 * 與 Go utils.Ext 一致：取最後一個點之後的部分並小寫，因此 `.gitignore`
 * 這類隱藏文件的擴展名是 `gitignore`（Go 的 text_types 默認值裡也確實有它）。
 */
export function extensionOf(filePath: string | undefined | null): string {
  const base = String(filePath ?? "")
    .split("/")
    .pop()
    ?.trim()
  if (!base) return ""
  const idx = base.lastIndexOf(".")
  if (idx < 0 || idx === base.length - 1) return ""
  return base.slice(idx + 1).toLowerCase()
}

/**
 * 該驅動是否強制代理（Go: Config.MustProxy()）。靜態能力，見上方能力表。
 *
 * 注意 bunny_storage 的能力是**運行時條件**，需要儲存上下文，
 * 請用 driverMustProxyForStorage()。
 */
export function driverMustProxy(driver: string): boolean {
  return DRIVER_FORCE_PROXY.has(normalizeDriverName(driver))
}

/**
 * bunny_storage 是否必須代理。
 *
 * Go drivers/bunny_storage/driver.go 的 Config()：
 *   if d.StorageZoneName != "" && d.CDNBaseURL == "" { cfg.OnlyProxy = true; cfg.PreferProxy = true }
 * 即「配了儲存區但沒綁 CDN 域名」時僅有 Storage API 可讀（需 AccessKey 頭），
 * 瀏覽器直連會 401，必須由服務端代理。綁定了 CDN 則直鏈可用。
 */
function bunnyStorageNeedsProxy(storage: any): boolean {
  const addition = parseAdditionLoose(storage?.addition)
  const zone = String(addition.storage_zone_name ?? "").trim()
  const cdn = String(addition.cdn_base_url ?? "").trim()
  return zone !== "" && cdn === ""
}

/** 儲存感知的 MustProxy 判定（Go: storage.Config().MustProxy()） */
export function driverMustProxyForStorage(
  storage: any,
  driver?: string,
): boolean {
  const norm = normalizeDriverName(driver ?? storage?.driver)
  if (DRIVER_FORCE_PROXY.has(norm)) return true
  if (norm === "bunnystorage") return bunnyStorageNeedsProxy(storage)
  return false
}

/** 該驅動是否默認代理（Go: Config.DefaultProxy() = PreferProxy） */
export function driverPreferProxy(driver: string): boolean {
  return DRIVER_PREFER_PROXY.has(normalizeDriverName(driver))
}

/** 讀取儲存行上的代理策略（相容 camelCase 與 "policy" 別名） */
export function getStoragePolicy(storage: any): string {
  if (!storage) return ""
  const raw =
    storage.webdav_policy ??
    storage.webdavPolicy ??
    storage.policy ??
    storage.webdavPolicyType
  return typeof raw === "string" ? raw.trim() : ""
}

/**
 * 解析管理員配置的自定義下載代理地址（對齊 Go model.Proxy.DownProxyURL）。
 *
 * 優先讀取儲存行上的頂層欄位（後台表單寫入的就是這個位置），
 * 再回退到 addition 內的歷史別名，保證舊資料仍可用。
 */
export function getDownProxyUrl(storage: any): string {
  if (!storage) return ""

  // 1) 頂層欄位（正常路徑）
  for (const key of ["down_proxy_url", "downProxyUrl"]) {
    const val = storage[key]
    // 對齊 Go GenerateDownProxyURL：多行僅取第一行
    //（strings.Split(storage.DownProxyURL, "\n")[0]），否則會把換行帶進 URL。
    if (typeof val === "string" && val.trim()) return val.split("\n")[0].trim()
  }

  // 2) 回退到 addition 內的別名（相容歷史寫法）
  let addition: any = storage.addition
  if (typeof addition === "string") {
    try {
      addition = JSON.parse(addition || "{}")
    } catch {
      return ""
    }
  }
  if (!addition || typeof addition !== "object") return ""
  for (const key of PROXY_URL_ADDITION_KEYS) {
    const val = addition[key]
    if (typeof val === "string" && val.trim()) return val.split("\n")[0].trim()
  }
  return ""
}

export function getDisableProxySign(storage: any): boolean {
  if (!storage) return false
  const raw = storage.disable_proxy_sign ?? storage.disableProxySign
  if (typeof raw === "string") return raw.toLowerCase() === "true"
  return !!raw
}

/**
 * 從 storage.addition 的 order_by / order_direction 解析排序參數。
 * 部分驅動的排序配置落在 addition 而不是 storage 行上，這裡做統一兜底。
 */
/**
 * 儲存級 web_proxy 的**生效值**。
 *
 * Go 的行為：`web_proxy` 是儲存欄位，其**默認值**由驅動能力決定
 * （`op/driver.go`：PreferProxy 驅動的表單默認 true），運行時僅看該欄位
 * （`common.ShouldProxy`：`MustProxy() || WebProxy`）。
 *
 * TS 的存量資料裡 `web_proxy` 常為 null（早期表單未寫入），直接按 false 處理會
 * 把本該默認代理的驅動（WebDav 等）判成直鏈——這正是歷史上「WebDAV 下載丟認證」
 * 的成因。因此這裡在欄位未配置時回退到驅動默認值，等價於 Go 的表單默認。
 */
export function effectiveWebProxy(storage: any, driver: string): boolean {
  const raw = storage?.web_proxy ?? storage?.webProxy
  if (raw === true || raw === "true") return true
  if (raw === false || raw === "false") return false
  return driverPreferProxy(driver)
}

/**
 * 統一的下載模式決策入口（對齊 Go 的 ShouldProxy + webdav_policy）。
 *
 * 決策順序（對齊 Go：強制代理 > 儲存開關 > 路徑 > proxy_types > 儲存策略 > 直鏈）：
 *   1. 驅動強制代理（MustProxy，含 bunny_storage 的條件能力）→ native_proxy
 *   2. 儲存級 web_proxy（未配置時取驅動默認）               → native_proxy
 *   3. 請求命中代理前綴（/p、/sd ...）                      → native_proxy
 *   4. 擴展名命中全局 proxy_types（Go ShouldProxy 第三條）   → native_proxy
 *   5. 儲存級 webdav_policy 已配置                          → 按配置值
 *   6. 兜底                                                 → 302_redirect
 *
 * 與 Go 的差異：Go 的 `ShouldProxy` 不看 `webdav_policy`（`302_redirect` 僅作用於
 * WebDAV 協議端點，`use_proxy_url` 由 `canProxy` 處理）；TS 在此統一按策略值決策，
 * 因此「webdav_policy=native_proxy 且 web_proxy=false」在 TS 會代理、在 Go 會直鏈。
 *
 * @param opts.filename   目標路徑，用於取擴展名與 proxy_types 比對
 * @param opts.proxyTypes 全局設置 proxy_types（默認 m3u8,url，見 db.ts）
 */
export function resolveProxyDecision(
  storage: any,
  driver: string,
  requestIsProxyPath: boolean,
  opts: { filename?: string; proxyTypes?: unknown } = {},
): ProxyDecision {
  const norm = normalizeDriverName(driver)

  if (driverMustProxyForStorage(storage, norm)) {
    return { mode: "native_proxy", needsProxy: true, source: "force" }
  }

  if (effectiveWebProxy(storage, norm)) {
    return { mode: "native_proxy", needsProxy: true, source: "web_proxy" }
  }

  if (requestIsProxyPath) {
    return { mode: "native_proxy", needsProxy: true, source: "proxy_path" }
  }

  // Go ShouldProxy 的第三條：proxy_types 命中的擴展名（如 m3u8、url）必須由服務端
  // 代理——這類文件內部含相對引用，僅有經本服務轉發才能正確解析。
  if (matchesExtList(extensionOf(opts.filename), opts.proxyTypes)) {
    return { mode: "native_proxy", needsProxy: true, source: "proxy_types" }
  }

  const policy = getStoragePolicy(storage)
  if (policy) {
    return {
      mode: policy as ProxyMode,
      needsProxy: policy !== "302_redirect",
      source: "storage_policy",
    }
  }

  return { mode: "302_redirect", needsProxy: false, source: "driver_default" }
}

/** 擴展名是否命中設置裡的擴展名列表（空列表不命中） */
function matchesExtList(ext: string, list: unknown): boolean {
  if (!ext) return false
  return normalizeExtList(list).includes(ext)
}

/**
 * 是否允許使用 /p 代理端點（Go: server/handles/down.go 的 canProxy()）。
 *
 * Go 的 `/p` 路由在取鏈接前先跑這道檢查，不通過直接 403 "proxy not allowed"：
 *   MustProxy() || WebProxy || WebdavProxyURL() || proxy_types || text_types
 *
 * 與 resolveProxyDecision 的差別：
 *   - 額外接受 `text_types`：前端 Readme / 歌詞 / 字幕 / 彈幕等預覽走 /p 讀取文本
 *     文件，即使儲存沒開 web_proxy 也應當允許；
 *   - 額外接受 `webdav_policy=use_proxy_url`（Go canProxy 顯式包含 WebdavProxyURL）。
 *
 * 注意：Go 僅對 /p（以及歸檔的 /ap）做此限制，/d、/sd 不限制（它們走 ShouldProxy），
 * 因此調用方僅能把這個判斷用在 /p 端點上。
 */
export function canUseProxyEndpoint(input: {
  storage: any
  driver: string
  filename?: string
  proxyTypes?: unknown
  textTypes?: unknown
}): boolean {
  const norm = normalizeDriverName(input.driver)
  if (driverMustProxyForStorage(input.storage, norm)) return true
  if (effectiveWebProxy(input.storage, norm)) return true
  if (getStoragePolicy(input.storage) === "use_proxy_url") return true
  const ext = extensionOf(input.filename)
  if (!ext) return false
  return (
    matchesExtList(ext, input.proxyTypes) ||
    matchesExtList(ext, input.textTypes)
  )
}
