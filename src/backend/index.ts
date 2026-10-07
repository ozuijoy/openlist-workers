import { Hono } from "hono"
import { setupRouter } from "./server/router"
import { rawRouter } from "./server/raw"
import { assetsRouter, getIndexHtmlWithCdn, isCdnConfigured, cdnAssetRedirect } from "./server/assets"
import { webdavRouter } from "./server/webdav"
import { s3Router } from "./server/s3"
import { setEnvCtx } from "./internal/model/db"
import { getStoreConfigErrorDetail } from "./internal/model/store/backend"
import { storageErrorSummary, uiStorageError } from "./server/storage-error"

const app = new Hono()

/**
 * 靜態資源 / SPA 殼路徑：這些請求不應被儲存配置錯誤攔截，
 * 否則前端連提示頁面都加載不出來。
 */
function isStaticOrShell(pathname: string, accept: string, method: string): boolean {
  // 帶擴展名的靜態文件
  if (/\.[a-zA-Z0-9]+$/.test(pathname)) return true
  // 瀏覽器導航請求（HTML）由 SPA 殼承載
  if ((method === "GET" || method === "HEAD") && accept.includes("text/html")) {
    return true
  }
  return false
}

/**
 * 診斷類介面：必須豁免儲存配置錯誤攔截。
 *
 * 這類介面存在的意義就是「報告哪裡出了問題」。若在儲存出錯時把它們也
 * 一併 503 掉，調用方只會看到一個空洞的失敗，拿不到任何可操作信息
 * （前端表現為「只顯示儲存不可用，其餘欄位全部空白」）。
 *
 * 注意：豁免的是「攔截」，不是「鑑權」。這些介面本身仍是免鑑權的公開
 * 診斷端點，且只返回脫敏後的狀態，不洩露密鑰或 DSN。
 */
const DIAGNOSTIC_PATHS = [
  // 環境自檢：返回 config/storage/jwt/ready/issues 全量診斷
  "/api/public/env_check",
  // 初始化狀態：儲存不可用時必須能報告「未初始化」，否則前端無法
  // 判斷該停留在初始化嚮導還是跳轉登入頁。
  "/api/public/init_status",
  // 真實就緒探針：儲存故障時應由它自己給出結構化 503，
  // 而不是被中間件替換成通用錯誤。
  "/api/healthz",
]

function isDiagnosticPath(pathname: string): boolean {
  return DIAGNOSTIC_PATHS.includes(pathname)
}

/**
 * KV 代理傳輸端點（EdgeOne Edge Function 側由 functions/kv-* 提供）。
 *
 * 這些路徑是「驅動探測/讀寫」的傳輸層，不是業務請求，本 Worker 也不提供它們
 * （只有 EdgeOne Edge Function / CF Pages Functions 才有）。必須兩種情況都避開：
 *
 *   1. **不走儲存配置攔截**：kv 驅動的可用性判定就是向 `{origin}/kv-list` 發一次
 *      探測，而攔截邏輯會解析驅動 —— 若這些請求落進攔截，就會「探測請求 → 解析
 *      驅動 → 再探測自身」無限自調用（本地 `wrangler dev` 表現為滿屏
 *      `GET /kv-list 503`，且耗時隨嵌套層數不斷增長）。
 *   2. **不能落進 SPA 兜底**：兜底會返回 index.html（HTTP 200），探測會把
 *      「拿到 HTML」誤判成「KV 可用」，之後讀寫全部拿到 HTML 而報錯。
 *
 * 因此這裡顯式回 410：既明確說明本部署不提供該端點，也讓探測得到乾淨的失敗。
 */
const KV_PROXY_PATHS = ["/kv-list", "/kv-get", "/kv-put", "/kv-delete"]

function isKvProxyPath(pathname: string): boolean {
  return KV_PROXY_PATHS.includes(pathname)
}

app.use("*", async (c, next) => {
  // 關鍵：每個請求注入 KV binding 上下文（CF Workers 多實例/冷啟動時
  // 模塊級 globalEnvCtx 為 null，會導致 getDb()/saveDb() 退回記憶體模式，
  // 網盤賬號密碼與 access_token 無法從 KV 持久化讀取）
  //
  // EdgeOne 場景：KV 只能由 Edge Function 訪問，Node 雲函數需經 HTTP 代理
  // 調用 /kv-* 。而 Node 的 fetch 不接受相對 URL，因此這裡把當前請求的
  // origin 注入 env，供 kv 驅動拼出絕對地址（同一部署內自調用）。
  const env = (c.env || {}) as any
  try {
    const reqUrl = new URL(c.req.url)
    if (!env.__requestOrigin) {
      env.__requestOrigin = reqUrl.origin
    }
  } catch {
    // 忽略：無法解析時由驅動側回退處理
  }

  setEnvCtx(env)

  // 儲存配置錯誤全局攔截：任何依賴持久化的 API 都應立即得到明確錯誤，
  // 而不是靜默退回記憶體模式（表現為「操作成功但資料丟失」）。
  // 靜態資源與 SPA 殼放行，保證前端能加載並展示該錯誤。
  const { pathname } = new URL(c.req.url)
  const exempt =
    isStaticOrShell(pathname, c.req.header("accept") || "", c.req.method) ||
    isDiagnosticPath(pathname) ||
    // KV 代理傳輸端點：解析驅動會再探測自身，必須繞開（見 isKvProxyPath）
    isKvProxyPath(pathname)
  if (!exempt) {
    // 用 Detail 版本：除完整原因外還帶分類碼與一句話修復建議，前端據此
    // 展示「哪裡錯了 + 該改成什麼」。只給一段長文本時，用戶（和日誌讀者）
    // 能看到的只是「驅動不可用」，不知道該把 DB_DRIVER 改成什麼。
    const detail = await getStoreConfigErrorDetail(env)
    if (detail.message) {
      const ui = uiStorageError(detail)
      return c.json(
        {
          code: 503,
          // message 保持完整原因（相容既有客戶端與日誌排查）
          message: detail.message,
          data: {
            error: "STORAGE_CONFIG_ERROR",
            code: detail.code,
            configError: detail.message,
            // 界面展示 summary（完整一句短原因）+ suggestion（怎麼改）；
            // reason 是截斷後的完整說明，留給工具與日誌閱讀。
            summary: storageErrorSummary(detail.message),
            reason: ui.reason,
            suggestion: ui.suggestion,
          },
        },
        503,
      )
    }
  }

  await next()
})

// 在 Serverless 環境中，所有邏輯都是無狀態的且由請求觸發。
// 這裡不應該初始化任何常駐的後台任務 (如 Cron 或 執行緒池)。

// KV 代理傳輸端點：本部署不提供（只有 EdgeOne Edge Function / CF Pages
// Functions 的 functions/kv-* 提供）。顯式回 410，避免這些請求落進 SPA 兜底
// 被當成「HTTP 200」而讓 kv 驅動誤判為可用（詳見 isKvProxyPath 註釋）。
for (const path of KV_PROXY_PATHS) {
  app.all(path, (c) =>
    c.json(
      {
        code: 410,
        message:
          `KV proxy endpoint "${path}" is not served by this deployment. ` +
          `It only exists on EdgeOne Edge Functions (functions/kv-*) or ` +
          `Cloudflare Pages Functions. See /api/public/env_check for the ` +
          `storage backend actually in use.`,
        data: null,
      },
      410,
    ),
  )
}

// 掛載 API 到 /api
const api = new Hono()
setupRouter(api)
app.route("/api", api)

// Mount specific short paths at root for better compatibility
app.route("/d", rawRouter)
app.route("/sd", rawRouter)
app.route("/p", rawRouter)

// 內嵌品牌資源（logo/favicon），必須在 SPA 兜底 app.all("*") 之前掛載
app.route("/", assetsRouter)

// WebDAV 協議服務（/dav/*），必須在 SPA 兜底之前掛載
app.route("/dav", webdavRouter)

// S3 網關（/s3/*），必須在 SPA 兜底之前掛載
app.route("/s3", s3Router)

// SPA 兜底 HTML（由 EdgeOne 入口 api/_makers.ts 在構建期注入 dist/index.html；
// 其他平台入口不注入，保持原有 ASSETS / 404 行為）
let spaFallbackHtml: string | null = null

export function setSpaFallbackHtml(html: string) {
  spaFallbackHtml = html
}

app.all("*", async (c) => {
  const env = c.env as any
  const url = new URL(c.req.url)
  if (env && env.ASSETS && typeof env.ASSETS.fetch === "function") {
    const res = await env.ASSETS.fetch(c.req.raw)
    if (res.status >= 200 && res.status < 300) {
      // 修復「部署新版本後生產環境仍是舊界面」：index.html 若不設快取頭，
      // 會被 Cloudflare 邊緣/瀏覽器長期快取，導致舊 HTML 引用舊 hash 的 JS/CSS。
      // 只對 HTML 入口 no-cache（JS/CSS 帶 hash 可安全長期快取）。
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const headers = new Headers(res.headers)
        headers.set("Cache-Control", "no-cache, must-revalidate")
        headers.set("Content-Type", "text/html; charset=utf-8")
        // 未配置 ASSET_URLS 時零開銷直通：不改寫 HTML，流式透傳響應體
        if (!isCdnConfigured(env)) {
          return new Response(res.body, { status: res.status, headers })
        }
        // HTML 入口：注入 cdn 讓瀏覽器直連 CDN 取靜態資源。優先用本地 HTML
        // （CDN 上有同一套哈希時，npmmirror 這類不返回 .html 的 CDN 也能用），
        // 否則改用 CDN 自己的 index.html 保證哈希同源；都不可用則不注入。
        // body 會被讀成字符串，必須清掉編碼/長度頭，否則瀏覽器按「已編碼」解析明文。
        headers.delete("content-encoding")
        headers.delete("content-length")
        let html = await res.text()
        try {
          html = await getIndexHtmlWithCdn(env, html)
        } catch {
          // 注入失敗不影響 HTML 正常返回
        }
        return new Response(html, { status: res.status, headers })
      }
      return res
    }
    // 靜態層未命中：靜態資源目錄 302 到 CDN（對齊 Go 版 static.go 的 folders 重定向）。
    // 資源存在時靜態層已直接返回、Worker 不會執行，所以走到這裡說明源站確實沒有
    // 這個文件 —— 若不重定向，下面的 SPA 兜底會把 index.html 當作 .js/.css 返回，
    // 瀏覽器按 text/html 解析後報錯。
    const toCdn = await cdnAssetRedirect(env, url.pathname + url.search)
    if (toCdn) return c.redirect(toCdn, 302)
    // SPA fallback: return index.html for non-asset routes (e.g. /login, /manage)
    // 注意：ASSETS.fetch 對 /index.html 也可能返回 307，直接 fetch "/" 獲取實際 HTML
    const rootReq = new Request(`${url.origin}/`, c.req.raw)
    const rootRes = await env.ASSETS.fetch(rootReq)
    const headers = new Headers(rootRes.headers)
    headers.set("Content-Type", "text/html; charset=utf-8")
    // HTML 入口必須 no-cache，否則新版本部署後舊 HTML 仍引用舊 hash 的 JS/CSS
    headers.set("Cache-Control", "no-cache, must-revalidate")
    // 只有「已配置 CDN + 2xx + GET/HEAD」才改寫 HTML，其餘情況一律
    // 「狀態碼 + headers + body 流」原樣透傳：
    //   - 未配置 ASSET_URLS：零開銷直通，不把 body 讀成字符串再重建響應
    //     （否則每次深鏈刷新都白付一次緩衝，並丟掉流式透傳）；
    //   - 非 2xx（如 /index.html 的 307、兜底子請求的 404）：
    //     改寫會把狀態碼抹平成一個 200 + HTML 空殼，掩蓋真實錯誤；
    //   - 非 GET/HEAD：HTML 改寫只對頁面導航有意義。
    const rewritable =
      isCdnConfigured(env) &&
      rootRes.status >= 200 &&
      rootRes.status < 300 &&
      (c.req.method === "GET" || c.req.method === "HEAD")
    if (!rewritable) {
      return new Response(rootRes.body, { status: rootRes.status, headers })
    }
    // body 會被讀成字符串，必須清掉編碼/長度頭，否則瀏覽器按「已編碼」解析明文
    headers.delete("content-encoding")
    headers.delete("content-length")
    let html = await rootRes.text()
    try {
      html = await getIndexHtmlWithCdn(env, html)
    } catch {
      // 注入失敗不影響 SPA 兜底
    }
    return new Response(html, { status: rootRes.status, headers })
  }
  // EdgeOne 等 ASSETS 缺席的環境：靜態層未命中時同樣先嚐試 302 到 CDN，
  // 避免把 SPA 殼當作缺失的 .js/.css 返回
  const toCdnNoAssets = await cdnAssetRedirect(env, url.pathname + url.search)
  if (toCdnNoAssets) return c.redirect(toCdnNoAssets, 302)
  // EdgeOne 等 ASSETS 缺席的環境：直接返回構建期內聯的 SPA 殼，
  // 避免前端路由（/add、/@manage/* 等）落到 404 文本導致整站不可達
  if (spaFallbackHtml && (c.req.method === "GET" || c.req.method === "HEAD")) {
    // 未配置 ASSET_URLS 時直接返回構建期內聯的殼，省掉一次無意義的 async 調用；
    // 配置了則從 CDN 拉取並注入 —— 不修改模塊級 spaFallbackHtml，避免併發汙染。
    let html = spaFallbackHtml
    if (isCdnConfigured(env)) {
      try {
        html = await getIndexHtmlWithCdn(env, html)
      } catch {
        // 注入失敗時返回原始 SPA 殼
      }
    }
    return c.body(html, 200, {
      "Content-Type": "text/html; charset=utf-8",
      // HTML 入口必須 no-cache，否則新版本部署後舊 HTML 仍引用舊 hash 的 JS/CSS
      "Cache-Control": "no-cache, must-revalidate",
    })
  }
  return c.text("404 Not Found", 404)
})

export default app
