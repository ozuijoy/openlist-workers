import { Hono } from "hono"
import { handle } from "hono/vercel"
import backendApp from "../src/backend/index"

const app = new Hono()

// 掛載整個後端 API 應用
app.route("/", backendApp)

// 導出符合 EdgeOne Makers / Edge Functions / Pages 規範的 onRequest 句柄
export async function onRequest(context: any) {
  return app.fetch(context.request, context.env, context)
}

// 導出符合 Vercel 規範的 Serverless 句柄
export const GET = handle(app)
export const POST = handle(app)
export const PUT = handle(app)
export const DELETE = handle(app)
export const PATCH = handle(app)
export const OPTIONS = handle(app)

// 導出 Cloudflare Workers 原生 Fetch 句柄
export default {
  fetch: app.fetch,
}
