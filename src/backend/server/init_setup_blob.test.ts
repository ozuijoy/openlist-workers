import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { setupRouter } from "./router"

/**
 * 專用迴歸測試：EdgeOne / ESA Blob + DB_FORMAT=map 的空儲存首次初始化。
 *
 * 為什麼單獨一個文件：`memoryDb` / `dbTrusted` 是 isolate 級模塊狀態（與線上
 * 一致），同一進程裡先跑過「已初始化」的用例後，新的空後端會被判定為
 * 「可信快照仍存在」而複用舊快照（init/setup 於是返回 400 already initialized）。
 * 獨立文件 = 獨立進程，才能精確復現「全新部署第一次訪問」的初始狀態。
 *
 * 被鎖定的行為（issue #62 現象 3 的 EdgeOne 分支）：
 *   Blob 的 get 在鍵不存在時返回 null（不拋錯）→ loadDb 認為是
 *   「讀取成功但後端為空」→ 必須放行初始化，而不是 500 死鎖。
 */
const buildApp = () => {
  const api = new Hono()
  setupRouter(api)
  const app = new Hono()
  app.route("/api", api)
  return app
}

/** ESA Blob 形態的替身：get 返回 Response 形態對象，鍵不存在時返回 null。 */
function fakeBlob() {
  const store = new Map<string, string>()
  return {
    __store: store,
    get: async (key: string) => {
      const v = store.get(key)
      return v === undefined ? null : { text: async () => v }
    },
    put: async (key: string, value: string) => {
      store.set(key, String(value))
    },
    delete: async (key: string) => {
      store.delete(key)
    },
    head: async (key: string) => (store.has(key) ? { key } : null),
    list: async () => ({ keys: [...store.keys()].map((name) => ({ name })) }),
  }
}

test("EO/ESA Blob + map：全新空儲存的首次初始化必須成功", async () => {
  const env: any = {
    DB_DRIVER: "blob",
    DB_FORMAT: "map",
    JWT_SECRET: "0123456789abcdef0123456789abcdef",
    ESA_BLOB: fakeBlob(),
  }

  const res = await buildApp().request(
    "/api/public/init/setup",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin1234" }),
    } as any,
    env,
  )

  assert.equal(
    res.status,
    200,
    "Blob 空儲存必須先能通過嚮導初始化，否則會退化為永遠無法安裝",
  )
  assert.equal(
    env.ESA_BLOB.__store.has("openlist_config"),
    true,
    "初始化必須真正寫入 Blob",
  )

  // 寫入後同一實例應能讀到已初始化的庫。
  const status = await buildApp().request(
    "/api/public/init_status",
    { method: "GET" },
    env,
  )
  assert.equal((await status.json()).data.initialized, true)
})
