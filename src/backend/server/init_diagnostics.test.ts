import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { setupRouter } from "./router"
import { uiStorageError } from "./storage-error"
import {
  getStoreConfigErrorDetail,
  getStoreStatus,
} from "../internal/model/store/backend"

/**
 * 「問題必須能被用戶看見」的迴歸測試。
 *
 * 歷史現象：環境自檢顯示一切正常（ready=true），初始化卻返回一個沒有原因的
 * 500；用戶既不知道是組合寫錯、綁定沒配，還是後端讀不到。
 *
 * 因此這裡鎖定三件事：
 *   1. 無效「驅動 × 格式」組合被識別為 INVALID_COMBINATION 並給出支持列表；
 *   2. 驅動不可用時錯誤裡寫明需要什麼（逐驅動提示）；
 *   3. 這些原因通過 /env_check（issue + error_code）與 /init_status
 *      （storage_error / db_load_error）以及 /init/setup 的 data.code/reason
 *      透給前端。
 */

const JWT = "0123456789abcdef0123456789abcdef"

const buildApp = () => {
  const api = new Hono()
  setupRouter(api)
  const app = new Hono()
  app.route("/api", api)
  return app
}

const jsonPost = (body: any) =>
  ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as any

function fakeKv() {
  const store = new Map<string, string>()
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, String(v))
      return true
    },
    delete: async (k: string) => {
      store.delete(k)
    },
    list: async () => ({ keys: [...store.keys()] }),
  }
}

function fakeBlob() {
  const store = new Map<string, string>()
  return {
    get: async (k: string) => {
      const v = store.get(k)
      return v === undefined ? null : { text: async () => v }
    },
    put: async (k: string, v: string) => {
      store.set(k, String(v))
    },
    delete: async (k: string) => {
      store.delete(k)
    },
    head: async (k: string) => (store.has(k) ? { key: k } : null),
    list: async () => ({ keys: [...store.keys()].map((name) => ({ name })) }),
  }
}

test("無效組合：env_check 必須給出 STORAGE_INVALID_COMBINATION 與具體原因", async () => {
  const env: any = {
    DB_DRIVER: "kv",
    DB_FORMAT: "sql",
    JWT_SECRET: JWT,
    KV: fakeKv(),
  }

  // 解析階段就該拒絕，並說明該驅動支持哪些格式
  const status = await getStoreStatus(env)
  assert.equal(status.configErrorCode, "INVALID_COMBINATION")
  assert.match(String(status.configError), /Invalid storage combination/)
  assert.match(String(status.configError), /DB_FORMAT="sql"/)
  assert.match(String(status.configError), /supports: map \| key/)
  // 僅報錯、不自愈：不得偷偷換成別的驅動或格式
  assert.equal(status.driver, "none", "非法組合不得被自動解析成其它驅動")
  assert.equal(status.format, "none", "非法組合不得被自動改成別的格式")

  const res = await buildApp().request("/api/public/env_check", { method: "GET" }, env)
  const data = (await res.json()).data
  assert.equal(data.ready, false, "非法組合不得被報告為就緒")
  assert.equal(data.storage.available, false)
  assert.equal(data.storage.error_code, "INVALID_COMBINATION")
  assert.match(String(data.storage.error_message), /Invalid storage combination/)

  const issue = data.issues.find(
    (i: any) => i.code === "STORAGE_INVALID_COMBINATION",
  )
  assert.ok(issue, "必須給出專門的 issue 代碼，而不是籠統的配置錯誤")
  assert.match(String(issue.message), /Unsupported storage combination/)
  assert.ok(String(issue.docUrl).startsWith("http"))
})

test("無效組合：init/setup 的 500 必須帶上 code 與 reason（契約文案不變）", async () => {
  const env: any = {
    DB_DRIVER: "blob",
    DB_FORMAT: "sql",
    JWT_SECRET: JWT,
    ESA_BLOB: fakeBlob(),
  }

  const res = await buildApp().request(
    "/api/public/init/setup",
    jsonPost({ username: "admin", password: "admin1234" }),
    env,
  )
  assert.equal(res.status, 500)
  const json: any = await res.json()
  assert.equal(
    json.message,
    "database is not readable; refusing to initialize to avoid overwriting existing config",
    "對外 message 保持相容",
  )
  assert.equal(json.data?.code, "INVALID_COMBINATION")
  assert.match(String(json.data?.reason), /Invalid storage combination/)
  assert.match(
    String(json.data?.reason),
    /d1 \| do \| mysql/,
    "reason 要包含可操作的修復方向",
  )

  // 前端還可以通過輪詢 init_status 拿到同一原因
  const st = (await (
    await buildApp().request("/api/public/init_status", { method: "GET" }, env)
  ).json()).data
  assert.match(String(st.db_load_error), /Invalid storage combination/)
})

test("驅動不可用：錯誤必須寫明該驅動需要什麼（d1 示例）", async () => {
  const env: any = { DB_DRIVER: "d1", DB_FORMAT: "map", JWT_SECRET: JWT }

  const status = await getStoreStatus(env)
  assert.equal(status.configErrorCode, "DRIVER_UNAVAILABLE")
  // 逐驅動的前置條件（需要 d1_databases 綁定）寫在完整文案裡
  assert.match(String(status.configError), /d1_databases/)
  assert.match(
    String(status.configError),
    /^DB_DRIVER is set to "d1", but that driver is not available in this runtime\.$/m,
    "首行必須是一句完整的短原因：界面僅展示這一行",
  )

  const data = (await (
    await buildApp().request("/api/public/env_check", { method: "GET" }, env)
  ).json()).data
  assert.equal(data.storage.error_code, "DRIVER_UNAVAILABLE")
  assert.equal(
    data.storage.summary,
    `DB_DRIVER is set to "d1", but that driver is not available in this runtime.`,
    "summary 是給界面的一行短句",
  )
  // 介面僅透傳前 3 行，因此這 3 行必須是「原因 + 不回退 + 怎麼做」
  assert.match(
    String(data.storage.error_message),
    /No fallback is performed for an explicitly configured driver/,
  )
  assert.match(String(data.storage.error_message), /Check the binding\/credentials/)
  assert.ok(
    data.issues.some((i: any) => i.code === "STORAGE_CONFIG_ERROR"),
    "驅動不可用仍歸為配置錯誤",
  )
})

test("驅動不可用：錯誤裡必須給出「auto 會選誰」的可操作答案", async () => {
  // kv 不可用，但 Blob 可用：顯式配置不回退，但必須說清「改成什麼」。
  const env: any = {
    DB_DRIVER: "kv",
    DB_FORMAT: "map",
    JWT_SECRET: JWT,
    ESA_BLOB: fakeBlob(),
  }

  const status = await getStoreStatus(env)
  assert.equal(status.configErrorCode, "DRIVER_UNAVAILABLE")
  assert.match(
    String(status.configError),
    /Auto-detection would pick: DB_DRIVER=blob/,
    "必須告訴用戶改成什麼（而不是讓他自己猜）",
  )
})

test("驅動不可用：截斷展示的文案裡也必須保留「改成什麼」+ 結構化建議", async () => {
  // 前端僅拿到截斷後的 error_message / issue.message（見 server/storage-error.ts
  // 的 reasonLines：配置類錯誤僅透傳前 3 行）。若「Auto-detection would pick」
  // 被排在 message 末尾，用戶看到的仍是一段被砍斷的說明 —— 這正是「提示不友好」
  // 的根因，因此這裡同時鎖定順序與建議欄位。
  const env: any = {
    DB_DRIVER: "kv",
    DB_FORMAT: "map",
    JWT_SECRET: JWT,
    ESA_BLOB: fakeBlob(),
  }

  const data = (await (
    await buildApp().request("/api/public/env_check", { method: "GET" }, env)
  ).json()).data

  assert.match(
    String(data.storage.error_message),
    /Auto-detection would pick: DB_DRIVER=blob/,
    "答案必須落在被透傳的前 3 行裡，否則前端看到的還是一段被砍斷的說明",
  )
  assert.match(String(data.storage.suggestion), /DB_DRIVER=blob/)

  const issue = data.issues.find((i: any) => i.code === "STORAGE_CONFIG_ERROR")
  assert.ok(issue)
  assert.match(
    String(issue.suggestion),
    /DB_DRIVER=blob/,
    "issue 必須帶可展示的一行建議",
  )
  assert.ok(
    !String(issue.suggestion).includes("\n"),
    "建議必須是單行短句，否則又變成一段長文",
  )

  // 安裝嚮導僅有 init_status 可用（其餘介面被 503 攔截），它也要帶上建議
  const st = (await (
    await buildApp().request("/api/public/init_status", { method: "GET" }, env)
  ).json()).data
  assert.match(String(st.storage_suggestion), /DB_DRIVER=blob/)
})

test("503 攔截層：文案形狀為「截斷原因 + 單行建議」", async () => {
  // 全局中間件用 uiStorageError 組裝 data.reason / data.suggestion，
  // 與診斷介面共用同一套截斷規則，避免兩處粒度漂移。
  const env: any = {
    DB_DRIVER: "kv",
    DB_FORMAT: "map",
    JWT_SECRET: JWT,
    ESA_BLOB: fakeBlob(),
  }
  const detail = await getStoreConfigErrorDetail(env, { silent: true })
  const ui = uiStorageError(detail)

  assert.match(String(ui.reason), /Auto-detection would pick: DB_DRIVER=blob/)
  assert.match(String(ui.suggestion), /DB_DRIVER=blob/)
})

test("顯式配置的驅動不可用：絕不回退（即使 auto 能選到別的後端）", async () => {
  // 復現 issue #62 核心場景：CF 上寫了 DB_DRIVER=kv 卻沒綁 KV namespace，
  // 而 Blob 是可用的。按設計：**不回退**（否則資料會落到用戶沒指定的後端），
  // 判為配置錯誤 —— 依賴儲存的 API 會被 503 攔截，但必須把「改成什麼」講清楚。
  const env: any = {
    DB_DRIVER: "kv",
    DB_FORMAT: "map",
    JWT_SECRET: JWT,
    ESA_BLOB: fakeBlob(),
  }

  // 1) 仍然是配置錯誤：不得被自動切到 Blob
  const detail = await getStoreConfigErrorDetail(env, { silent: true })
  assert.equal(detail.code, "DRIVER_UNAVAILABLE")
  assert.match(
    String(detail.message),
    /No fallback is performed for an explicitly configured driver/,
  )
  const status = await getStoreStatus(env)
  assert.equal(status.driver, "none", "不得解析到其它驅動")
  assert.notEqual(status.driver, "blob", "絕不回退到 auto 會選中的後端")
  assert.equal(
    (status as any).fallback,
    undefined,
    "不得存在任何「降級/回退」狀態欄位",
  )

  // 2) 但原因與建議必須可展示：答案排進前 3 行 + 結構化 suggestion
  const data = (await (
    await buildApp().request("/api/public/env_check", { method: "GET" }, env)
  ).json()).data
  assert.equal(data.ready, false, "配置不可用時不得報 ready")
  assert.equal(data.storage.available, false)
  assert.equal(data.storage.error_code, "DRIVER_UNAVAILABLE")
  assert.match(String(data.storage.error_message), /Auto-detection would pick: DB_DRIVER=blob/)
  assert.match(String(data.storage.suggestion), /DB_DRIVER=blob/)
  assert.equal(
    data.storage.fallback_to,
    undefined,
    "診斷響應裡也不該出現回退欄位",
  )

  const issue = data.issues.find((i: any) => i.code === "STORAGE_CONFIG_ERROR")
  assert.ok(issue)
  assert.equal(issue.level, "error")
  assert.match(String(issue.suggestion), /DB_DRIVER=blob/)

  // 3) 安裝嚮導（僅有 init_status 可用）同樣拿得到建議
  const st = (await (
    await buildApp().request("/api/public/init_status", { method: "GET" }, env)
  ).json()).data
  assert.equal(st.initialized, false)
  assert.match(String(st.storage_error), /not available in this runtime/)
  assert.match(String(st.storage_suggestion), /DB_DRIVER=blob/)
})

test("CF 場景：DB_DRIVER=kv 但僅綁了 D1 —— 不回退，但明確告訴用戶改成 d1", async () => {
  // 用戶實際報的場景（僅配 DB_DRIVER/DB_FORMAT/JWT_SECRET，D1 是綁好的）：
  // 結論是「報錯 + 指路」，不是「偷偷改用 D1」。用戶改一個變量即可恢復，
  // 而資料始終落在他指定的後端上。
  const fakeD1 = {
    prepare: () => ({
      first: async () => ({ "1": 1 }),
      run: async () => ({}),
      all: async () => ({ results: [] }),
      bind: () => ({ first: async () => ({}), run: async () => ({}) }),
    }),
    batch: async () => [],
    exec: async () => ({}),
  }
  const env: any = {
    DB_DRIVER: "kv",
    DB_FORMAT: "map",
    JWT_SECRET: JWT,
    DB: fakeD1,
  }

  const detail = await getStoreConfigErrorDetail(env, { silent: true })
  assert.equal(detail.code, "DRIVER_UNAVAILABLE")
  assert.match(
    String(detail.suggestion),
    /Set DB_DRIVER=d1/,
    "必須直接給出可抄寫的答案",
  )
  assert.match(
    String(detail.message),
    /Auto-detection would pick: DB_DRIVER=d1/,
    "答案要落在被透傳的前 3 行裡",
  )

  const data = (await (
    await buildApp().request("/api/public/env_check", { method: "GET" }, env)
  ).json()).data
  assert.equal(data.storage.available, false, "不得回退到 D1")
  assert.match(String(data.storage.suggestion), /DB_DRIVER=d1/)
  assert.ok(
    data.issues.some((i: any) => i.code === "STORAGE_CONFIG_ERROR"),
    "必須是 error 級問題（這件事需要用戶處理，不能被當成警告略過）",
  )
})

test("init_status：儲存配置錯誤時必須返回 storage_error，而不是無聲的 false", async () => {
  const env: any = {
    DB_DRIVER: "blob",
    DB_FORMAT: "sql",
    JWT_SECRET: JWT,
    ESA_BLOB: fakeBlob(),
  }
  const data = (await (
    await buildApp().request("/api/public/init_status", { method: "GET" }, env)
  ).json()).data

  assert.equal(data.initialized, false)
  assert.equal(data.ready, false)
  assert.match(
    String(data.storage_error),
    /Invalid storage combination/,
    "前端據此解釋「為什麼不能初始化」",
  )
})

test("init_status：儲存正常時 storage_error 必須為 null（不產生誤導）", async () => {
  const env: any = {
    DB_DRIVER: "kv",
    DB_FORMAT: "map",
    JWT_SECRET: JWT,
    KV: fakeKv(),
  }
  const data = (await (
    await buildApp().request("/api/public/init_status", { method: "GET" }, env)
  ).json()).data
  assert.equal(data.storage_error, null)
})
