import { Hono } from "hono"
import { getDb, saveDb } from "../internal/model/db"
import { getDriver } from "../internal/op/storage"
import { adminAuthMiddleware, matchCronSecret } from "./middlewares"

export const taskRouter = new Hono()

// 定時任務調度介面：刷新所有已啟用網盤驅動的 Token / 狀態並持久化
// 僅管理員可觸發（防止未授權用戶探測儲存配置/觸發資源消耗）。
// EdgeOne Schedules 等平台調度器無法附加 Authorization 頭，
// 因此複用 JWT_SECRET 作為調度密鑰，調度請求可攜帶該密鑰
//（JSON body / query / X-Cron-Secret 頭）通過 matchCronSecret 放行。
taskRouter.all(
  "/refresh",
  async (c, next) => {
    if (await matchCronSecret(c)) return next()
    return adminAuthMiddleware(c, next)
  },
  async (c) => {
    const db = await getDb(c.env)
    let refreshed = 0
    let failed = 0
    const results: any[] = []

    for (const s of db.storages || []) {
      if (s.disabled) continue
      try {
        const driver = await getDriver(s.driver, s)
        await driver.init?.()
        // lanzou 驅動：主動校驗 Cookie 是否過期（有效期約 15 天），
        // 失效時標記 status=cookie_expired，管理後台可直接看到提示
        if (
          typeof (driver as any).checkCookieValid === "function" &&
          /lanzou/i.test(String(s.driver))
        ) {
          const check = await (driver as any).checkCookieValid()
          if (!check.valid) {
            s.status = "cookie_expired"
            failed++
            results.push({
              id: s.id,
              mount_path: s.mount_path,
              driver: s.driver,
              status: "cookie_expired",
              error: check.error || "Cookie expired",
            })
            continue
          }
        }
        s.status = "work"
        refreshed++
        results.push({
          id: s.id,
          mount_path: s.mount_path,
          driver: s.driver,
          status: "ok",
        })
      } catch (err: any) {
        failed++
        results.push({
          id: s.id,
          mount_path: s.mount_path,
          driver: s.driver,
          status: "failed",
          error: err?.message || String(err),
        })
      }
    }

    await saveDb(db, c.env)

    // FIX: this handler used to answer 200 even when every single refresh
    // failed. A scheduled job that silently 401s every night therefore looked
    // perfectly healthy — that is exactly how the SEV1 in the incident report
    // stayed invisible for 14 days. Returning non-2xx is what lets the
    // scheduler, an uptime probe, or a log-based alert actually fire.
    if (failed > 0) {
      return c.json(
        {
          code: 500,
          message: `token refresh failed: ${failed}/${refreshed + failed} storage(s) failed`,
          data: { refreshed, failed, total: db.storages?.length || 0, results },
        },
        500,
      )
    }

    return c.json({
      code: 200,
      message: "token refresh executed",
      data: { refreshed, failed, total: db.storages?.length || 0, results },
    })
  },
)

// In-memory or stateless placeholder for task management in serverless
const tasks: Record<string, any[]> = {
  upload: [],
  copy: [],
  move: [],
  offline_download: [],
}

// All task-management endpoints are admin-only (placeholder APIs that may
// later carry real file-operation metadata)
taskRouter.use("*", adminAuthMiddleware)

taskRouter.get("/:type/:state", (c) => {
  const type = c.req.param("type")
  const state = c.req.param("state") // "undone" | "done"
  const list = tasks[type] || []
  const filtered = list.filter((t) => (state === "done" ? t.done : !t.done))
  return c.json({
    code: 200,
    message: "success",
    data: filtered,
  })
})

taskRouter.post("/:type/clear_done", (c) => {
  const type = c.req.param("type")
  if (tasks[type]) {
    tasks[type] = tasks[type].filter((t) => !t.done)
  }
  return c.json({ code: 200, message: "success", data: null })
})

taskRouter.post("/:type/clear_succeeded", (c) => {
  const type = c.req.param("type")
  if (tasks[type]) {
    tasks[type] = tasks[type].filter((t) => t.state !== "succeeded")
  }
  return c.json({ code: 200, message: "success", data: null })
})

// 以下介面在 TS Worker 中無意義：TS 不維護持久非同步任務佇列，
// 所有文件操作均同步完成後立即返回。任務 ID / 進度 / 重試 / 取消
// 等生命週期管理由 Go 後端負責，此處明確返回 501。
const unsupportedTaskOp = (c: any) =>
  c.json(
    {
      code: 501,
      message:
        "task lifecycle operations (retry/cancel/delete) are not supported in the TS Worker runtime; " +
        "file operations execute synchronously and do not produce persistent tasks",
      data: null,
    },
    501,
  )

taskRouter.post("/:type/retry_failed", unsupportedTaskOp)
taskRouter.post("/:type/retry", unsupportedTaskOp)
taskRouter.post("/:type/retry_some", unsupportedTaskOp)
taskRouter.post("/:type/cancel", unsupportedTaskOp)
taskRouter.post("/:type/cancel_some", unsupportedTaskOp)
taskRouter.post("/:type/delete", unsupportedTaskOp)
taskRouter.post("/:type/delete_some", unsupportedTaskOp)
