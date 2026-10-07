import { Hono } from "hono"
import { getSettings, resolvePath } from "../internal/model/db"
import { parseRangeHeader } from "../internal/stream/stream"
import { flushPendingDriverState, getDriver } from "../internal/op/storage"
import { resolveShare } from "../internal/op/share"
import {
  needDownloadSign,
  verifyDownloadSign,
  signDownloadPath,
  getSignExpiresIn,
} from "../pkg/sign"
import { safeErrorMessage } from "../pkg/errs"
import { encodeDownloadPath } from "../pkg/path"
import { assertSafeUrl, getTrustedHosts } from "../pkg/http"
import {
  resolveProxyDecision,
  getDownProxyUrl,
  getDisableProxySign,
  canUseProxyEndpoint,
  normalizeExtList,
} from "../internal/driver/proxy"
import { getProxyRange } from "../internal/driver/storageopts"
import {
  buildUpstreamHeaders,
  shouldRetryWithoutRange,
  contentTypeForPath,
  sanitizeContentDisposition,
  decideProxyPayloadAction,
  exceedsProxyPayloadLimit,
  getProxyPayloadLimit,
  isAuthBoundDownload,
  upstreamBodySize,
} from "./proxy_request"

let fsPromises: any = null
let createReadStream: any = null

async function initNodeModules() {
  if (
    typeof process !== "undefined" &&
    process.release?.name === "node" &&
    !fsPromises
  ) {
    try {
      fsPromises = await import("fs/promises")
      createReadStream = (await import("fs")).createReadStream
    } catch (e) {}
  }
}

export const rawRouter = new Hono()

const getStorageRequestContext = (c: any) => {
  try {
    const executionCtx = c.executionCtx
    if (!executionCtx || typeof executionCtx.waitUntil !== "function") {
      return undefined
    }
    return {
      waitUntil: (promise: Promise<unknown>) => executionCtx.waitUntil(promise),
    }
  } catch {
    return undefined
  }
}

// 安全代理下載：手動跟隨重定向並逐跳做 SSRF 校驗。
// 關鍵修復：默認 fetch 會自動跟隨 3xx，導致攻擊者先讓 raw_url 指向一個
// 通過 isSafeUrl 校驗的公網域名，再用 302 跳到內網/雲元資料端點，繞過 SSRF。
// 這裡禁用自動重定向，對每一跳的 Location 重新斷言安全，並在跨域重定向時
// 剝離 Cookie/Authorization 等敏感頭，防止認證信息洩露給第三方。
const SAFE_REDIRECT_HEADER_KEYS = new Set([
  "range",
  "user-agent",
  "accept",
  "accept-language",
  "referer",
])

async function safeProxyFetch(
  url: string,
  headers: Record<string, string>,
  allowHosts?: ReadonlySet<string> | string[],
): Promise<Response> {
  const MAX_REDIRECTS = 5
  let current = url
  let currentHeaders = headers
  for (let i = 0; i < MAX_REDIRECTS; i++) {
    try {
      assertSafeUrl(current, "Proxy download", allowHosts)
    } catch (e: any) {
      throw new Error(e?.message || "SSRF blocked: restricted destination")
    }

    const res = await fetch(current, {
      headers: currentHeaders,
      redirect: "manual",
    })

    const location = res.headers.get("location")
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString()
      const next: Record<string, string> = {}
      for (const [k, v] of Object.entries(currentHeaders)) {
        if (SAFE_REDIRECT_HEADER_KEYS.has(k.toLowerCase()) && v) next[k] = v
      }
      currentHeaders = next
      continue
    }
    return res
  }
  throw new Error("Proxy download blocked: too many redirects")
}

/**
 * 平台上限導致的 413 文案。
 *
 * 說明「為什麼代理不了」與「有哪些替代路徑」，避免用戶只看到平台自帶的
 * CLOUD_FUNCTION_PAYLOAD_TOO_LARGE 錯誤頁（那裡沒有任何可操作信息）。
 * 措辭不寫死平台：限制可能來自 EdgeOne 的自動判定，也可能來自管理員配置的
 * RAW_PROXY_MAX_BYTES（例如 Vercel / 阿里雲 ESA 上的同類限制）。
 */
function payloadLimitMessage(c: any, label: string, size: number): string {
  const limit = getProxyPayloadLimit(c)
  const mib = (bytes: number) => Math.floor(bytes / 1024 / 1024)
  return (
    `文件過大，當前部署平台無法代理下載（${size} 字節 > 上限 ${limit} 字節 ≈ ${mib(limit)} MiB）。` +
    `當前運行環境對函數單次請求/響應 body 有硬上限（EdgeOne 雲函數為 6 MiB，錯誤碼 ` +
    `CLOUD_FUNCTION_PAYLOAD_TOO_LARGE / HTTP 413），` +
    `${label} 無法提供可直連的下載鏈接（或直鏈必須攜帶私有鑑權頭），只能經服務端轉發，` +
    `因此無法繞過該上限。` +
    `建議：改用返回公開直鏈的儲存、或在自託管環境（Docker / Node）部署；` +
    `確需放開限制可設置 RAW_PROXY_MAX_BYTES=0（或按平台實際上限調整該值）。`
  )
}

// 原生代理：拉取上游直鏈並回傳字節流（含 Range、快取頭、CORS）。
// 抽成獨立函數是因為「webdav_policy=use_proxy_url 但未配置 down_proxy_url」
// 與「驅動強制代理」兩種情況都需要走同一套實現。
async function proxyUpstream(
  c: any,
  fileItem: any,
  reqPath: string,
  trustedHosts?: ReadonlySet<string> | string[],
  opts: {
    /** 儲存的 proxy_range（是否透傳客戶端 Range） */
    proxyRange?: boolean
    /** 驅動名（用於強制代理判定與日誌） */
    driver?: string
    /** 儲存行（bunny_storage 等條件能力需要） */
    storage?: any
    /** 全局設置 proxy_ignore_headers */
    ignoreHeaders?: unknown
  } = {},
) {
  const proxyRange = opts.proxyRange ?? false
  const driver = opts.driver ?? ""
  // ---- 平台載荷上限保護 ----
  // native_proxy 會把整份文件當作雲函數響應體回傳，超過平台上限時請求根本到不了
  // 本函數（平台直接返回 413 錯誤頁），因此在這裡提前決策：能直連就降級 302，
  // 不能直連則返回可讀的 413。詳見 server/proxy_request.ts 頂部說明。
  const authBound = isAuthBoundDownload(
    driver,
    fileItem.raw_url_headers,
    opts.storage,
  )
  const payloadAction = decideProxyPayloadAction({
    size: Number(fileItem.size) || 0,
    // proxy_range 關閉時不透傳 Range，上游返回的是完整文件
    range: proxyRange ? c.req.header("Range") : undefined,
    payloadLimit: getProxyPayloadLimit(c),
    authBound,
  })

  if (payloadAction === "redirect") {
    try {
      assertSafeUrl(fileItem.raw_url, "Redirect download", trustedHosts)
    } catch (ssrfErr: any) {
      return c.text(ssrfErr.message || "SSRF blocked", 403)
    }
    console.warn(
      `[rawRouter] Falling back to 302 direct link for '${reqPath}': ${fileItem.size} bytes exceeds ` +
        `the ${getProxyPayloadLimit(c)}-byte payload limit of this runtime — native proxy would hit ` +
        `CLOUD_FUNCTION_PAYLOAD_TOO_LARGE`,
    )
    return c.redirect(fileItem.raw_url, 302)
  }

  if (payloadAction === "too-large") {
    console.warn(
      `[rawRouter] Refusing to proxy '${reqPath}': ${fileItem.size} bytes exceeds the ` +
        `${getProxyPayloadLimit(c)}-byte payload limit of this runtime and no direct link can be ` +
        `handed to the browser (driver=${driver}, authBound=${authBound})`,
    )
    return c.json(
      {
        code: 413,
        message: payloadLimitMessage(
          c,
          driver || "該儲存",
          Number(fileItem.size) || 0,
        ),
        data: null,
      },
      413,
    )
  }

  // 構造上游請求頭（含 proxy_range 的 Range 透傳決策 + proxy_ignore_headers）
  const headers: Record<string, string> = buildUpstreamHeaders({
    rawUrlHeaders: fileItem.raw_url_headers,
    rangeHeader: c.req.header("Range"),
    proxyRange,
    ignoreHeaders: opts.ignoreHeaders,
  })

  let upstreamRes: Response
  try {
    upstreamRes = await safeProxyFetch(fileItem.raw_url, headers, trustedHosts)
  } catch (ssrfErr: any) {
    return c.text(ssrfErr.message || "SSRF blocked", 403)
  }

  // 上游不支持 Range 的兜底：412（嚴格 OSS 校驗）或「帶 Range 卻回了 200」
  // 時去掉 Range 重試一次，保證請求最終能成功。
  // 注意：簽名綁定 URL 中的路徑與過期時間、與請求頭無關，故重試無需重新簽名。
  if (shouldRetryWithoutRange(headers, upstreamRes)) {
    console.warn(
      `[rawRouter] Upstream ignored/refused Range (status=${upstreamRes.status}) for '${reqPath}', retrying without Range header...`,
    )
    delete headers["Range"]
    upstreamRes = await safeProxyFetch(fileItem.raw_url, headers, trustedHosts)
  }

  // ---- 二次校驗：按上游實際回傳的大小再判一次 ----
  // 前面的檢查按「客戶端請求的分片」估算，但 Range 兜底重試（刪掉 Range 重試）
  // 或上游忽略 Range 直接回 200 時，回傳的是整份文件，可能遠超該估算值。
  // 這裡用上游的 Content-Length / Content-Range 複核，避免小分片請求把整份文件
  // 塞進雲函數響應體（EdgeOne 6 MiB → CLOUD_FUNCTION_PAYLOAD_TOO_LARGE）。
  const actualBodySize = upstreamBodySize(upstreamRes.headers)
  const secondCheck = decideProxyPayloadAction({
    size: actualBodySize,
    payloadLimit: getProxyPayloadLimit(c),
    authBound,
  })
  if (secondCheck !== "proxy") {
    // 只拿到了響應頭，先把上游 body 取消，避免繼續下載整份文件
    try {
      await upstreamRes.body?.cancel()
    } catch {}
    console.warn(
      `[rawRouter] Upstream body is ${actualBodySize} bytes after Range negotiation ` +
        `(status=${upstreamRes.status}) for '${reqPath}', which exceeds the ` +
        `${getProxyPayloadLimit(c)}-byte payload limit of this runtime — ` +
        `refusing to stream it (decision=${secondCheck}).`,
    )
    if (secondCheck === "redirect") {
      try {
        assertSafeUrl(fileItem.raw_url, "Redirect download", trustedHosts)
      } catch (ssrfErr: any) {
        return c.text(ssrfErr.message || "SSRF blocked", 403)
      }
      return c.redirect(fileItem.raw_url, 302)
    }
    return c.json(
      {
        code: 413,
        message: payloadLimitMessage(c, driver || "該儲存", actualBodySize),
        data: null,
      },
      413,
    )
  }

  // CORS headers
  c.header("Access-Control-Allow-Origin", "*")
  c.header("Access-Control-Allow-Methods", "GET, OPTIONS, HEAD")
  c.header(
    "Access-Control-Expose-Headers",
    "Content-Range, Accept-Ranges, Content-Length, Content-Disposition",
  )

  // Content-Type: prefer upstream, fallback by extension
  c.header(
    "Content-Type",
    upstreamRes.headers.get("content-type") || contentTypeForPath(reqPath),
  )

  // Forward range/length headers
  const contentLength = upstreamRes.headers.get("content-length")
  if (contentLength) c.header("Content-Length", contentLength)
  const contentRange = upstreamRes.headers.get("content-range")
  if (contentRange) c.header("Content-Range", contentRange)
  // Always advertise range support so video/audio players can seek
  c.header("Accept-Ranges", upstreamRes.headers.get("accept-ranges") || "bytes")

  // Forward caching headers
  const etag = upstreamRes.headers.get("etag")
  if (etag) c.header("ETag", etag)
  const lastModified = upstreamRes.headers.get("last-modified")
  if (lastModified) c.header("Last-Modified", lastModified)
  const cacheControl = upstreamRes.headers.get("cache-control")
  if (cacheControl) c.header("Cache-Control", cacheControl)
  // FIX(H-3): 上游響應頭已按白名單回顯，但對 Content-Disposition 額外
  // 清洗 CR/LF 與控制字符，防止惡意上游注入額外響應頭（Set-Cookie/Location）。
  const contentDisposition = upstreamRes.headers.get("content-disposition")
  if (contentDisposition) {
    c.header(
      "Content-Disposition",
      sanitizeContentDisposition(contentDisposition),
    )
  }

  return c.body(upstreamRes.body as any, upstreamRes.status as any)
}

/**
 * 構造 down_proxy_url 形式的下載地址（對齊 Go common.GenerateDownProxyURL）。
 *
 * Go 的實現是：
 *   fmt.Sprintf("%s%s%s", strings.Split(DownProxyURL, "\n")[0],
 *                        utils.EncodePath(reqPath, true), query)
 * 即**總是**把編碼後的真實路徑拼在模板之後、並在未禁用時補上 `?sign=`：
 *   - 模板裡沒有 `$path` 概念（全倉庫搜不到該佔位符）；TS 額外支持 `$path`
 *     替換，屬於向後相容的超集，無 `$path` 的模板行為與 Go 完全一致。
 *   - 補籤只看 `disable_proxy_sign`，**不限定同源**：down_proxy_url 的典型
 *     用法正是指向另一個域名（CDN / 前置代理 / 同實例的另一域名），此前
 *     只在"與請求同 host"時才補籤，會讓這類配置重定向到一個必然 401 的地址。
 *
 * 注意：模板不攜帶本服務實例的密鑰，因此 worker 場景下無法預先把簽名寫進模板，
 * 只能在運行時補籤。
 */
async function buildDownProxyUrl(
  c: any,
  template: string,
  reqPath: string,
  storage: any,
): Promise<string> {
  if (!template) return ""
  const encoded = encodeDownloadPath(reqPath)

  let url = template.includes("$path")
    ? template.replace(/\$path(?!\w)/g, encoded)
    : template.replace(/\/+$/, "") + encoded

  if (!getDisableProxySign(storage) && !/[?&]sign=/.test(url)) {
    try {
      const sign = await signDownloadPath(
        c,
        reqPath,
        await getSignExpiresIn(c),
      )
      if (sign) url += (url.includes("?") ? "&" : "?") + "sign=" + sign
    } catch (e: any) {
      console.warn(
        `[rawRouter] failed to sign down_proxy_url for '${reqPath}': ${e?.message || e}`,
      )
    }
  }
  return url
}

rawRouter.get("/*", async (c) => {
  await initNodeModules()

  const isProxy =
    c.req.query("proxy") === "true" ||
    c.req.path.startsWith("/p") ||
    c.req.path.startsWith("/api/p") ||
    c.req.path.startsWith("/sd") ||
    c.req.path.startsWith("/api/sd")

  // /p 是「公開代理端點」：Go 會對它做 canProxy() 檢查，不通過直接 403。
  // /d、/sd 不做該檢查（Go 裡它們走 ShouldProxy），因此這裡單獨判定。
  const isProxyEndpoint =
    c.req.path.startsWith("/p") || c.req.path.startsWith("/api/p")

  // Strip the route prefix once, preserving mount names such as /pikpak_webdav.
  const rawPath = c.req.path.replace(
    /^\/(?:api\/)?(?:raw|sd|d|p)(?=\/|$)/,
    "",
  )

  // 非法百分號轉義（如手工拼出的 `/api/p/100%.txt`）會讓 decodeURIComponent
  // 拋 URIError。Go 側因為 raw_url 走 EncodePath 編碼過 `%`，正常流程不會出現；
  // 但外部/手工 URL 仍可能出現，這裡按 400 處理而不是冒泡成 500。
  let reqPath0: string
  try {
    reqPath0 = decodeURIComponent(rawPath)
  } catch {
    return c.text("Bad Request: malformed path encoding", 400)
  }

  try {
    let reqPath = reqPath0
    // Share download: /sd/{shareId}/... — map to the real storage path
    const isSharePath =
      c.req.path.startsWith("/api/sd") || c.req.path.startsWith("/sd")
    if (isSharePath) {
      // 分享密碼優先從 cookie（browser-password）讀取，避免密碼出現在 URL 中；
      // 相容舊版 ?pwd= 參數（已有分享鏈接/收藏夾裡的舊鏈接仍可用）。
      const cookieHeader = c.req.header("Cookie") || ""
      const cookiePwdRaw =
        cookieHeader
          .split(";")
          .map((s) => s.trim())
          .find((s) => s.startsWith("browser-password="))
          ?.split("=")
          .slice(1)
          .join("=") || ""
      let cookiePwd: string
      try {
        cookiePwd = cookiePwdRaw ? decodeURIComponent(cookiePwdRaw) : ""
      } catch {
        cookiePwd = cookiePwdRaw
      }
      const sharePwd = c.req.query("pwd") || cookiePwd
      const shareRes = await resolveShare(reqPath, sharePwd, c.env)
      if (!shareRes.ok) {
        return c.text(shareRes.error || "Share not found", 404)
      }
      if (shareRes.virtualList || !shareRes.realPath) {
        return c.text("Cannot download share root", 400)
      }
      reqPath = shareRes.realPath
    } else {
      // 對齊 Go server/router.go：
      //   r.GET("/d/*path", middlewares.PathParse, middlewares.Down(sign.Verify), ...)
      //   r.GET("/p/*path", middlewares.PathParse, middlewares.Down(sign.Verify), ...)
      //
      // 這兩個端點**沒有 Auth 中間件**，是設計上的「公開下載端點」——
      // 直鏈要能被 <video src>、<img src>、播放器、下載器直接消費，而這些
      // 客戶端無法攜帶 Authorization 頭。訪問控制完全由 needSign 決定：
      // 需要簽名時校驗簽名，不需要時公開放行。
      //
      // 此前 TS 版在此處強制要求登入用戶，與 Go 不符：guest 存在時靠 guest
      // 兜底看不出問題，guest 一被禁用，列目錄/播放視頻就全部 401。
      if (await needDownloadSign(c, reqPath)) {
        const sign = c.req.query("sign") || ""
        const ok = await verifyDownloadSign(c, reqPath, sign)
        if (!ok) {
          return c.text("sign verify failed", 401)
        }
      }
    }

    const resolved = await resolvePath(reqPath)

    if (resolved.isVirtual || !resolved.physical) {
      return c.text("Cannot download virtual directory path", 400)
    }

    if (resolved.storage) {
      const normDriver = (resolved.storage.driver || "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")

      // 全局代理相關設置（對齊 Go：proxy_types / text_types / proxy_ignore_headers）。
      // 讀失敗時按空列表處理：proxy_types/text_types 為空只會讓擴展名規則不生效，
      // 不會誤攔既有請求。
      const settings: Record<string, any> = await getSettings().catch(
        () => ({}) as Record<string, any>,
      )
      const proxyTypes = normalizeExtList(settings.proxy_types)
      const textTypes = normalizeExtList(settings.text_types)
      const proxyOpts = {
        proxyRange: getProxyRange(resolved.storage),
        driver: resolved.storage.driver,
        storage: resolved.storage,
        ignoreHeaders: settings.proxy_ignore_headers,
      }

      // /p 是公開代理端點，對齊 Go handles.Proxy() 的 canProxy() 檢查：
      // 未開啟代理、且擴展名也不在 proxy_types / text_types 裡 → 403 proxy not allowed。
      // （Go 只對 /p 與歸檔 /ap 做此限制，/d、/sd 不做，故這裡僅判 /p 端點。）
      if (
        isProxyEndpoint &&
        !canUseProxyEndpoint({
          storage: resolved.storage,
          driver: normDriver,
          filename: reqPath,
          proxyTypes,
          textTypes,
        })
      ) {
        console.warn(
          `[rawRouter] proxy not allowed for '${reqPath}' ` +
            `(storage=${resolved.storage.id}, driver=${resolved.storage.driver})`,
        )
        return c.text("proxy not allowed", 403)
      }

      // Remote cloud drivers: fetch download link via driver.get()
      if (normDriver !== "local") {
        try {
          // 管理員配置的受信儲存 endpoint host（可能是內網自建 S3/WebDAV/MinIO），
          // 加上全局環境變量 SSRF_ALLOWED_HOSTS，合併為 SSRF 白名單，避免被誤攔截。
          const trustedHosts = getTrustedHosts(resolved.storage.addition, c.env)
          const driver = await getDriver(
            resolved.storage.driver,
            resolved.storage,
          )
          let fileItem
          try {
            fileItem = await driver.get(reqPath, resolved.physical)
          } finally {
            await flushPendingDriverState(
              resolved.storage.driver,
              resolved.storage,
              driver,
              getStorageRequestContext(c),
            )
          }

          if (fileItem && fileItem.raw_url) {
            // 下載模式決策：對齊 Go 的 ShouldProxy()/canProxy() + webdav_policy。
            //   - 驅動強制代理（MustProxy）> 儲存 web_proxy > /p、/sd 路徑 >
            //     儲存 webdav_policy > 驅動默認（PreferProxy）> 302_redirect
            // 儲存級 webdav_policy 從此真正生效（此前該欄位僅有表單、無邏輯）。
            const decision = resolveProxyDecision(
              resolved.storage,
              normDriver,
              isProxy,
              { filename: reqPath, proxyTypes },
            )

            // use_proxy_url：重定向到管理員配置的下載代理地址（注意與真實的
            // 代理模式區分，後者用 needsProxy 表達，避免誤落入 native_proxy）
            if (decision.mode === "use_proxy_url") {
              const downProxy = getDownProxyUrl(resolved.storage)
              if (downProxy) {
                const url = await buildDownProxyUrl(
                  c,
                  downProxy,
                  reqPath,
                  resolved.storage,
                )
                if (url) {
                  try {
                    assertSafeUrl(url, "Redirect download", trustedHosts)
                  } catch (ssrfErr: any) {
                    return c.text(ssrfErr.message || "SSRF blocked", 403)
                  }
                  console.log(
                    `[rawRouter] Redirecting download for '${reqPath}' to configured proxy url via ${resolved.storage.driver}`,
                  )
                  return c.redirect(url, 302)
                }
              }
              console.warn(
                `[rawRouter] webdav_policy=use_proxy_url but down_proxy_url is empty (storage=${resolved.storage.id}); falling back to native proxy`,
              )
              return proxyUpstream(
                c,
                fileItem,
                reqPath,
                trustedHosts,
                proxyOpts,
              )
            }

            if (decision.needsProxy) {
              return proxyUpstream(
                c,
                fileItem,
                reqPath,
                trustedHosts,
                proxyOpts,
              )
            }

            try {
              assertSafeUrl(fileItem.raw_url, "Redirect download", trustedHosts)
            } catch (ssrfErr: any) {
              return c.text(ssrfErr.message || "SSRF blocked", 403)
            }
            console.log(
              `[rawRouter] Redirecting download for '${reqPath}' via ${resolved.storage.driver}`,
            )
            return c.redirect(fileItem.raw_url, 302)
          } else if (
            typeof (driver as any).createReadStream === "function" &&
            fileItem &&
            !fileItem.is_dir
          ) {
            // 服務端回傳字節流（此分支沒有 raw_url，無法降級為直鏈）
            // → 同樣受平台響應體上限約束，超限時直接給出可讀的 413。
            const streamSize = Number(fileItem.size) || 0
            if (
              exceedsProxyPayloadLimit(
                streamSize,
                c.req.header("Range"),
                getProxyPayloadLimit(c),
              )
            ) {
              console.warn(
                `[rawRouter] Refusing to stream '${reqPath}': ${streamSize} bytes exceeds the ` +
                  `${getProxyPayloadLimit(c)}-byte payload limit of this runtime.`,
              )
              return c.json(
                {
                  code: 413,
                  message: payloadLimitMessage(
                    c,
                    resolved.storage.driver,
                    streamSize,
                  ),
                  data: null,
                },
                413,
              )
            }
            c.header("Access-Control-Allow-Origin", "*")
            const size = fileItem.size || 0
            const rangeHeader = c.req.header("Range")
            if (rangeHeader && size > 0) {
              const { start, end, chunksize } = parseRangeHeader(
                rangeHeader,
                size,
              )
              const stream = await (driver as any).createReadStream(
                resolved.physical,
                { start, end },
              )
              c.header("Content-Range", `bytes ${start}-${end}/${size}`)
              c.header("Accept-Ranges", "bytes")
              c.header("Content-Length", chunksize.toString())
              c.header("Content-Type", "application/octet-stream")
              return c.body(stream as any, 206)
            } else {
              if (size > 0) c.header("Content-Length", size.toString())
              c.header("Accept-Ranges", "bytes")
              c.header("Content-Type", "application/octet-stream")
              const stream = await (driver as any).createReadStream(
                resolved.physical,
              )
              return c.body(stream as any)
            }
          } else {
            const detail =
              fileItem?.raw_url_error ||
              (fileItem?.is_dir
                ? "該條目是文件夾，不可作為文件下載。"
                : "該儲存驅動未返回下載鏈接（raw_url 為空）。")
            return c.text(
              `File not found or no download link available: ${reqPath}\n${detail}`,
              404,
            )
          }
        } catch (e: any) {
          console.error(
            `[rawRouter] Driver get failed for '${reqPath}':`,
            e.message,
          )
          return c.text(`Download failed: ${safeErrorMessage(e)}`, 500)
        }
      }
    }

    // Fallback: Local file system streaming
    if (!fsPromises || !createReadStream) {
      return c.text("Local file streaming not supported in Edge Runtime", 500)
    }

    const stat = await fsPromises.stat(resolved.physical)
    if (stat.isDirectory()) {
      return c.text("Cannot download directory", 400)
    }

    // 本地文件直讀同樣受平台響應體上限約束（EdgeOne / Vercel 等 Serverless）
    if (
      exceedsProxyPayloadLimit(
        Number(stat.size) || 0,
        c.req.header("Range"),
        getProxyPayloadLimit(c),
      )
    ) {
      return c.json(
        {
          code: 413,
          message: payloadLimitMessage(c, "local", Number(stat.size) || 0),
          data: null,
        },
        413,
      )
    }

    c.header("Access-Control-Allow-Origin", "*")
    const rangeHeader = c.req.header("Range")
    if (rangeHeader) {
      const { start, end, chunksize } = parseRangeHeader(rangeHeader, stat.size)
      const stream = createReadStream(resolved.physical, { start, end })

      c.header("Content-Range", `bytes ${start}-${end}/${stat.size}`)
      c.header("Accept-Ranges", "bytes")
      c.header("Content-Length", chunksize.toString())
      c.header("Content-Type", "application/octet-stream")
      return c.body(stream as any, 206)
    } else {
      c.header("Content-Length", stat.size.toString())
      c.header("Accept-Ranges", "bytes")
      const stream = createReadStream(resolved.physical)
      return c.body(stream as any)
    }
  } catch (err: any) {
    console.error(`[rawRouter] Download 404 for '${reqPath0}':`, err.message)
    return c.text(`Not found: ${safeErrorMessage(err, "file not found")}`, 404)
  }
})
