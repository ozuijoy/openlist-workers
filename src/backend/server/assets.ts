import { Hono } from "hono"
import { getDb } from "../internal/model/db"

/**
 * 品牌資源 + CDN 靜態資源路由。
 *
 * 背景：老前端（含 logo.svg / logo.png / favicon 靜態文件）已移除，前端統一
 * 由官方 OpenList-Frontend 產物提供，但官方產物不包含 /logo.png、/favicon.png
 * 等站點圖標；而 /api/public/settings 返回的 logo/favicon 欄位，以及早期已
 * 初始化資料庫裡保存的舊值，仍可能指向 /logo.png、/favicon.png 這些本地路徑，
 * 若直接 404 會導致圖標裂開。這裡統一 302 重定向到官方 CDN logo，相容多路徑，
 * 且始終跟隨官方最新 logo（不再內嵌舊 SVG 內容）。
 */

const LOGO_URL = "https://res.oplist.org/logo/logo.svg"

export const assetsRouter = new Hono()

function redirectToLogo(c: any) {
  return c.redirect(LOGO_URL, 302)
}

// 相容多種路徑（settings 或已初始化 DB 可能返回 /logo.png 與 /favicon.png；
// 瀏覽器默認請求 /favicon.ico；官方前端 index.html 引用 .svg）。統一重定向。
assetsRouter.get("/logo.svg", redirectToLogo)
assetsRouter.get("/logo.png", redirectToLogo)
assetsRouter.get("/favicon.svg", redirectToLogo)
assetsRouter.get("/favicon.png", redirectToLogo)
assetsRouter.get("/favicon.ico", redirectToLogo)

/**
 * 前端靜態資源 CDN 注入。
 *
 * 當配置了 ASSET_URLS 時，把 CDN 地址注入 index.html 的
 * window.OPENLIST_CONFIG.cdn；前端 vite-plugin-dynamic-base 讀取
 * window.__dynamic_base__（= cdn）後，瀏覽器直連 CDN 加載 JS/CSS/圖片等資源，
 * 不再經 Worker 中轉（對齊 Go 版 server/static/static.go）。
 *
 * 兩條路徑，按優先級排列：
 *
 *  A. 本地 index.html + CDN 資產（首選，等價 Go Release 版行為）
 *     僅當 CDN 上確實存在本地 HTML 引用的哈希資產時才採用。這條路徑【不要求
 *     CDN 能返回 HTML】—— npmmirror 等禁止訪問 .html 的 CDN 僅能走這條。
 *     官方文件明確：Release 版用內置 index.html，
 *     "Some NPM CDNs (like npmmirror) may prohibit access to HTML files,"
 *     "but Release versions dont depend on CDNs index.html, so they are unaffected"。
 *
 *  B. CDN 的 index.html（本地構建與 CDN 版本不一致時的兜底）
 *     前端產物是內容哈希文件名（/assets/index-XXXX.js），本地構建的 HTML 僅與
 *     本地構建的資產匹配。若本地 HTML 引用的哈希在 CDN 上不存在（$version 落到
 *     latest、或 dist 由 main 分支構建而版本戳仍是已發佈版本號），直接用本地
 *     HTML 會讓瀏覽器全量資產 404（白屏）。此時改用 CDN 自己的 index.html，
 *     HTML 與資產天然同源一致。
 *
 * 降級：兩條路徑都不可用時返回本地 HTML 且【不注入】cdn —— 資源回退源站加載，
 * 站點依然可用（寧可 CDN 不生效，不可白屏）。
 *
 * 另有靜態資源缺失兜底：源站沒有 /assets|images|streamer|static/ 下的文件時
 * 302 到 CDN（對齊 Go 版 static.go 的 folders 重定向），而不是把 SPA 殼當成
 * .js/.css 返回。
 *
 * 對 ASSET_URLS 的要求：資源由瀏覽器直接加載，CDN 必須對 .js/.css/字體返回
 * Access-Control-Allow-Origin（前端產物以 crossorigin 加載 module script /
 * stylesheet）。jsdelivr、unpkg 固定返回 *；npmmirror 在請求帶 Origin 時回顯
 * 該頭，瀏覽器場景下同樣可用。
 *
 * 示例：
 *   ASSET_URLS = https://registry.npmmirror.com/@openlist-frontend/openlist-frontend/$version/files/dist
 *   ASSET_URLS = https://cdn.jsdelivr.net/npm/@openlist-frontend/openlist-frontend@$version/dist
 *   ASSET_URLS = https://unpkg.com/@openlist-frontend/openlist-frontend@$version/dist
 */

/** CDN index.html 的模塊級快取：每個 isolate 每 TTL 最多一次外呼。
 *  TTL 兜底 @latest 這類會隨時間漂移的地址（快取過久的哈希會與新 latest 不匹配）。 */
const CDN_HTML_TTL_MS = 5 * 60_000
const cdnHtmlCache = new Map<string, { html: string; ts: number }>()

/** 讀取 ASSET_URLS 原文（env 優先，便於本地/Node 環境回退 process.env）。 */
function rawAssetUrls(env: any): string {
  return String(env?.ASSET_URLS || process.env?.ASSET_URLS || "")
}

/**
 * 是否配置了前端資源 CDN。
 *
 * 供 HTML 入口做零開銷直通判斷：未配置 CDN 時無需讀取/改寫 HTML，
 * 直接把靜態層的響應流式透傳，避免每個頁面導航都白付一次 body 緩衝與解析。
 */
export function isCdnConfigured(env: any): boolean {
  return Boolean(rawAssetUrls(env))
}

/**
 * 從 index.html 中解析構建期戳的前端版本（fetch-frontend.mjs 注入的 meta 標籤）。
 * 版本與 dist 同源產生，是 $version 最可靠的來源；無法解析時返回空串。
 */
export function parseFrontendVersion(html: string): string {
  const m = html.match(
    /<meta\s+name=["']frontend-version["']\s+content=["']([^"']+)["']/i,
  )
  return m ? m[1] : ""
}

/**
 * 解析 ASSET_URLS，替換 $version 佔位符。
 *
 * $version 解析優先級：
 *   1. 待下發 HTML 的構建期版本戳（meta frontend-version）—— 與部署的 dist 精確對應
 *   2. DB version 設置中的 "Frontend: vX.Y.Z"（相容手工設置）
 *   3. "latest"
 *
 * 無 $version 或未配置時零儲存開銷。
 */
export async function resolveCdnUrl(env: any, html?: string): Promise<string> {
  const raw = rawAssetUrls(env)
  if (!raw) return ""
  if (!raw.includes("$version")) return raw
  let version = ""
  if (html) version = parseFrontendVersion(html)
  if (!version) {
    try {
      const db = await getDb(env)
      const item = (db.settings || []).find((s: any) => s.key === "version")
      if (item?.value) {
        // 相容格式 "v4.2.3 (Commit: xxx) - Frontend: v1.0.0 - Build at: xxx"
        const m = String(item.value).match(/Frontend:\s*([^\s-]+)/)
        if (m) version = m[1]
      }
    } catch {
      // 儲存不可用 / 未初始化
    }
  }
  if (!version) version = "latest"
  return raw.replace(/\$version/g, version)
}

/**
 * 把已解析的 CDN 地址注入 HTML 的 window.OPENLIST_CONFIG.cdn。
 * 前端 vite-plugin-dynamic-base 讀取 window.__dynamic_base__（= cdn），
 * 據此前綴所有靜態資源 URL，實現從 CDN 加載。
 */
export function injectCdnIntoHtml(html: string, cdn: string): string {
  if (!cdn) return html
  // 1) 用函數替換，避免 cdn URL 裡的 $ 被 String.replace 當成特殊模式（$&、$1…）；
  // 2) 注入值是拼進內聯腳本的 JS 字符串字面量，必須轉義：URL 裡若出現 ' 或 \（
  //    或換行）會提前閉合字符串，讓 window.OPENLIST_CONFIG 語法報錯、整站白屏。
  //    注意 Go 版（fmt.Sprintf("cdn: '%s'")）沒有處理這一點，這裡不與它的缺陷對齊。
  const value = cdn
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
  return html.replace(/cdn:\s*undefined/, () => `cdn: '${value}'`)
}

/**
 * 靜態資源目錄。對齊 Go 版 server/static/static.go 的 folders —— 這些目錄下的
 * 請求在源站缺失時會被 302 到 CDN。
 */
const CDN_REDIRECT_FOLDERS = ["assets", "images", "streamer", "static"]

/** ASSET_URLS 原文 → 最近為 HTML 解析出的 CDN 地址（含 $version 替換結果）。
 *  靜態資源缺失時的 302 複用它，保證與 HTML 指向同一個版本。 */
const resolvedCdnCache = new Map<string, string>()

/**
 * 靜態資源在源站缺失時，給出應 302 到的 CDN 地址；不適用時返回空串。
 *
 * 對齊 Go 版 static.go：配置 cdn 後把 /assets/、/images/、/streamer/、/static/
 * 指向 CDN。Cloudflare 的資源優先路由下，資源存在時由靜態層直出、Worker 根本
 * 不會執行，所以這裡僅在源站確實缺失時才觸發 —— 此時若不重定向，SPA 兜底會把
 * index.html 當作 .js/.css 返回，瀏覽器按 text/html 解析後報錯。
 */
export async function cdnAssetRedirect(
  env: any,
  pathAndSearch: string,
): Promise<string> {
  const raw = rawAssetUrls(env)
  if (!raw) return ""
  // 必須是「目錄/具體文件」，目錄本身（/assets、/assets/）不重定向
  const m = pathAndSearch.match(/^\/([^/?#]+)\/(.+)/)
  if (!m || !CDN_REDIRECT_FOLDERS.includes(m[1])) return ""
  // 優先複用 HTML 那次解析結果；冷啟動直接命中資源時退回按 env 解析
  const cdn = resolvedCdnCache.get(raw) || (await resolveCdnUrl(env))
  if (!cdn || !/^https?:\/\//i.test(cdn)) return ""
  return `${cdn}${pathAndSearch}`
}

/**
 * 從 index.html 中取一個內容哈希資產路徑，用於驗證 CDN 與本地構建是否同一版本。
 *
 * 優先取 preloads 數組裡的 module 入口（現代構建一定存在），其次退化為任意
 * `/assets/*.js` 引用。取不到時返回空串，調用方跳過「本地 HTML」路徑。
 */
export function extractEntryAsset(html: string): string {
  const m =
    html.match(/"type"\s*:\s*"module"[^{}]*?"src"\s*:\s*"([^"]+)"/) ||
    html.match(/"(\/assets\/[^"]+\.js)"/) ||
    html.match(/(\/assets\/[A-Za-z0-9_.-]+\.js)/)
  return m ? m[1] : ""
}

/**
 * 探測 CDN 上是否存在該哈希資產。
 *
 * 用 HEAD 而非 GET：僅關心存在性，不下載 1MB+ 的 bundle。哈希文件名是內容
 * 尋址的，同一個文件在 CDN 與本地構建中的名字一致當且僅當內容一致，因此
 * 單個入口資產存在即可判定「本地 HTML 引用的整套哈希在 CDN 上都存在」。
 */
async function cdnHasAsset(cdn: string, assetPath: string): Promise<boolean> {
  try {
    const res = await fetch(`${cdn}${assetPath}`, {
      method: "HEAD",
      signal: AbortSignal.timeout(4000),
    })
    return res.ok
  } catch {
    // CDN 不可達 / 超時：按「不存在」處理，走 CDN 的 index.html 兜底
    return false
  }
}

/**
 * 獲取應下發的 index.html。
 *
 * A. 本地 HTML + CDN 資產：CDN 上存在本地 HTML 引用的哈希資產時採用。
 *    不要求 CDN 能返回 HTML，因此 npmmirror 這類禁止 .html 的 CDN 也能用
 *    （等價 Go Release 版行為）。
 * B. CDN 的 index.html：本地構建與 CDN 版本不一致時兜底，保證 HTML 與哈希資產
 *    同源一致。
 * C. 兩條都不可用 → 本地 HTML 原樣返回（不注入 cdn，資源回退源站，不白屏）。
 */
export async function getIndexHtmlWithCdn(
  env: any,
  localHtml: string,
): Promise<string> {
  const cdn = await resolveCdnUrl(env, localHtml)
  if (!cdn) return localHtml
  // 僅允許 http(s)，防止 ASSET_URLS 被配置成其它 scheme
  if (!/^https?:\/\//i.test(cdn)) return localHtml
  // 供靜態資源缺失時的 302 複用同一地址（見 cdnAssetRedirect）
  resolvedCdnCache.set(rawAssetUrls(env), cdn)
  const hit = cdnHtmlCache.get(cdn)
  if (hit && Date.now() - hit.ts < CDN_HTML_TTL_MS) return hit.html

  // A. 本地 HTML：先確認 CDN 上確實有這套哈希，避免本地構建與 CDN 版本不一致
  //    時把瀏覽器引到 404 上（那會比不注入更糟）。
  const entry = extractEntryAsset(localHtml)
  if (entry && (await cdnHasAsset(cdn, entry))) {
    const html = injectCdnIntoHtml(localHtml, cdn)
    cdnHtmlCache.set(cdn, { html, ts: Date.now() })
    return html
  }

  // B. CDN 的 index.html
  try {
    const res = await fetch(`${cdn}/index.html`, {
      headers: { accept: "text/html" },
      signal: AbortSignal.timeout(4000),
    })
    if (res.ok) {
      let html = await res.text()
      // 校驗確實是 HTML，而非 CDN 的 JSON 錯誤頁（如 npmmirror 的 451 blocked）
      if (/<html/i.test(html)) {
        html = injectCdnIntoHtml(html, cdn)
        cdnHtmlCache.set(cdn, { html, ts: Date.now() })
        return html
      }
    }
  } catch {
    // CDN 不可達 / 超時：回退源站
  }

  // C. 降級：不注入
  return localHtml
}

for (const folder of CDN_REDIRECT_FOLDERS) {
  assetsRouter.get(`/${folder}/*`, async (c, next) => {
    const location = await cdnAssetRedirect(
      c.env,
      c.req.path + new URL(c.req.url).search,
    )
    if (location) return c.redirect(location, 302)
    return next()
  })
}
