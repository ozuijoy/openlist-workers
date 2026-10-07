// EdgeOne Makers 邊緣中間件：SPA 路由回退
//
// cloud-functions/[[default]].js（構建產物，見 scripts/build-edge.mjs）是根級
// catch-all，會接管所有未命中靜態文件的
// 請求（包括 /add、/@manage/* 等前端路由），而 Node 函數內沒有 ASSETS 綁定，
// Hono 兜底只能返回 404 —— 這就是「訪問 /add 404 後整站打不開」的原因。
// 此中間件在邊緣層先行攔截：瀏覽器導航請求（Accept: text/html）且不屬於
// 後端路徑時，透明改寫為 /index.html，由靜態 CDN 直接返回頁面殼；
// /api、/d、/p、/sd、/health 等後端路徑照常放行到雲函數。
//
// 注意：EdgeOne 的 middleware 屬於輕量中間件，context 僅提供
// request / next / redirect / rewrite / geo / clientIp，**沒有 env**，
// 因此無法訪問 KV 或環境變量。KV 代理請使用 functions/ 目錄下的
// Edge Functions（見 functions/kv-get 等），那裡才具備 KV 能力。
export function middleware(context) {
  const { request, next, rewrite } = context
  const { pathname } = new URL(request.url)
  const accept = request.headers.get("accept") || ""

  const isBackend =
    pathname === "/health" || /^\/(api|d|p|sd|kv-get|kv-put|kv-delete|kv-list)(\/|$)/.test(pathname)

  if (
    !isBackend &&
    (request.method === "GET" || request.method === "HEAD") &&
    accept.includes("text/html")
  ) {
    return rewrite("/index.html")
  }

  return next()
}
