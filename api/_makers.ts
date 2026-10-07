import app, { setSpaFallbackHtml } from "../src/backend/index"
import INDEX_HTML from "../dist/index.html"

// 構建期內聯 dist/index.html：EdgeOne Node 雲函數沒有 ASSETS 綁定，
// 前端路由（/add、/@manage/* 等靜態不存在的路徑）會落到 Hono 兜底，
// 注入後由函數直接返回 SPA 殼（配合根級 middleware.js 的邊緣改寫雙保險）。
setSpaFallbackHtml(INDEX_HTML)

export function onRequest(context: any) {
  return app.fetch(context.request, context.env, context)
}

export default onRequest
