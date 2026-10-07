import { Hono } from "hono"
import { getDb, getStoreStatus } from "../internal/model/db"
import { checkAdminAuth } from "../pkg/utils"

export const debugRouter = new Hono()

debugRouter.get("/info", async (c) => {
  const isAdmin = await checkAdminAuth(c)
  const db = await getDb(c.env)

  const responseData: any = {
    runtime: "Cloudflare Workers / Edge",
    timestamp: new Date().toISOString(),
    // 後端驅動信息非敏感，未登入也返回，便於確認 D1/KV/MySQL 是否生效
    store: await getStoreStatus(c.env),
  }

  if (isAdmin) {
    responseData.db_state = {
      storages_count: db.storages?.length || 0,
      users_count: db.users?.length || 0,
      metas_count: db.metas?.length || 0,
      settings_count: db.settings?.length || 0,
    }
  }

  return c.json({
    code: 200,
    message: "OpenList debug profile generated",
    data: responseData,
  })
})
