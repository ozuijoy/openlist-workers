import { Hono } from "hono"
import { handleMcpJsonRpc } from "../internal/mcp/mcp"
import { adminAuthMiddleware } from "./middlewares"

export const mcpRouter = new Hono()

// MCP 端點要求管理員鑑權（當前為佔位實現，僅暴露工具 schema；
// 加鑑權防止未授權探測 / 未來接入真實能力時的越權訪問）
mcpRouter.use("*", adminAuthMiddleware)

mcpRouter.get("/sse", (c) => {
  c.header("Content-Type", "text/event-stream")
  c.header("Cache-Control", "no-cache")
  c.header("Connection", "keep-alive")

  return c.text(`event: endpoint\ndata: /api/mcp/messages\n\n`)
})

mcpRouter.post("/messages", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { method, id, params } = body

  if (!method) {
    return c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32600, message: "Invalid Request" },
        id: id || null,
      },
      400,
    )
  }

  const responseRpc = await handleMcpJsonRpc(method, id, params, c.env)
  const status = responseRpc.error ? 404 : 200
  return c.json(responseRpc, status)
})
