/**
 * 原生代理的上游請求構造與響應判定。
 *
 * 從 raw.ts 抽出的原因：這些邏輯（Range 透傳、412/200 兜底、響應頭清洗）
 * 是純函數式判斷，抽離後可以脫離 Hono 上下文直接做單元測試，
 * 覆蓋「Range 透傳 + 簽名 + 上游不支持 Range」的交互邊界。
 */

import { parseRangeHeader } from "../internal/stream/stream"
import { driverMustProxyForStorage } from "../internal/driver/proxy"

export const PROXY_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

export interface BuildUpstreamHeadersInput {
  /** 驅動提供的原始頭（Cookie / Referer / Authorization 等） */
  rawUrlHeaders?: Record<string, string> | null
  /** 客戶端請求攜帶的 Range */
  rangeHeader?: string | null
  /** 儲存的 proxy_range 開關（對齊 Go model.Proxy.ProxyRange） */
  proxyRange: boolean
  /**
   * 全局設置 proxy_ignore_headers（對齊 Go conf.ProxyIgnoreHeaders，默認
   * authorization,referer）。命中列表的**客戶端派生頭**不轉發給上游
   * （本模塊會轉發的客戶端頭只有 Range 與兜底 User-Agent）；
   * 驅動自己聲明的頭（rawUrlHeaders）不受影響——Go 的 ProcessHeader 同樣是
   * 先過濾客戶端頭、再套用驅動 override。
   */
  ignoreHeaders?: unknown
}

/**
 * 構造發往上游的請求頭。
 *
 * proxy_range 語義（對齊 Go）：
 *   - true  ：透傳客戶端 Range，上游支持時可回 206，支持拖進度條/斷點續傳
 *   - false ：不透傳 Range，請求完整文件（用於不支持 Range 的上游）
 *
 * 注意與簽名的關係：本函數**不修改** raw_url 上的簽名參數。
 * 簽名綁定的是 URL 中的路徑與過期時間，不包含請求頭，
 * 因此丟棄或保留 Range 頭都不需要重新計算簽名。
 */
export function buildUpstreamHeaders(
  input: BuildUpstreamHeadersInput,
): Record<string, string> {
  const ignored = normalizeHeaderNameSet(input.ignoreHeaders)
  const headers: Record<string, string> = {
    ...(input.rawUrlHeaders || {}),
  }

  // 驅動已顯式設置 UA 時不覆蓋
  if (!headers["User-Agent"] && !ignored.has("user-agent")) {
    headers["User-Agent"] = PROXY_USER_AGENT
  }

  if (input.proxyRange && input.rangeHeader && !ignored.has("range")) {
    headers["Range"] = input.rangeHeader
  }

  return headers
}

/** 歸一化被忽略的請求頭名（小寫）；Go 默認值是 authorization,referer */
function normalizeHeaderNameSet(value: unknown): Set<string> {
  const raw = Array.isArray(value) ? value.join(",") : value
  return new Set(
    String(raw ?? "")
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  )
}

export interface UpstreamResponseLike {
  status: number
  headers: { get(name: string): string | null }
}

/**
 * 判斷是否需要「去掉 Range 重試一次」。
 *
 * 兩種上游不配合的情形：
 *   1. 412 Precondition Failed —— 嚴格校驗 Range 的 OSS/網關
 *   2. 200 且沒有 Content-Range —— 上游靜默忽略 Range，回了完整文件
 *
 * 僅在本次請求確實帶了 Range 時才重試，避免無意義地重複請求。
 */
export function shouldRetryWithoutRange(
  headers: Record<string, string>,
  upstream: UpstreamResponseLike,
): boolean {
  if (!headers["Range"]) return false
  if (upstream.status === 412) return true
  if (upstream.status === 200 && !upstream.headers.get("content-range")) {
    return true
  }
  return false
}

/** 上層文件擴展名 → Content-Type 回退表 */
const EXT_CONTENT_TYPE: Record<string, string> = {
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  flac: "audio/flac",
  m3u8: "application/vnd.apple.mpegurl",
  ts: "video/mp2t",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
}

/** 按擴展名推斷 Content-Type（上游未提供時使用） */
export function contentTypeForPath(reqPath: string): string {
  const ext = reqPath.split(".").pop()?.toLowerCase() || ""
  return EXT_CONTENT_TYPE[ext] || "application/octet-stream"
}

/**
 * 清洗 Content-Disposition，移除 CR/LF 與控制字符。
 * 防止惡意上游通過該頭注入額外響應頭（Set-Cookie / Location）。
 */
export function sanitizeContentDisposition(value: string): string {
  return value.replace(/[\r\n\u0000-\u001f]+/g, "")
}

// ---------------------------------------------------------------------------
// 平台載荷上限保護（Serverless / 雲函數）
// ---------------------------------------------------------------------------
//
// EdgeOne Makers 的 Cloud Functions 對「函數的請求/響應 body」有 6 MiB 硬上限，
// 超限時平台在網關層直接返回 413 + CLOUD_FUNCTION_PAYLOAD_TOO_LARGE
// （Powered by Tencent EdgeOne Makers 的錯誤頁）——請求根本到不了本服務：
// 應用側的 CORS 頭、Range 處理、錯誤提示一律不會執行。
//
// 而 native_proxy 會把整份文件當作雲函數響應體回傳，於是任何 >6 MiB 的代理
// 下載在 EdgeOne 上必然失敗（OneDrive 此前被硬編碼強制代理，正是 issue 中
// 「EO + OneDrive 下載報 413」的根因，見 resolveProxyDecision() 的修復）。
// 因此在發起原生代理前先做一次上限判斷：
//   - 未超限（或平台不限制）        → 正常代理
//   - 超限 + raw_url 可被瀏覽器直連 → 降級 302 直鏈（下載仍然可用）
//   - 超限 + 無法降級為直鏈         → 返回可讀的 413，而不是平台錯誤頁
//
// 環境變量：
//   RAW_PROXY_MAX_BYTES  平台單次請求/響應上限（字節）。缺省時在 EdgeOne 運行時
//                        自動取 6 MiB；其他平台視為不限制；顯式設為 0 關閉限制
//                        （自託管場景可據此恢復「永遠代理」）。

/** EdgeOne 雲函數對單次請求/響應 body 的硬上限 */
export const DEFAULT_EDGEONE_PAYLOAD_LIMIT = 6 * 1024 * 1024

/** 原生代理前的上限判斷結果 */
export type ProxyPayloadAction = "proxy" | "redirect" | "too-large"

const readEnvValue = (c: any, key: string): string => {
  const env = c?.env || {}
  const fromEnv = env[key]
  if (fromEnv !== undefined && fromEnv !== null) return String(fromEnv)
  if (typeof process !== "undefined" && (process as any).env) {
    const value = (process as any).env[key]
    if (value !== undefined && value !== null) return String(value)
  }
  return ""
}

/**
 * 當前運行時是否 EdgeOne（Node 雲函數 / 邊緣函數）。
 *
 * 判據對齊 internal/model/store/backend.ts 的 isServerlessRuntime()：
 *   1. EdgeOne Node 雲函數跑在騰訊 SCF 上，平台會注入 `TENCENTCLOUD_SCF_FUNCTIONNAME`
 *      —— 這是該形態**唯一可靠**的平台特徵（舊版只查 EDGEONE/EO_REGION，而這兩個
 *      變量並沒有證據表明會被雲函數注入，會導致本守衛在 EdgeOne 上永不生效）；
 *   2. 綁定了 Blob 命名空間或運行在邊緣函數時，有 `EDGEONE_BLOB` / 全局 `EdgeOne`。
 *
 * 刻意**不**使用 `__requestOrigin`：它由本項目 index.ts 中間件在所有平台上注入
 * （見 src/backend/index.ts），拿它判 EdgeOne 會把 Cloudflare / 自託管一併誤判，
 * 反而讓 CF 上的大文件代理被無故降級為 302。
 *
 * 同理，Cloudflare Workers 與阿里雲 ESA 不套用 6 MiB：CF 的函數 body 上限遠高於此，
 * 本限制是 EdgeOne 雲函數特有的，因此這裡只認 EdgeOne 自身的特徵。
 */
function isEdgeOneRuntime(c: any): boolean {
  const g: any = typeof globalThis !== "undefined" ? globalThis : {}
  const env = c?.env || {}
  const procEnv: any =
    typeof process !== "undefined" ? (process as any).env || {} : {}
  return Boolean(
    env.EDGEONE ||
    env.EO_REGION ||
    env.EDGEONE_BLOB ||
    g.EDGEONE_BLOB ||
    typeof g.EdgeOne !== "undefined" ||
    env.TENCENTCLOUD_SCF_FUNCTIONNAME ||
    procEnv.TENCENTCLOUD_SCF_FUNCTIONNAME,
  )
}

/** 平台單次請求/響應 body 上限（字節）；0 表示不限制 */
export function getProxyPayloadLimit(c: any): number {
  const raw = readEnvValue(c, "RAW_PROXY_MAX_BYTES").trim()
  if (raw !== "") {
    const parsed = parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return isEdgeOneRuntime(c) ? DEFAULT_EDGEONE_PAYLOAD_LIMIT : 0
}

/**
 * 本次代理是否會讓響應體超過平台上限。
 *
 * Range 只回傳一個分片時按分片大小判斷（視頻拖動進度、斷點續傳不受影響）；
 * 大小未知時一律放行，交給平台兜底。
 */
export function exceedsProxyPayloadLimit(
  size: number,
  range: string | null | undefined,
  limit: number,
): boolean {
  if (!Number.isFinite(limit) || limit <= 0) return false
  if (!Number.isFinite(size) || size <= 0) return false
  if (range) {
    try {
      return parseRangeHeader(range, size).chunksize > limit
    } catch {
      return false
    }
  }
  return size > limit
}

/**
 * 私有請求頭（瀏覽器無法自帶）：只有這些頭才讓 302 直鏈失去可行性。
 *
 * 倉庫內 33 處 `raw_url_headers` 實際只用到 Authorization / Cookie /
 * User-Agent / Referer / Origin，其中只有前兩者是瀏覽器無法提供的鑑權信息
 * （如 WebDAV、微雲、Google Drive、Teldrive）。驅動若引入新的鑑權頭，
 * 應按 Go 的 meta.go 把該驅動登記為 MustProxy（見 internal/driver/proxy.ts），
 * 而不是在這裡堆一個「猜頭名」的規則。
 */
const PRIVATE_HEADER_NAMES = new Set(["authorization", "cookie"])

/** raw_url 是否要求私有請求頭（瀏覽器直連會 401/403） */
export function rawUrlNeedsPrivateHeaders(
  headers?: Record<string, string> | null,
): boolean {
  if (!headers) return false
  return Object.keys(headers).some((k) =>
    PRIVATE_HEADER_NAMES.has(k.trim().toLowerCase()),
  )
}

/**
 * 該下載是否必須由服務端轉發字節流、無法降級為 302 直鏈。
 *
 * 兩類情況：
 *   1. 驅動本身沒有可公開的直鏈（Go 的 OnlyProxy / NoLinkURL，即 driverMustProxy）；
 *   2. 直鏈必須攜帶私有請求頭（Authorization / Cookie，如 WebDAV、微雲）。
 */
export function isAuthBoundDownload(
  driver: string,
  rawUrlHeaders?: Record<string, string> | null,
  storage?: any,
): boolean {
  return (
    driverMustProxyForStorage(storage, driver) ||
    rawUrlNeedsPrivateHeaders(rawUrlHeaders)
  )
}

/**
 * 從上游響應頭解析本次實際會回傳的字節數。
 *
 * 用途：`shouldRetryWithoutRange()` 會刪掉 Range 重新請求，上游忽略 Range 時也會
 * 直接回 200 + 完整文件——此時回傳的是**整份文件**而不是客戶端請求的分片。
 * 僅按「分片大小」通過前置上限檢查是不夠的，必須用上游給出的實際長度複核，
 * 否則小分片請求會把整份文件塞進雲函數響應體（EdgeOne 6 MiB → 413）。
 *
 * 取值優先級：Content-Length → Content-Range 的分段長度 → 0（未知）。
 */
export function upstreamBodySize(
  headers: { get(name: string): string | null } | null | undefined,
): number {
  if (!headers) return 0
  const contentLength = parseInt(headers.get("content-length") || "", 10)
  if (Number.isFinite(contentLength) && contentLength > 0) return contentLength
  const contentRange = headers.get("content-range") || ""
  const match = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(contentRange)
  if (match) {
    const start = parseInt(match[1], 10)
    const end = parseInt(match[2], 10)
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      return end - start + 1
    }
  }
  return 0
}

/**
 * 原生代理前的上限決策。
 *
 * @param size           文件總大小（0 表示未知）
 * @param range          實際會透傳給上游的 Range（proxy_range 關閉時應傳 undefined，
 *                       因為此時上游返回的是完整文件，分片大小無法作為依據）
 * @param authBound      無法降級為直鏈時為 true
 *
 * 超限時：可直連（authBound=false）→ 降級 302；否則 → too-large（返回可讀 413）。
 */
export function decideProxyPayloadAction(input: {
  size: number
  range?: string | null
  payloadLimit: number
  authBound: boolean
}): ProxyPayloadAction {
  if (!exceedsProxyPayloadLimit(input.size, input.range, input.payloadLimit)) {
    return "proxy"
  }
  // 超過平台上限：能交給瀏覽器直連就降級 302，否則必須給出可讀錯誤，
  // 而不是讓平台返回它自己的 413 錯誤頁。
  return input.authBound ? "too-large" : "redirect"
}
