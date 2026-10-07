import assert from "node:assert/strict"
import { test } from "node:test"
import app, { setSpaFallbackHtml } from "../index"

/** 本地構建的 index.html（含構建期版本戳） */
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

/** 模擬 CDN 上的 index.html：哈希與本地不同（正是修復前 404 的根源） */
const CDN_HTML = INDEX_HTML.replace("index-LOCAL.js", "index-CDN.js")

// 模擬 Cloudflare Workers 的 ASSETS 靜態資源綁定
function makeFakeAssets() {
  return {
    fetch(req: Request) {
      const url = new URL(req.url)
      // / 與 /index.html 返回 SPA 殼；其它路徑 404（觸發 SPA 兜底）
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(INDEX_HTML, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      }
      return new Response("not found", { status: 404 })
    },
  }
}

const headers = { accept: "text/html,application/xhtml+xml" }

/** 在指定 fetch 實現下運行 fn（模擬 Worker 對 CDN 的外呼），結束後恢復 */
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
 */
function cdnImpl(opts: { asset?: boolean; html?: string | null; log?: string[] }) {
  return async (url: string, init?: any) => {
    const method = (init?.method || "GET").toUpperCase()
    opts.log?.push(`${method} ${url}`)
    if (method === "HEAD") {
      return new Response(null, { status: opts.asset === false ? 404 : 200 })
    }
    if (opts.html === null) return new Response("not found", { status: 404 })
    return new Response(opts.html ?? CDN_HTML, {
      status: 200,
      headers: { "content-type": "text/html" },
    })
  }
}

test("集成[本地 HTML 路徑]: CDN 有本地哈希時用本地 HTML，不拉 CDN 的 index.html", async () => {
  // npmmirror 等禁止訪問 .html 的 CDN 僅能靠這條路徑（等價 Go Release 版行為）
  const log: string[] = []
  const env = {
    ASSETS: makeFakeAssets(),
    ASSET_URLS: "https://registry.npmmirror.com/@pkg/4.2.6/files/dist",
  }
  const res = await withFetch(
    () => app.request("/", { headers }, env as any),
    cdnImpl({ asset: true, log }),
  )
  assert.equal(res.status, 200)
  assert.deepEqual(log, [
    "HEAD https://registry.npmmirror.com/@pkg/4.2.6/files/dist/assets/index-LOCAL.js",
  ])
  const html = await res.text()
  assert.match(html, /index-LOCAL\.js/)
  assert.doesNotMatch(html, /cdn: undefined/)
  assert.match(
    html,
    /cdn: 'https:\/\/registry\.npmmirror\.com\/@pkg\/4\.2\.6\/files\/dist'/,
  )
})

test("集成[CDN HTML 路徑]: 本地哈希不在 CDN 上時改用 CDN 的 index.html（哈希同源）", async () => {
  const log: string[] = []
  const env = { ASSETS: makeFakeAssets(), ASSET_URLS: "https://cdn-i1.example.com/dist" }
  const res = await withFetch(
    () => app.request("/", { headers }, env as any),
    cdnImpl({ asset: false, log }),
  )
  assert.equal(res.status, 200)
  assert.deepEqual(log, [
    "HEAD https://cdn-i1.example.com/dist/assets/index-LOCAL.js",
    "GET https://cdn-i1.example.com/dist/index.html",
  ])
  const html = await res.text()
  // 下發的必須是 CDN 的 HTML（含 CDN 的哈希），而非本地 HTML
  assert.match(html, /index-CDN\.js/)
  assert.doesNotMatch(html, /cdn: undefined/)
  assert.match(html, /cdn: 'https:\/\/cdn-i1\.example\.com\/dist'/)
  assert.match(html, /window\.__dynamic_base__/)
})

test("集成[靜態資源兜底]: 源站缺失的 /assets/* 302 到 CDN（對齊 Go 版）", async () => {
  const env = {
    ASSETS: makeFakeAssets(),
    ASSET_URLS: "https://cdn-redirect.example.com/dist",
  }
  const res = await withFetch(
    () =>
      app.request(
        "/assets/missing-chunk.js",
        { headers: { accept: "*/*" } },
        env as any,
      ),
    async () => {
      throw new Error("302 不應外呼 CDN")
    },
  )
  assert.equal(res.status, 302)
  assert.equal(
    res.headers.get("location"),
    "https://cdn-redirect.example.com/dist/assets/missing-chunk.js",
  )
})

test("集成[靜態資源兜底]: 前端路由不重定向，仍走 SPA 兜底", async () => {
  const env = {
    ASSETS: makeFakeAssets(),
    ASSET_URLS: "https://cdn-redirect2.example.com/dist",
  }
  const res = await withFetch(
    () => app.request("/login", { headers }, env as any),
    cdnImpl({ asset: true }),
  )
  assert.equal(res.status, 200)
  assert.match(await res.text(), /cdn: 'https:\/\/cdn-redirect2\.example\.com\/dist'/)
})

test("集成[降級]: 兩條路徑都不可用（CDN 攔截 .html）時不注入 cdn", async () => {
  const env = {
    ASSETS: makeFakeAssets(),
    ASSET_URLS: "https://registry.npmmirror.com/@pkg/9.9.9/files/dist",
  }
  const res = await withFetch(
    () => app.request("/", { headers }, env as any),
    cdnImpl({ asset: false, html: null }),
  )
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.match(html, /cdn: undefined/, "兩條路徑都不可用時必須回退源站資源")
})

test("集成[ASSETS 路徑]: 未配置 ASSET_URLS 時 / 原樣返回（cdn: undefined 保留）", async () => {
  const env = { ASSETS: makeFakeAssets() }
  const res = await withFetch(
    () => app.request("/", { headers }, env as any),
    async () => {
      throw new Error("不應發起網路請求")
    },
  )
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.match(html, /cdn: undefined/)
})

test("集成[零開銷直通]: 未配置 ASSET_URLS 時 HTML 入口流式透傳（不緩衝 body）", async () => {
  // 未配置 CDN 時不應把 HTML 讀成字符串再重建：那會讓每次頁面導航都白付一次
  // 緩衝與解析。這裡斷言 body 流被原樣透傳（同一對象），證明沒有走 text()。
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(INDEX_HTML))
      controller.close()
    },
  })
  const env = {
    ASSETS: {
      fetch: () =>
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    },
  }
  const res = await withFetch(
    () => app.request("/", { headers }, env as any),
    async () => {
      throw new Error("不應發起網路請求")
    },
  )
  assert.equal(res.status, 200)
  assert.equal(res.body, stream, "必須透傳靜態層的 body 流")
  assert.equal(res.headers.get("cache-control"), "no-cache, must-revalidate")
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8")
  assert.match(await res.text(), /cdn: undefined/)
})

test("集成[編碼頭]: 注入 cdn 時清掉 content-encoding/content-length", async () => {
  // HTML 被讀成字符串後重新構造響應，若保留 content-encoding: gzip，
  // 瀏覽器會把明文按 gzip 解析而報錯；content-length 同理必須重算。
  const env = {
    ASSETS: {
      fetch: () =>
        new Response(INDEX_HTML, {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-encoding": "gzip",
            "content-length": String(INDEX_HTML.length),
          },
        }),
    },
    ASSET_URLS: "https://cdn-i4.example.com/dist",
  }
  const res = await withFetch(
    () => app.request("/", { headers }, env as any),
    cdnImpl({ asset: true }),
  )
  assert.equal(res.status, 200)
  assert.equal(res.headers.get("content-encoding"), null)
  assert.equal(res.headers.get("content-length"), null)
  assert.match(
    await res.text(),
    /cdn: 'https:\/\/cdn-i4\.example\.com\/dist'/,
  )
})

test("集成[降級]: CDN 不可達時回退本地 HTML 且不注入 cdn（不白屏）", async () => {
  const env = { ASSETS: makeFakeAssets(), ASSET_URLS: "https://cdn-down.example.com/dist" }
  const res = await withFetch(
    () => app.request("/", { headers }, env as any),
    async () => {
      throw new Error("network error")
    },
  )
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.match(html, /cdn: undefined/, "CDN 故障時必須回退源站資源，而非注入失效地址")
})

test("集成[ASSETS 兜底]: SPA 路由 /login 同樣注入 cdn", async () => {
  const env = { ASSETS: makeFakeAssets(), ASSET_URLS: "https://cdn-i2.example.com/dist" }
  // /login 在 ASSETS 裡 404 -> 走 SPA 兜底 fetch "/" -> 再走 CDN 注入
  const res = await withFetch(
    () => app.request("/login", { headers }, env as any),
    cdnImpl({ asset: true }),
  )
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.match(html, /cdn: 'https:\/\/cdn-i2\.example\.com\/dist'/)
})

test("集成[spaFallbackHtml 路徑]: EdgeOne/ESA 無 ASSETS 綁定時注入 cdn", async () => {
  setSpaFallbackHtml(INDEX_HTML)
  const env = { ASSET_URLS: "https://cdn-i3.example.com/dist" }
  const res = await withFetch(
    () => app.request("/manage", { headers }, env as any),
    cdnImpl({ asset: true }),
  )
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.doesNotMatch(html, /cdn: undefined/)
  assert.match(html, /cdn: 'https:\/\/cdn-i3\.example\.com\/dist'/)
})

test("集成: $version 用構建期版本戳解析（不再落 latest）", async () => {
  const log: string[] = []
  const env = {
    ASSETS: makeFakeAssets(),
    ASSET_URLS:
      "https://cdn.jsdelivr.net/npm/@openlist-frontend/openlist-frontend@$version/dist",
  }
  const res = await withFetch(
    () => app.request("/", { headers }, env as any),
    cdnImpl({ asset: true, log }),
  )
  assert.equal(res.status, 200)
  assert.deepEqual(log, [
    "HEAD https://cdn.jsdelivr.net/npm/@openlist-frontend/openlist-frontend@4.2.6/dist/assets/index-LOCAL.js",
  ])
  const html = await res.text()
  assert.match(
    html,
    /cdn: 'https:\/\/cdn\.jsdelivr\.net\/npm\/@openlist-frontend\/openlist-frontend@4\.2\.6\/dist'/,
  )
})

test("集成[SPA 兜底]: 未配置 ASSET_URLS 時流式透傳 body 與狀態碼", async () => {
  // /login 在 ASSETS 裡 404 -> 走 SPA 兜底 fetch "/"。
  // 兜底不應把 body 讀成字符串再重建：那會讓每次深鏈刷新都白付一次緩衝，
  // 並丟掉靜態層的流式透傳。
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(INDEX_HTML))
      controller.close()
    },
  })
  const env = {
    ASSETS: {
      fetch: (req: Request) =>
        new URL(req.url).pathname === "/"
          ? new Response(stream, {
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8" },
            })
          : new Response("not found", { status: 404 }),
    },
  }
  const res = await withFetch(
    () => app.request("/login", { headers }, env as any),
    async () => {
      throw new Error("不應發起網路請求")
    },
  )
  assert.equal(res.status, 200)
  assert.equal(res.body, stream, "必須透傳靜態層的 body 流")
  assert.equal(res.headers.get("cache-control"), "no-cache, must-revalidate")
  assert.match(await res.text(), /cdn: undefined/)
})

test("集成[SPA 兜底]: 非 2xx 保留原狀態碼，不包裝成 200 空殼", async () => {
  // 兜底子請求（fetch "/"）返回 404 時，若仍構造 status: 200 的響應，會把真實
  // 錯誤掩蓋成「一個 200 的 HTML 空殼」，讓 4xx/5xx 排查失去線索。
  const env = {
    ASSETS: {
      fetch: () =>
        new Response("not found", {
          status: 404,
          headers: { "content-type": "text/plain" },
        }),
    },
  }
  const res = await withFetch(
    () => app.request("/login", { headers }, env as any),
    async () => {
      throw new Error("未配置 ASSET_URLS，不應發起網路請求")
    },
  )
  assert.equal(res.status, 404)
})

test("集成[SPA 兜底]: 配置 ASSET_URLS 時非 2xx 也不改寫（307 透傳）", async () => {
  const env = {
    ASSETS: {
      fetch: () =>
        new Response(null, { status: 307, headers: { location: "/index.html" } }),
    },
    ASSET_URLS: "https://cdn-i5.example.com/dist",
  }
  const res = await withFetch(
    () => app.request("/login", { headers }, env as any),
    async () => {
      throw new Error("非 2xx 不應觸發 CDN 注入")
    },
  )
  assert.equal(res.status, 307)
  assert.equal(res.headers.get("location"), "/index.html")
})
