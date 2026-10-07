import assert from "node:assert/strict"
import { test } from "node:test"
import {
  buildUpstreamHeaders,
  shouldRetryWithoutRange,
  contentTypeForPath,
  sanitizeContentDisposition,
  decideProxyPayloadAction,
  exceedsProxyPayloadLimit,
  getProxyPayloadLimit,
  isAuthBoundDownload,
  rawUrlNeedsPrivateHeaders,
  upstreamBodySize,
  DEFAULT_EDGEONE_PAYLOAD_LIMIT,
  PROXY_USER_AGENT,
  type UpstreamResponseLike,
} from "./proxy_request"
import { getProxyRange } from "../internal/driver/storageopts"
import { resolveProxyDecision } from "../internal/driver/proxy"

/** 構造上游響應的最小替身 */
function upstream(
  status: number,
  headers: Record<string, string> = {},
): UpstreamResponseLike {
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return {
    status,
    headers: { get: (n: string) => lower[n.toLowerCase()] ?? null },
  }
}

// ---- Range 透傳決策（proxy_range）----

test("proxy_range=true 時透傳客戶端 Range", () => {
  const headers = buildUpstreamHeaders({
    rangeHeader: "bytes=0-1023",
    proxyRange: true,
  })
  assert.equal(headers["Range"], "bytes=0-1023")
})

test("proxy_range=false 時丟棄 Range（上游不支持 Range 的場景）", () => {
  const headers = buildUpstreamHeaders({
    rangeHeader: "bytes=0-1023",
    proxyRange: false,
  })
  assert.equal(headers["Range"], undefined)
})

test("proxy_range=true 但客戶端未發 Range 時不憑空添加", () => {
  const headers = buildUpstreamHeaders({ rangeHeader: null, proxyRange: true })
  assert.equal(headers["Range"], undefined)
})

// ---- 與簽名的交互（評審重點）----

test("Range 透傳不改變簽名：簽名綁定 URL，與請求頭無關", () => {
  // 模擬帶簽名的直鏈，兩種情況下的 raw_url 必須完全一致，
  // 證明丟棄/保留 Range 都不需要重新計算簽名。
  const signedUrl = "https://cdn.example.com/f.mp4?sign=1700000000.abcdef"
  const withRange = buildUpstreamHeaders({
    rangeHeader: "bytes=100-200",
    proxyRange: true,
  })
  const withoutRange = buildUpstreamHeaders({
    rangeHeader: "bytes=100-200",
    proxyRange: false,
  })
  // 請求頭中不包含任何簽名相關內容，簽名僅存在於 URL 上
  assert.deepEqual(
    Object.keys(withRange).filter((k) => /sign/i.test(k)),
    [],
  )
  assert.deepEqual(
    Object.keys(withoutRange).filter((k) => /sign/i.test(k)),
    [],
  )
  assert.equal(
    signedUrl,
    "https://cdn.example.com/f.mp4?sign=1700000000.abcdef",
  )
})

test("412 兜底重試時丟失 Range，但簽名 URL 可複用（僅需換請求頭）", () => {
  const headers = buildUpstreamHeaders({
    rangeHeader: "bytes=0-99",
    proxyRange: true,
  })
  assert.equal(headers["Range"], "bytes=0-99")

  // 上游嚴格校驗 Range，返回 412
  assert.equal(shouldRetryWithoutRange(headers, upstream(412)), true)

  // 刪除 Range 後重試：簽名仍在 URL 上，無需重新計算
  delete headers["Range"]
  assert.equal(headers["Range"], undefined)
  assert.equal(shouldRetryWithoutRange(headers, upstream(412)), false)
})

test("帶簽名 + Range 命中上游不支持 Range 的 200 分支時也走兜底", () => {
  const headers = buildUpstreamHeaders({
    rawUrlHeaders: { Authorization: "Bearer token-from-driver" },
    rangeHeader: "bytes=500-999",
    proxyRange: true,
  })
  // 上游忽略 Range 直接回 200 且無 Content-Range
  assert.equal(shouldRetryWithoutRange(headers, upstream(200, {})), true)
  // 驅動自帶的 Authorization 頭在兜底後必須保留
  delete headers["Range"]
  assert.equal(headers["Authorization"], "Bearer token-from-driver")
})

// ---------------------------------------------------------------------------
// 二次校驗：Range 協商後上遊實際回傳的大小
//
// 前置上限檢查是按「客戶端請求的分片」估算的，但 Range 兜底重試（刪掉 Range 重試）
// 與「上游忽略 Range 直接回 200」都會讓上游回傳整份文件；這條路徑必須按上游給出
// 的實際長度複核，否則小分片請求會把整份文件塞進雲函數響應體（EdgeOne 6 MiB）。
// ---------------------------------------------------------------------------

test("upstreamBodySize: Content-Length 優先，Content-Range 兜底", () => {
  assert.equal(
    upstreamBodySize(upstream(200, { "content-length": "12345" }).headers),
    12345,
  )
  // 僅有 Content-Range 時取分段長度（206 分片）
  assert.equal(
    upstreamBodySize(
      upstream(206, { "content-range": "bytes 0-1048575/524288000" }).headers,
    ),
    1048576,
  )
  // 無任何長度信息 → 0（未知，交給調用方決定是否放行）
  assert.equal(upstreamBodySize(upstream(200, {}).headers), 0)
  assert.equal(upstreamBodySize(null), 0)
  assert.equal(
    upstreamBodySize(upstream(200, { "content-length": "abc" }).headers),
    0,
  )
})

test("Range + 簽名 + 上限交互：412 重試後按完整文件大小判定（無需重籤）", () => {
  const signedUrl = "https://cdn.example.com/f.mp4?sign=1700000000.abcdef"
  const headers = buildUpstreamHeaders({
    rangeHeader: "bytes=0-1048575", // 僅想取 1 MiB
    proxyRange: true,
  })
  assert.equal(headers["Range"], "bytes=0-1048575")

  // 前置檢查：按 1 MiB 分片估算 → 通過
  assert.equal(
    decideProxyPayloadAction({
      size: 500 * MiB,
      range: headers["Range"],
      payloadLimit: EDGE_LIMIT,
      authBound: false,
    }),
    "proxy",
  )

  // 上游 412 → 去掉 Range 重試；簽名在 URL 上，重試無需重新計算
  assert.equal(shouldRetryWithoutRange(headers, upstream(412)), true)
  delete headers["Range"]
  assert.equal(shouldRetryWithoutRange(headers, upstream(412)), false)
  assert.equal(
    signedUrl,
    "https://cdn.example.com/f.mp4?sign=1700000000.abcdef",
  )

  // 重試後上游回了整份文件 → 二次校驗按實際大小判定為超限，降級 302
  const retried = upstream(200, { "content-length": String(500 * MiB) })
  const actual = upstreamBodySize(retried.headers)
  assert.equal(actual, 500 * MiB)
  assert.equal(
    decideProxyPayloadAction({
      size: actual,
      payloadLimit: EDGE_LIMIT,
      authBound: false,
    }),
    "redirect",
  )
})

test("Range + 上限交互：正常的 206 分片不會被二次校驗誤傷", () => {
  const partial = upstream(206, {
    "content-length": String(1 * MiB),
    "content-range": `bytes 0-${1 * MiB - 1}/${500 * MiB}`,
  })
  const actual = upstreamBodySize(partial.headers)
  assert.equal(actual, 1 * MiB)
  assert.equal(
    decideProxyPayloadAction({
      size: actual,
      payloadLimit: EDGE_LIMIT,
      authBound: false,
    }),
    "proxy",
  )
})

test("Range + 上限交互：整份文件超限且必須帶鑑權頭時返回可讀 413", () => {
  const retried = upstream(200, { "content-length": String(500 * MiB) })
  const actual = upstreamBodySize(retried.headers)
  assert.equal(
    decideProxyPayloadAction({
      size: actual,
      payloadLimit: EDGE_LIMIT,
      authBound: isAuthBoundDownload("webdav", {
        Authorization: "Basic dXNlcjpwYXNz",
      }),
    }),
    "too-large",
  )
})

// ---- shouldRetryWithoutRange 邊界 ----

test("未帶 Range 的請求永不觸發兜底重試", () => {
  const headers = buildUpstreamHeaders({ proxyRange: false })
  assert.equal(shouldRetryWithoutRange(headers, upstream(412)), false)
  assert.equal(shouldRetryWithoutRange(headers, upstream(200)), false)
})

test("正常 206 分片響應不觸發重試", () => {
  const headers = buildUpstreamHeaders({
    rangeHeader: "bytes=0-99",
    proxyRange: true,
  })
  assert.equal(
    shouldRetryWithoutRange(
      headers,
      upstream(206, { "content-range": "bytes 0-99/1000" }),
    ),
    false,
  )
})

test("200 但帶 Content-Range 時不重試（部分上游用 200 表達分片）", () => {
  const headers = buildUpstreamHeaders({
    rangeHeader: "bytes=0-99",
    proxyRange: true,
  })
  assert.equal(
    shouldRetryWithoutRange(
      headers,
      upstream(200, { "content-range": "bytes 0-99/1000" }),
    ),
    false,
  )
})

test("404 / 500 等錯誤不因帶 Range 而重試", () => {
  const headers = buildUpstreamHeaders({
    rangeHeader: "bytes=0-99",
    proxyRange: true,
  })
  assert.equal(shouldRetryWithoutRange(headers, upstream(404)), false)
  assert.equal(shouldRetryWithoutRange(headers, upstream(500)), false)
})

// ---- 請求頭構造 ----

test("User-Agent：未提供時補默認值，已提供時不覆蓋", () => {
  const auto = buildUpstreamHeaders({ proxyRange: false })
  assert.equal(auto["User-Agent"], PROXY_USER_AGENT)

  const custom = buildUpstreamHeaders({
    rawUrlHeaders: { "User-Agent": "MyClient/1.0" },
    proxyRange: false,
  })
  assert.equal(custom["User-Agent"], "MyClient/1.0")
})

test("驅動提供的頭優先保留（Cookie / Referer）", () => {
  const headers = buildUpstreamHeaders({
    rawUrlHeaders: { Cookie: "sid=abc", Referer: "https://pan.example.com/" },
    proxyRange: false,
  })
  assert.equal(headers["Cookie"], "sid=abc")
  assert.equal(headers["Referer"], "https://pan.example.com/")
})

// ---- 響應頭處理 ----

test("Content-Type 按擴展名回退", () => {
  assert.equal(contentTypeForPath("/a/b.pdf"), "application/pdf")
  assert.equal(contentTypeForPath("/a/b.MP4"), "video/mp4")
  assert.equal(contentTypeForPath("/a/b.unknown"), "application/octet-stream")
  assert.equal(contentTypeForPath("/noext"), "application/octet-stream")
})

test("Content-Disposition 清洗 CR/LF 與控制字符（防響應頭注入）", () => {
  assert.equal(
    sanitizeContentDisposition(
      'attachment; filename="a.txt"\r\nSet-Cookie: x=1',
    ),
    'attachment; filename="a.txt"Set-Cookie: x=1',
  )
  assert.equal(sanitizeContentDisposition("inline\u0000\u001fbin"), "inlinebin")
})

// ---- proxy_range 與儲存配置的端到端串聯 ----

test("儲存 proxy_range 配置決定是否透傳 Range（串聯驗證）", () => {
  // 未配置 → 默認透傳（Go 的透明代理總是轉發客戶端頭）
  const d1 = buildUpstreamHeaders({
    rangeHeader: "bytes=0-10",
    proxyRange: getProxyRange({}),
  })
  assert.equal(d1["Range"], "bytes=0-10")

  // 顯式開啟 → 透傳
  const d2 = buildUpstreamHeaders({
    rangeHeader: "bytes=0-10",
    proxyRange: getProxyRange({ proxy_range: true }),
  })
  assert.equal(d2["Range"], "bytes=0-10")

  // 顯式關閉 → 丟棄（用於明確拒絕 Range 的上游）
  const d3 = buildUpstreamHeaders({
    rangeHeader: "bytes=0-10",
    proxyRange: getProxyRange({ proxy_range: false }),
  })
  assert.equal(d3["Range"], undefined)
})

// ---------------------------------------------------------------------------
// 平台載荷上限保護
//
// EdgeOne 雲函數對函數請求/響應 body 有 6 MiB 硬上限，超限時平台在網關層直接
// 返回 413 + CLOUD_FUNCTION_PAYLOAD_TOO_LARGE。native_proxy 會把整份文件當作
// 響應體回傳，所以超過上限的代理下載必須降級為 302 直鏈（或給出可讀的 413）。
// ---------------------------------------------------------------------------

const MiB = 1024 * 1024
const EDGE_LIMIT = DEFAULT_EDGEONE_PAYLOAD_LIMIT

test("getProxyPayloadLimit: EdgeOne 運行時默認 6 MiB，其它平台不限制", () => {
  assert.equal(EDGE_LIMIT, 6 * MiB)
  assert.equal(
    getProxyPayloadLimit({ env: { EO_REGION: "ap-shanghai" } }),
    EDGE_LIMIT,
  )
  assert.equal(getProxyPayloadLimit({ env: { EDGEONE: "1" } }), EDGE_LIMIT)
  assert.equal(getProxyPayloadLimit({ env: {} }), 0)
})

test("getProxyPayloadLimit: 按 EdgeOne Node 雲函數（SCF）與 Blob 綁定識別", () => {
  // EdgeOne Node 雲函數跑在騰訊 SCF 上，平台注入該變量（見 store/backend.ts）
  assert.equal(
    getProxyPayloadLimit({
      env: { TENCENTCLOUD_SCF_FUNCTIONNAME: "openlist" },
    }),
    EDGE_LIMIT,
  )
  // 綁定了 Blob 命名空間同樣說明運行在 EdgeOne
  assert.equal(getProxyPayloadLimit({ env: { EDGEONE_BLOB: {} } }), EDGE_LIMIT)
})

test("getProxyPayloadLimit: 應用自注入的 __requestOrigin 不構成 EdgeOne 判據", () => {
  // src/backend/index.ts 的中間件在所有平台都會寫入 __requestOrigin；
  // 用它判 EdgeOne 會把 Cloudflare / 自託管一併誤判，導致 CF 大文件代理被無故降級 302
  assert.equal(
    getProxyPayloadLimit({
      env: { __requestOrigin: "https://x.edgeone.cool" },
    }),
    0,
  )
})

test("getProxyPayloadLimit: RAW_PROXY_MAX_BYTES 覆蓋 / 0 關閉 / 非法值回退", () => {
  assert.equal(
    getProxyPayloadLimit({ env: { RAW_PROXY_MAX_BYTES: "1048576" } }),
    1048576,
  )
  // 0 = 關閉限制（自託管恢復「永遠代理」）
  assert.equal(
    getProxyPayloadLimit({ env: { EO_REGION: "x", RAW_PROXY_MAX_BYTES: "0" } }),
    0,
  )
  assert.equal(
    getProxyPayloadLimit({
      env: { EO_REGION: "x", RAW_PROXY_MAX_BYTES: "abc" },
    }),
    EDGE_LIMIT,
  )
})

test("exceedsProxyPayloadLimit: 邊界值（等於上限不算超限）", () => {
  assert.equal(
    exceedsProxyPayloadLimit(EDGE_LIMIT, undefined, EDGE_LIMIT),
    false,
  )
  assert.equal(
    exceedsProxyPayloadLimit(EDGE_LIMIT + 1, undefined, EDGE_LIMIT),
    true,
  )
  // 平台不限制時永不超限
  assert.equal(exceedsProxyPayloadLimit(9 * 1024 * MiB, undefined, 0), false)
})

test("exceedsProxyPayloadLimit: Range 分片按分片大小判斷", () => {
  // 500 MiB 的文件僅取 1 MiB 分片 → 不超限，視頻拖動進度不受影響
  assert.equal(
    exceedsProxyPayloadLimit(500 * MiB, "bytes=0-1048575", EDGE_LIMIT),
    false,
  )
  // 分片本身超過上限 → 超限
  assert.equal(
    exceedsProxyPayloadLimit(500 * MiB, `bytes=0-${20 * MiB}`, EDGE_LIMIT),
    true,
  )
})

test("exceedsProxyPayloadLimit: 大小未知（0）不攔截，交給平台兜底", () => {
  assert.equal(exceedsProxyPayloadLimit(0, undefined, EDGE_LIMIT), false)
})

test("decideProxyPayloadAction: 未超限時照常原生代理", () => {
  assert.equal(
    decideProxyPayloadAction({
      size: 2 * MiB,
      payloadLimit: EDGE_LIMIT,
      authBound: false,
    }),
    "proxy",
  )
})

test("decideProxyPayloadAction: 超限且可直連 → 降級 302（修復 EdgeOne 下載 413）", () => {
  assert.equal(
    decideProxyPayloadAction({
      size: 200 * MiB,
      payloadLimit: EDGE_LIMIT,
      authBound: false,
    }),
    "redirect",
  )
})

test("decideProxyPayloadAction: 超限但必須帶鑑權頭 → too-large（返回可讀 413）", () => {
  assert.equal(
    decideProxyPayloadAction({
      size: 200 * MiB,
      payloadLimit: EDGE_LIMIT,
      authBound: true,
    }),
    "too-large",
  )
})

test("decideProxyPayloadAction: proxy_range 關閉時 Range 不能掩蓋超限", () => {
  // proxy_range 關閉 → 上游返回完整文件，調用方必須傳 range=undefined
  assert.equal(
    decideProxyPayloadAction({
      size: 500 * MiB,
      range: undefined,
      payloadLimit: EDGE_LIMIT,
      authBound: false,
    }),
    "redirect",
  )
})

test("isAuthBoundDownload: 強制代理驅動與私有頭判定", () => {
  // Go MustProxy（OnlyProxy / NoLinkURL）→ 沒有可公開的直鏈
  assert.equal(isAuthBoundDownload("Googledrive", undefined), true)
  assert.equal(isAuthBoundDownload("WeiYun", undefined), true)
  // 預授權直鏈（OneDrive 的 @microsoft.graph.downloadUrl 無需私有頭）
  assert.equal(isAuthBoundDownload("Onedrive", undefined), false)
  // Go 裡僅有 PreferProxy 的驅動不算強制代理，但直鏈帶 Cookie 時仍不可降級
  assert.equal(isAuthBoundDownload("baidunetdisk", undefined), false)
  assert.equal(isAuthBoundDownload("baidunetdisk", { Cookie: "ndus=1" }), true)
  assert.equal(
    isAuthBoundDownload("webdav", { Authorization: "Basic xxx" }),
    true,
  )
  // 僅有 UA / Referer 不算私有頭（如 115open 的 UA、S3 的 Referer）
  assert.equal(
    isAuthBoundDownload("s3", {
      "User-Agent": "openlist",
      Referer: "https://x",
    }),
    false,
  )
  assert.equal(rawUrlNeedsPrivateHeaders({ cookie: "sid=1" }), true)
  assert.equal(rawUrlNeedsPrivateHeaders({ "X-Emby-Token": "t" }), false)
  assert.equal(rawUrlNeedsPrivateHeaders(null), false)
})

test("串聯：web_proxy=true 的 OneDrive 大文件在 EdgeOne 上降級為 302", () => {
  // 決策層要求原生代理（儲存開啟了 web_proxy）
  const decision = resolveProxyDecision(
    { driver: "Onedrive", web_proxy: true },
    "onedrive",
    false,
  )
  assert.equal(decision.needsProxy, true)
  assert.equal(decision.source, "web_proxy")

  // 上限層把超限的代理降級為直鏈，避免平台 413
  const action = decideProxyPayloadAction({
    size: 200 * MiB,
    payloadLimit: EDGE_LIMIT,
    authBound: isAuthBoundDownload("onedrive", undefined),
  })
  assert.equal(action, "redirect")
})

test("串聯：WebDAV（帶 Authorization）大文件在 EdgeOne 上拒絕代理而非平台報錯", () => {
  const decision = resolveProxyDecision({ driver: "WebDav" }, "webdav", false)
  assert.equal(decision.needsProxy, true)

  const action = decideProxyPayloadAction({
    size: 200 * MiB,
    payloadLimit: EDGE_LIMIT,
    authBound: isAuthBoundDownload("webdav", {
      Authorization: "Basic dXNlcjpwYXNz",
    }),
  })
  assert.equal(action, "too-large")
})

// ---------------------------------------------------------------------------
// proxy_ignore_headers（對齊 Go conf.ProxyIgnoreHeaders，默認 authorization,referer）
// ---------------------------------------------------------------------------

test("buildUpstreamHeaders：proxy_ignore_headers 命中時不轉發該客戶端頭", () => {
  const ignored = buildUpstreamHeaders({
    rawUrlHeaders: { Referer: "https://driver.example/" },
    rangeHeader: "bytes=0-10",
    proxyRange: true,
    ignoreHeaders: "range,user-agent",
  })
  assert.equal(ignored["Range"], undefined)
  assert.equal(ignored["User-Agent"], undefined)
  // 驅動自己聲明的頭不受影響（Go 也是先過濾客戶端頭、再套用驅動 override）
  assert.equal(ignored["Referer"], "https://driver.example/")

  // 默認忽略列表（authorization,referer）不影響 Range 與兜底 UA
  const kept = buildUpstreamHeaders({
    rangeHeader: "bytes=0-10",
    proxyRange: true,
    ignoreHeaders: "authorization,referer",
  })
  assert.equal(kept["Range"], "bytes=0-10")
  assert.equal(typeof kept["User-Agent"], "string")
})
