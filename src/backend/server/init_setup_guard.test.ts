import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { setupRouter } from "./router"

/**
 * 初始化流程迴歸測試（對應 issue #62）。
 *
 * 三個必須長期成立的不變量：
 *   1. 「讀取持久化後端成功但為空」（全新部署）**必須允許** POST /init/setup，
 *      否則會出現「讀不到 → 不許初始化 → 永遠讀不到」的死鎖；
 *   2. 「讀取持久化後端失敗」**必須拒絕**初始化，避免把兜底空殼寫回儲存、
 *      覆蓋真實配置（資料庫被清空）；
 *   3. 配置了 ADMIN_PASS 時，安裝頁僅輪詢 /init_status 也應能完成初始化
 *      （否則表現為「配了 ADMIN_PASS 仍反覆跳 /@init」）。
 */

const buildApp = () => {
  const api = new Hono()
  setupRouter(api)
  const app = new Hono()
  app.route("/api", api)
  return app
}

/** 一個符合 Web KV 形態、內容可控的 KV binding 替身。 */
function fakeKv(overrides: Partial<Record<"get" | "put" | "delete" | "list", any>> = {}) {
  const store = new Map<string, string>()
  return {
    __store: store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, String(value))
      return true
    },
    delete: async (key: string) => {
      store.delete(key)
    },
    list: async () => ({ keys: [...store.keys()] }),
    ...overrides,
  }
}

function kvEnv(overrides: any = {}) {
  return {
    DB_DRIVER: "kv",
    DB_FORMAT: "map",
    JWT_SECRET: "0123456789abcdef0123456789abcdef",
    KV: fakeKv(),
    ...overrides,
  }
}

const setupRequest = (body: Record<string, any>) =>
  ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as any

test("init/setup：全新空儲存首次初始化必須成功並真正落盤", async () => {
  const env: any = kvEnv()
  const res = await buildApp().request(
    "/api/public/init/setup",
    setupRequest({ username: "admin", password: "admin1234", site_title: "My List" }),
    env,
  )

  assert.equal(
    res.status,
    200,
    "empty-but-readable backend must be initializable (issue #62 現象 3)",
  )
  const json: any = await res.json()
  assert.equal(json.code, 200)
  assert.equal(json.data, null)
  assert.equal(
    env.KV.__store.has("openlist_config"),
    true,
    "初始化必須真正寫入持久化後端",
  )

  // 初始化完成後 init_status 必須報告已初始化 + 密鑰就緒。
  const status = await buildApp().request(
    "/api/public/init_status",
    { method: "GET" },
    env,
  )
  const statusJson: any = await status.json()
  assert.equal(statusJson.data.initialized, true)
  assert.equal(statusJson.data.ready, true)
})

test("init/setup：讀取持久化後端失敗時必須拒絕（不得用空殼覆蓋真實配置）", async () => {
  const env: any = kvEnv({
    KV: fakeKv({
      get: async () => {
        throw new Error("kv unreachable")
      },
    }),
  })

  const res = await buildApp().request(
    "/api/public/init/setup",
    setupRequest({ username: "admin", password: "admin1234" }),
    env,
  )

  assert.equal(res.status, 500, "read failure must still be rejected")
  const json: any = await res.json()
  assert.match(String(json.message), /not readable/)
})

test("init_status：配置 ADMIN_PASS 時，安裝頁輪詢即可完成初始化", async () => {
  const env: any = kvEnv({ ADMIN_PASS: "auto-init-pass" })

  const res = await buildApp().request(
    "/api/public/init_status",
    { method: "GET" },
    env,
  )
  const json: any = await res.json()

  assert.equal(
    json.data.initialized,
    true,
    "ADMIN_PASS must take effect on the init page (issue #62 現象 2)",
  )
  assert.equal(
    env.KV.__store.has("openlist_config"),
    true,
    "自動初始化必須真正落盤",
  )

  // 冪等：再次輪詢不應產生額外變化，也不應報錯。
  const again = await buildApp().request(
    "/api/public/init_status",
    { method: "GET" },
    env,
  )
  assert.equal((await again.json()).data.initialized, true)
})

test("init_status：未配置 ADMIN_PASS 時不得寫入佔位庫", async () => {
  const env: any = kvEnv()
  await buildApp().request("/api/public/init_status", { method: "GET" }, env)

  // 注：initialized 的取值不做斷言 —— isolate 級記憶體裡可能已有別的 env 建立
  // 過的可信快照（loadDb 會保留它以避免誤判為「未初始化」），這是刻意行為。
  // 本用例僅鎖定「未配置 ADMIN_PASS 時不產生任何寫入」這一不變量。
  assert.equal(
    env.KV.__store.size,
    0,
    "未配置 ADMIN_PASS 時應等待安裝嚮導，而不是搶寫未初始化的佔位庫",
  )
})

test("KV 探測日誌：DB_DRIVER 為非 KV 驅動時不再輸出誤導性告警", async () => {
  // 該告警曾被誤讀為 500 的根因（審計日誌等路徑會觸發 KV 探測）。
  // 對 d1 部署而言 KV 探測本就無關，不應再產生這條日誌。
  const warns: string[] = []
  const original = console.warn
  console.warn = (...args: any[]) => {
    warns.push(args.map((a) => String(a)).join(" "))
  }
  try {
    const { getKvBinding } = await import("../internal/model/store/json")
    await getKvBinding({ DB_DRIVER: "d1" })
  } finally {
    console.warn = original
  }

  assert.equal(
    warns.some((w) => w.includes("no KV-style binding found")),
    false,
    "d1 部署不應看到 KV 探測告警",
  )
})
