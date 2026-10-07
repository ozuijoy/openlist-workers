import assert from "node:assert/strict"
import { test } from "node:test"
import { saveDb } from "../internal/model/db"
import {
  resolveCdnUrl,
  injectCdnIntoHtml,
  getIndexHtmlWithCdn,
  parseFrontendVersion,
  extractEntryAsset,
  cdnAssetRedirect,
} from "./assets"

const env: any = {}

/** 與官方前端產物同構的最小 HTML：含 OPENLIST_CONFIG 與動態 base 腳本 */
const INDEX_HTML = `<!doctype html>
<html>
  <head>
    <meta name="frontend-version" content="4.2.6">
    <script>
      window.OPENLIST_CONFIG = {
        cdn: undefined,
        base_path: undefined,
        api: undefined,
        main_color: undefined,
      }
      window.__dynamic_base__ = window.OPENLIST_CONFIG.cdn || ""
    </script>
    <script type="module" src="/assets/index-LOCAL.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>`

const LOCAL_HTML = INDEX_HTML.replace(
  '    <meta name="frontend-version" content="4.2.6">\n',
  "",
)

/** 在指定 fetch 實現下運行 fn，結束後恢復 globalThis.fetch */
async function withFetch(fn: any, impl: any) {
  const original = globalThis.fetch
  globalThis.fetch = impl as any
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

/**
 * 模擬 CDN 外呼。
 *   HEAD <cdn>/<asset>     → 資產存在性探測（asset=false 時 404）
 *   GET  <cdn>/index.html  → html=null 時 404，否則返回該 HTML
 * log 收集 "METHOD url" 便於斷言調用次數與順序。
 */
function cdnImpl(opts: { asset?: boolean; html?: string | null; log?: string[] }) {
  return async (url: string, init?: any) => {
    const method = (init?.method || "GET").toUpperCase()
    opts.log?.push(`${method} ${url}`)
    if (method === "HEAD") {
      return new Response(null, { status: opts.asset === false ? 404 : 200 })
    }
    if (opts.html === null) return new Response("not found", { status: 404 })
    return new Response(opts.html ?? INDEX_HTML, {
      status: 200,
      headers: { "content-type": "text/html" },
    })
  }
}

// ---------------------------------------------------------------- version stamp

test("parseFrontendVersion: 解析構建期版本戳", () => {
  assert.equal(parseFrontendVersion(INDEX_HTML), "4.2.6")
  assert.equal(parseFrontendVersion(LOCAL_HTML), "")
  assert.equal(parseFrontendVersion("<html></html>"), "")
})

// ------------------------------------------------------------- extractEntryAsset

test("extractEntryAsset: 取 preloads 裡的 module 入口", () => {
  const html = `<script>(function(){
var preloads = [{"parentTagName":"head","tagName":"script","attrs":{"type":"module","crossorigin":"","src":"/assets/index-CelfHslL.js"}},{"parentTagName":"head","tagName":"link","attrs":{"rel":"stylesheet","crossorigin":"","href":"/assets/index-MlAvXon-.css"}}];
})();</script>`
  assert.equal(extractEntryAsset(html), "/assets/index-CelfHslL.js")
})

test("extractEntryAsset: 退化取任意 /assets/*.js 引用", () => {
  assert.equal(
    extractEntryAsset('<script data-src="/assets/index-legacy-Exg5IBbL.js"></script>'),
    "/assets/index-legacy-Exg5IBbL.js",
  )
  assert.equal(
    extractEntryAsset("<script src=/assets/app-abc123.js></script>"),
    "/assets/app-abc123.js",
  )
})

test("extractEntryAsset: 無 /assets 引用時返回空串", () => {
  assert.equal(extractEntryAsset("<html><body>no assets</body></html>"), "")
})

// ---------------------------------------------------------------- resolveCdnUrl

test("resolveCdnUrl: 未配置 ASSET_URLS 返回空串", async () => {
  assert.equal(await resolveCdnUrl({}), "")
  assert.equal(await resolveCdnUrl({ ASSET_URLS: "" }), "")
})

test("resolveCdnUrl: 無 $version 時原樣返回（零儲存開銷）", async () => {
  const url = "https://cdn.example.com/dist"
  assert.equal(await resolveCdnUrl({ ASSET_URLS: url }), url)
})

test("resolveCdnUrl: $version 優先取 HTML 構建期版本戳", async () => {
  // 即使 DB 裡有 Frontend: v9.9.9，也應優先用與 dist 同源的 meta 版本
  await saveDb(
    {
      settings: [{ key: "version", value: "v4.2.3 - Frontend: v9.9.9" }],
      users: [],
      storages: [],
      shares: [],
    },
    env,
  )
  const got = await resolveCdnUrl(
    { ASSET_URLS: "https://cdn.example.com/@pkg@$version/dist" },
    INDEX_HTML,
  )
  assert.equal(got, "https://cdn.example.com/@pkg@4.2.6/dist")
})

test("resolveCdnUrl: 無版本戳時回退 DB 的 Frontend: 欄位", async () => {
  await saveDb(
    {
      settings: [
        {
          key: "version",
          value: "v4.2.3 (Commit: abc) - Frontend: v1.2.0 - Build at: 2026",
        },
      ],
      users: [],
      storages: [],
      shares: [],
    },
    env,
  )
  const got = await resolveCdnUrl(
    { ASSET_URLS: "https://cdn.example.com/@pkg@$version/dist" },
    LOCAL_HTML,
  )
  assert.equal(got, "https://cdn.example.com/@pkg@v1.2.0/dist")
})

test("resolveCdnUrl: 版本不可得時回退 latest", async () => {
  await saveDb(
    { settings: [], users: [], storages: [], shares: [] },
    env,
    { force: true },
  )
  const got = await resolveCdnUrl(
    { ASSET_URLS: "https://cdn.example.com/@pkg@$version/dist" },
    LOCAL_HTML,
  )
  assert.equal(got, "https://cdn.example.com/@pkg@latest/dist")
})

// ------------------------------------------------------------ cdnAssetRedirect

test("cdnAssetRedirect: 靜態資源目錄缺失時 302 到 CDN", async () => {
  // 對齊 Go 版 static.go 的 folders 重定向
  const env = { ASSET_URLS: "https://cdn.example.com/dist" }
  assert.equal(
    await cdnAssetRedirect(env, "/assets/index-abc.js"),
    "https://cdn.example.com/dist/assets/index-abc.js",
  )
  assert.equal(
    await cdnAssetRedirect(env, "/images/light.webp"),
    "https://cdn.example.com/dist/images/light.webp",
  )
  assert.equal(
    await cdnAssetRedirect(env, "/static/fonts/a.woff2?v=1"),
    "https://cdn.example.com/dist/static/fonts/a.woff2?v=1",
  )
})

test("cdnAssetRedirect: 非靜態目錄 / 未配置 CDN 時不重定向", async () => {
  assert.equal(await cdnAssetRedirect({}, "/assets/index-abc.js"), "")
  const env = { ASSET_URLS: "https://cdn.example.com/dist" }
  // 前端路由必須走 SPA 兜底，不能重定向到 CDN
  assert.equal(await cdnAssetRedirect(env, "/login"), "")
  assert.equal(await cdnAssetRedirect(env, "/@manage/storage"), "")
  // 目錄本身（無尾隨路徑）不重定向
  assert.equal(await cdnAssetRedirect(env, "/assets"), "")
  assert.equal(await cdnAssetRedirect(env, "/assets/"), "")
})

test("cdnAssetRedirect: $version 無本地 HTML 時按 env 解析", async () => {
  await saveDb(
    { settings: [], users: [], storages: [], shares: [] },
    env,
    { force: true },
  )
  const got = await cdnAssetRedirect(
    { ASSET_URLS: "https://cdn.example.com/@pkg@$version/dist" },
    "/assets/x.js",
  )
  assert.equal(got, "https://cdn.example.com/@pkg@latest/dist/assets/x.js")
})

// ------------------------------------------------------------- injectCdnIntoHtml

test("injectCdnIntoHtml: 替換 cdn: undefined，保留其它佔位符", () => {
  const out = injectCdnIntoHtml(INDEX_HTML, "https://cdn.example.com/dist")
  assert.doesNotMatch(out, /cdn: undefined/)
  assert.match(out, /cdn: 'https:\/\/cdn\.example\.com\/dist'/)
  assert.match(out, /base_path: undefined/)
  assert.match(out, /main_color: undefined/)
})

test("injectCdnIntoHtml: 空 cdn 原樣返回", () => {
  assert.equal(injectCdnIntoHtml(INDEX_HTML, ""), INDEX_HTML)
})

test("injectCdnIntoHtml: 無佔位符的 HTML 原樣返回", () => {
  const plain = "<html><body>no config</body></html>"
  assert.equal(injectCdnIntoHtml(plain, "https://cdn.example.com"), plain)
})

test("injectCdnIntoHtml: CDN URL 中的 $ 不被當作特殊模式", () => {
  const out = injectCdnIntoHtml(INDEX_HTML, "https://cdn.example.com/$$x/dist")
  assert.match(out, /cdn: 'https:\/\/cdn\.example\.com\/\$\$x\/dist'/)
})

test("injectCdnIntoHtml: CDN URL 中的引號 / 反斜槓被轉義", () => {
  // 注入值最終是內聯腳本里的 JS 字符串字面量：未轉義的 ' 會提前閉合字符串，
  // window.OPENLIST_CONFIG 語法報錯 -> 整站白屏。
  const cdn = "https://cdn.example.com/a'b\\c/dist"
  const out = injectCdnIntoHtml(INDEX_HTML, cdn)
  assert.doesNotMatch(out, /cdn: undefined/)
  const literal = out.match(/cdn:\s*('(?:[^'\\]|\\.)*')/)?.[1]
  assert.ok(literal, `注入結果中應存在 cdn 字面量，實際：${out}`)
  // 只考察字面量本身的語義：按 JS 轉義規則還原後必須等於原始 URL
  const decoded = literal.slice(1, -1).replace(/\\(.)/g, "$1")
  assert.equal(decoded, cdn, "字面量必須還原成原始 URL")
})

// ------------------------------------------------------------ getIndexHtmlWithCdn

test("getIndexHtmlWithCdn: 未配置 ASSET_URLS 時返回本地 HTML", async () => {
  const out = await withFetch(() => getIndexHtmlWithCdn({}, LOCAL_HTML), async () => {
    throw new Error("不應發起網路請求")
  })
  assert.equal(out, LOCAL_HTML)
})

test("getIndexHtmlWithCdn: 非 http(s) scheme 直接回退本地 HTML", async () => {
  const out = await withFetch(
    () => getIndexHtmlWithCdn({ ASSET_URLS: "ftp://cdn.example.com/dist" }, LOCAL_HTML),
    async () => {
      throw new Error("不應發起網路請求")
    },
  )
  assert.equal(out, LOCAL_HTML)
})

test("getIndexHtmlWithCdn: CDN 上有本地哈希資產時用本地 HTML（不拉 CDN 的 index.html）", async () => {
  // npmmirror 等禁止訪問 .html 的 CDN 只能靠這條路徑（等價 Go Release 版行為）
  const log: string[] = []
  const out = await withFetch(
    () =>
      getIndexHtmlWithCdn(
        { ASSET_URLS: "https://registry.npmmirror.com/@pkg/1.0.0/files/dist" },
        INDEX_HTML,
      ),
    cdnImpl({ asset: true, log }),
  )
  assert.deepEqual(log, [
    "HEAD https://registry.npmmirror.com/@pkg/1.0.0/files/dist/assets/index-LOCAL.js",
  ])
  // 下發的必須是本地 HTML（哈希與本地 dist 一致），且已注入 cdn
  assert.match(out, /index-LOCAL\.js/)
  assert.match(
    out,
    /cdn: 'https:\/\/registry\.npmmirror\.com\/@pkg\/1\.0\.0\/files\/dist'/,
  )
})

test("getIndexHtmlWithCdn: 本地哈希不在 CDN 上時改用 CDN 的 index.html（哈希同源）", async () => {
  const log: string[] = []
  const cdnHtml = INDEX_HTML.replace("index-LOCAL.js", "index-CDN.js")
  const out = await withFetch(
    () => getIndexHtmlWithCdn({ ASSET_URLS: "https://cdn-a.example.com/dist" }, LOCAL_HTML),
    cdnImpl({ asset: false, html: cdnHtml, log }),
  )
  assert.deepEqual(log, [
    "HEAD https://cdn-a.example.com/dist/assets/index-LOCAL.js",
    "GET https://cdn-a.example.com/dist/index.html",
  ])
  assert.match(out, /index-CDN\.js/)
  assert.match(out, /cdn: 'https:\/\/cdn-a\.example\.com\/dist'/)
})

test("getIndexHtmlWithCdn: 探測失敗且 CDN 攔截 .html 時降級為不注入", async () => {
  // npmmirror registry 端點：.html 返回 451 {"error":"blocked"}，資產探測也失敗
  const log: string[] = []
  const out = await withFetch(
    () =>
      getIndexHtmlWithCdn(
        { ASSET_URLS: "https://registry.npmmirror.com/@pkg/9.9.9/files/dist" },
        LOCAL_HTML,
      ),
    cdnImpl({ asset: false, html: null, log }),
  )
  assert.deepEqual(log, [
    "HEAD https://registry.npmmirror.com/@pkg/9.9.9/files/dist/assets/index-LOCAL.js",
    "GET https://registry.npmmirror.com/@pkg/9.9.9/files/dist/index.html",
  ])
  assert.equal(out, LOCAL_HTML)
  assert.match(out, /cdn: undefined/, "兩條路徑都不可用時絕不能注入失效地址")
})

test("getIndexHtmlWithCdn: 模塊級快取命中，不重複外呼", async () => {
  const log: string[] = []
  const url = "https://cdn-cache.example.com/dist"
  const impl = cdnImpl({ asset: true, log })
  const first = await withFetch(
    () => getIndexHtmlWithCdn({ ASSET_URLS: url }, INDEX_HTML),
    impl,
  )
  const second = await withFetch(
    () => getIndexHtmlWithCdn({ ASSET_URLS: url }, INDEX_HTML),
    impl,
  )
  assert.equal(first, second)
  assert.equal(log.length, 1, "第二次應命中快取")
})

test("getIndexHtmlWithCdn: CDN 不可達時回退本地 HTML 且【不注入】cdn（避免白屏）", async () => {
  const out = await withFetch(
    () => getIndexHtmlWithCdn({ ASSET_URLS: "https://cdn-down.example.com/dist" }, LOCAL_HTML),
    async () => {
      throw new Error("network error")
    },
  )
  assert.equal(out, LOCAL_HTML)
  assert.match(out, /cdn: undefined/, "CDN 不可用時絕不能注入失效地址，否則全量資產 404")
})

test("getIndexHtmlWithCdn: CDN 返回 404 / 非 HTML 時回退本地 HTML", async () => {
  const out404 = await withFetch(
    () =>
      getIndexHtmlWithCdn(
        { ASSET_URLS: "https://cdn-404.example.com/dist" },
        LOCAL_HTML,
      ),
    cdnImpl({ asset: false, html: null }),
  )
  assert.equal(out404, LOCAL_HTML)

  const outJson = await withFetch(
    () =>
      getIndexHtmlWithCdn(
        { ASSET_URLS: "https://cdn-json.example.com/dist" },
        LOCAL_HTML,
      ),
    async (url: string, init?: any) => {
      if ((init?.method || "GET").toUpperCase() === "HEAD") {
        return new Response(null, { status: 404 })
      }
      return new Response('{"error":"blocked"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  )
  assert.equal(outJson, LOCAL_HTML, "CDN 的 JSON 錯誤頁不能被當作 HTML 下發")
})

test("getIndexHtmlWithCdn: $version 用本地 HTML 的版本戳解析 CDN 地址", async () => {
  const log: string[] = []
  await withFetch(
    () =>
      getIndexHtmlWithCdn(
        { ASSET_URLS: "https://cdn-ver.example.com/@pkg@$version/dist" },
        INDEX_HTML,
      ),
    cdnImpl({ asset: false, log }),
  )
  assert.deepEqual(log, [
    "HEAD https://cdn-ver.example.com/@pkg@4.2.6/dist/assets/index-LOCAL.js",
    "GET https://cdn-ver.example.com/@pkg@4.2.6/dist/index.html",
  ])
})
