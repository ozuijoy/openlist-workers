import { Hono } from "hono"
import { cors } from "hono/cors"
import { getDb, getKvStatus } from "../internal/model/db"
import { isServerlessRuntime, NO_STORAGE_MESSAGE } from "../internal/model/store/backend"
import { fsRouter } from "./fs"
import {
  authRouter,
  meRouter,
  meHandler,
  meUpdateHandler,
  logoutHandler,
} from "./auth"
import { adminRouter } from "./admin"
import { rawRouter } from "./raw"
import { publicRouter } from "./public"
import { mcpRouter } from "./mcp"
import { debugRouter } from "./debug"
import { shareRouter } from "./share"
import { taskRouter } from "./task"
import { ssoRouter } from "./sso"
import { webauthnRouter } from "./webauthn"
import { updatePwdHandler } from "./user"

// --- 盡力而為的進程內限流 ---
// 實現管理後台的 ip_limit（每 IP 每分鐘請求數）與 traffic_limit（每 IP 每小時
// 響應流量 MB）。Cloudflare Workers 多實例下各隔離區獨立計數（非全局精確），
// 但能顯著限制單實例上的濫用/拉流/暴力請求；配合登入防爆破共同生效。
const ipReqCounts = new Map<string, { start: number; count: number }>()
const ipTraffic = new Map<string, { start: number; bytes: number }>()

function getClientIp(c: any): string {
  return (
    c.req.header("CF-Connecting-IP") ||
    c.req.header("x-real-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  )
}

function cleanupMaps() {
  const now = Date.now()
  if (ipReqCounts.size > 20000) {
    for (const [k, v] of ipReqCounts) {
      if (now - v.start > 60000) ipReqCounts.delete(k)
    }
  }
  if (ipTraffic.size > 20000) {
    for (const [k, v] of ipTraffic) {
      if (now - v.start > 3600000) ipTraffic.delete(k)
    }
  }
}

async function rateLimitMiddleware(c: any, next: () => Promise<void>) {
  const ip = getClientIp(c)
  const now = Date.now()
  let ipLimit = 0
  let trafficLimitMb = 0
  try {
    const db = await getDb(c.env)
    const settings: Record<string, string> = {}
    for (const s of db.settings || []) settings[s.key] = s.value
    ipLimit = parseInt(settings.ip_limit, 10) || 0
    trafficLimitMb = parseInt(settings.traffic_limit, 10) || 0
  } catch {}
  cleanupMaps()

  // 1) IP 請求速率限制（每分鐘）
  if (ipLimit > 0) {
    const rec = ipReqCounts.get(ip)
    if (!rec || now - rec.start > 60000) {
      ipReqCounts.set(ip, { start: now, count: 1 })
    } else {
      rec.count += 1
      if (rec.count > ipLimit) {
        return c.json(
          { code: 429, message: "Too many requests, slow down", data: null },
          429,
        )
      }
    }
  }

  // 2) 流量限制（每小時，按響應 Content-Length 估算；超限後拒絕後續請求）
  if (trafficLimitMb > 0) {
    const tRec = ipTraffic.get(ip)
    const limitBytes = trafficLimitMb * 1024 * 1024
    if (tRec && now - tRec.start <= 3600000 && tRec.bytes >= limitBytes) {
      return c.json(
        { code: 429, message: "Traffic limit exceeded", data: null },
        429,
      )
    }
  }

  await next()

  // Query-token 洩露緩解：URL 攜帶 token/access_token 的響應禁用快取並
  // 阻止 Referer 外洩（防止 token 經瀏覽器歷史/Referer/代理快取洩露）
  if (c.req.query("token") || c.req.query("access_token")) {
    c.res?.headers?.set("Referrer-Policy", "no-referrer")
    c.res?.headers?.set("Cache-Control", "no-store, no-cache, must-revalidate")
    c.res?.headers?.set("Pragma", "no-cache")
  }

  if (trafficLimitMb > 0) {
    const len = parseInt(c.res?.headers?.get("content-length") || "0", 10) || 0
    if (len > 0) {
      const tRec = ipTraffic.get(ip)
      if (!tRec || now - tRec.start > 3600000) {
        ipTraffic.set(ip, { start: now, bytes: len })
      } else {
        tRec.bytes += len
      }
    }
  }
}

export function setupRouter(app: Hono) {
  // 限流：讀取管理後台 ip_limit / traffic_limit 設置，盡力而為
  app.use("*", rateLimitMiddleware)

  // 審計日誌：記錄所有狀態修改操作 (添加日期: 2026-09-05)
  app.use("*", async (c, next) => {
    const { auditMiddleware } = await import("./middlewares")
    return auditMiddleware(c, next)
  })

  // 安全響應頭：防止點擊劫持 / MIME 嗅探 / XSS / 引用洩露
  app.use("*", async (c, next) => {
    await next()
    c.res.headers.set("X-Frame-Options", "DENY")
    c.res.headers.set("X-Content-Type-Options", "nosniff")
    c.res.headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'",
    )
    c.res.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    )
    c.res.headers.set("Referrer-Policy", "no-referrer")
  })

  // CORS Middleware
  // 安全策略：不再回顯任意 Origin。
  // 1) 若配置了環境變量 ALLOW_URLS（逗號分隔），僅放行白名單來源；
  // 2) 否則僅放行同源請求（Origin 與請求 Host 一致，即瀏覽器直連本站）。
  //    跨域來源的瀏覽器請求將被拒絕，降低 CSRF/憑證濫用風險。
  app.use(
    "*",
    cors({
      origin: (origin, c) => {
        if (!origin) return origin
        const env = (c as any).env || {}
        const allowedOriginsRaw =
          env.ALLOW_URLS ||
          (typeof process !== "undefined"
            ? process.env?.ALLOW_URLS
            : "") ||
          ""
        const allowedOrigins = allowedOriginsRaw
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean)
        if (allowedOrigins.length > 0) {
          return allowedOrigins.includes(origin) ? origin : null
        }
        // 無白名單配置時：僅同源
        const host = c.req.header("host") || ""
        try {
          const u = new URL(origin)
          if (u.host === host) return origin
        } catch {}
        return null
      },
      allowHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      exposeHeaders: ["Content-Length", "Content-Type"],
      maxAge: 600,
      credentials: true,
    }),
  )

  // API core sub-routing (mounted at /api by the parent)
  app.route("/raw", rawRouter)
  app.route("/fs", fsRouter)
  app.route("/auth", authRouter)
  app.route("/public", publicRouter)
  app.route("/admin", adminRouter)
  app.route("/mcp", mcpRouter)
  app.route("/debug", debugRouter)
  app.route("/share", shareRouter)
  app.route("/task", taskRouter)
  app.route("/auth", ssoRouter)
  app.route("/authn", webauthnRouter)

  // Direct short-paths for compatibility
  app.route("/d", rawRouter)
  app.route("/sd", rawRouter)
  app.route("/p", rawRouter)

  // Current user handler queried directly by the frontend
  app.route("/me", meRouter)
  app.get("/me", meHandler)
  app.post("/me/update", meUpdateHandler)
  app.post("/user/update_pwd", updatePwdHandler)
  app.get("/logout", logoutHandler)
  app.post("/logout", logoutHandler)

  // Simple service health check — includes version/brand so you can verify
  // the deployed Worker is running the latest build (dev vs prod consistency)
  app.get("/health", (c) =>
    c.json({
      ok: true,
      name: "OpenList",
      version: "v4.2.3",
      environment: (c.env as any)?.ENVIRONMENT || "development",
    }),
  )

  // Real readiness probe.
  //
  // /health above is a liveness marker only — it answers ok:true unconditionally
  // and proves nothing about whether this deployment can actually serve files.
  // It is kept unchanged because external monitors may already depend on it,
  // but it must never be treated as a health signal.
  //
  // /healthz exercises the state layer for real: it reads the config through
  // the same KV path a request would and answers 503 when a configured
  // persistence layer is failing. "No KV configured" is reported as healthy
  // with mode="memory" — this covers Vercel, Lambda, and Docker-in-memory
  // deployments where persistence is intentionally absent.
  app.get("/healthz", async (c) => {
    const checks: Record<string, any> = {}
    let healthy = true

    try {
      const db = await getDb(c.env)
      checks.config = {
        ok: true,
        storages: db?.storages?.length ?? 0,
        users: db?.users?.length ?? 0,
      }
    } catch (err: any) {
      healthy = false
      checks.config = { ok: false, error: err?.message || String(err) }
    }

    let kv: any
    try {
      kv = await getKvStatus(c.env)
    } catch (err: any) {
      healthy = false
      kv = {
        configured: false,
        connected: false,
        error: err?.message || String(err),
      }
    }

    checks.persistence = {
      configured: !!kv?.configured,
      connected: !!kv?.connected,
      platform: kv?.platform ?? null,
      error: kv?.error ?? null,
    }
    // Serverless / Worker runtimes must never fall back to memory: instances
    // are multi-tenant and short-lived, so writes silently vanish and users
    // see "saved successfully" for data that does not exist. Report that as
    // unhealthy so monitors and the UI both surface it.
    const serverless = isServerlessRuntime(c.env)
    if (!kv?.configured) {
      checks.persistence.mode = serverless ? "unavailable" : "memory"
      if (serverless) {
        checks.persistence.note = NO_STORAGE_MESSAGE
        healthy = false
      } else {
        checks.persistence.note =
          "No persistence configured — changes are ephemeral"
      }
    }
    // If KV is configured but failing, that's a real outage.
    if (kv?.configured && !kv?.connected) {
      healthy = false
    }

    return c.json(
      {
        ok: healthy,
        name: "OpenList",
        version: "v4.2.3",
        environment: (c.env as any)?.ENVIRONMENT || "development",
        checks,
      },
      healthy ? 200 : 503,
    )
  })
}
