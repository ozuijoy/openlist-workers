import assert from "node:assert/strict"

import { test } from "node:test"
import { Hono } from "hono"
import { setupRouter } from "./router"
import { getStoreStatus } from "../internal/model/store/backend"

/**
 * 三條常見部署約束的迴歸測試。
 *
 * 背景：部署文件給出三條「必須滿足」的約束，但檢查邏輯此前有兩處與之不符：
 *
 *   1. blob 只支持 map（blob 是「整存整取的單文件」儲存，攤平成多條鍵的 key
 *      格式在 blob 上寫不出、也 list 不出真實結構）。
 *      舊實現只做「能力探測」（有沒有 get/put/delete/list），因此 blob + key
 *      被誤判為合法組合，要等到真正讀寫才炸。
 *
 *   2. JWT_SECRET「必須手動配置」其實不準確 —— 支持自動生成並持久化。
 *      但舊實現存在**自死鎖**：`ready = storageAvailable && jwtReady`，
 *      而自動生成只在提交初始化時執行，嚮導卻被 ready 擋住進不到那一步；
 *      且 JWT 側讀的是 openlist_jwt_secret、自動生成寫的是
 *      openlist_encryption_secret，兩個槽位名不同 → 「自動生成」永遠不可見。
 *
 *   3. 合法的「驅動 × 格式」矩陣應只有：
 *        blob + map
 *        kv / cfkv + map / key
 *        d1 / do / mysql + map / key / sql
 *      其餘皆為無效組合。
 */

const JWT = "0123456789abcdef0123456789abcdef"

const buildApp = () => {
  const api = new Hono()
  setupRouter(api)
  const app = new Hono()
  app.route("/api", api)
  return app
}

function fakeKv() {
  const store = new Map<string, string>()
  return {
    __store: store,
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
    __store: store,
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

// ─────────────────────────────────────────────────────────────────────────────
// 約束 1：blob 只支持 map
// ─────────────────────────────────────────────────────────────────────────────

test("blob + map：合法組合（ESA_BLOB 已綁定時不應報組合錯誤）", async () => {
  const env: any = {
    DB_DRIVER: "blob",
    DB_FORMAT: "map",
    JWT_SECRET: JWT,
    ESA_BLOB: fakeBlob(),
  }
  const status = await getStoreStatus(env)
  assert.notEqual(
    status.configErrorCode,
    "INVALID_COMBINATION",
    "blob + map 是文件明確支持的組合，不得判為非法",
  )
})

test("blob + key：必須判為 INVALID_COMBINATION（blob 是單文件儲存，不支持 key）", async () => {
  const env: any = {
    DB_DRIVER: "blob",
    DB_FORMAT: "key",
    JWT_SECRET: JWT,
    ESA_BLOB: fakeBlob(),
  }

  const status = await getStoreStatus(env)
  assert.equal(
    status.configErrorCode,
    "INVALID_COMBINATION",
    "blob 只支持 map；key 會把對象攤平成多條鍵，而 blob 只能整存整取",
  )
  assert.match(String(status.configError), /DB_FORMAT="key"/)
  // 支持列表必須精確到該驅動，而不是籠統的「map | key」
  assert.match(
    String(status.configError),
    /supports: map/,
    "錯誤裡必須指出 blob 只支持 map",
  )

  const res = await buildApp().request(
    "/api/public/env_check",
    { method: "GET" },
    env,
  )
  const data = (await res.json()).data
  assert.equal(data.ready, false, "無效組合不得被報告為就緒")

  const issue = data.issues.find(
    (i: any) => i.code === "STORAGE_INVALID_COMBINATION",
  )
  assert.ok(issue, "必須給出 STORAGE_INVALID_COMBINATION")
  // 約束 4：必須帶一句話修復建議（此前該分支 suggestion 為 null）
  assert.ok(
    issue.suggestion && String(issue.suggestion).length > 0,
    "無效組合必須給出「改成什麼」的建議，否則用戶只知道錯、不知道怎麼辦",
  )
  assert.match(String(issue.suggestion), /DB_FORMAT=map/)
})

test("blob + sql：必須判為 INVALID_COMBINATION", async () => {
  const env: any = {
    DB_DRIVER: "blob",
    DB_FORMAT: "sql",
    JWT_SECRET: JWT,
    ESA_BLOB: fakeBlob(),
  }
  const status = await getStoreStatus(env)
  assert.equal(status.configErrorCode, "INVALID_COMBINATION")
})

// ─────────────────────────────────────────────────────────────────────────────
// 約束 3：合法「驅動 × 格式」矩陣
// ─────────────────────────────────────────────────────────────────────────────

test("合法矩陣：僅文件列出的組合被接受，其餘皆 INVALID_COMBINATION", async () => {
  // 每個驅動都在 env 裡把所需 binding/憑據全部提供，確保「拒絕」只可能來自
  // 組合校驗本身，而不是驅動不可用（DRIVER_UNAVAILABLE）等其它原因。
  const baseEnv: any = {
    JWT_SECRET: JWT,
    ESA_BLOB: fakeBlob(),
    KV: fakeKv(),
    DB: {
      prepare: () => ({
        bind: () => ({ all: async () => ({ results: [] }), run: async () => ({}) }),
      }),
      batch: async () => [],
      dump: async () => new ArrayBuffer(0),
      exec: async () => ({ count: 0 }),
    },
    DO: { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response("{}") }) },
    CF_ACCOUNT: "acct",
    CF_KV_UUID: "uuid",
    CF_API_KEY: "key",
    MYSQL_URLS: "mysql://u:p@h:3306/d",
  }

  const expected: Record<string, string[]> = {
    blob: ["map"],
    kv: ["map", "key"],
    cfkv: ["map", "key"],
    d1: ["map", "key", "sql"],
    do: ["map", "key", "sql"],
    mysql: ["map", "key", "sql"],
  }

  for (const [driver, allowed] of Object.entries(expected)) {
    for (const format of ["map", "key", "sql"]) {
      const env = { ...baseEnv, DB_DRIVER: driver, DB_FORMAT: format }
      const status = await getStoreStatus(env)
      const isInvalid = status.configErrorCode === "INVALID_COMBINATION"
      const shouldBeValid = allowed.includes(format)
      assert.equal(
        isInvalid,
        !shouldBeValid,
        `${driver} + ${format}：期望 ${shouldBeValid ? "合法" : "非法"}，` +
          `實際 configErrorCode=${status.configErrorCode}`,
      )
    }
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 約束 2：JWT_SECRET 可自動生成，不應阻斷安裝
// ─────────────────────────────────────────────────────────────────────────────

test("未配置 JWT_SECRET：ready 仍應為 true（儲存可用即可開始安裝）", async () => {
  const env: any = {
    DB_DRIVER: "kv",
    DB_FORMAT: "map",
    KV: fakeKv(),
    // 故意不配 JWT_SECRET
  }

  const res = await buildApp().request(
    "/api/public/env_check",
    { method: "GET" },
    env,
  )
  const data = (await res.json()).data

  assert.equal(
    data.ready,
    true,
    "ready 只表示「儲存就緒、可以開始安裝」。若把 jwtReady 也算進去，會形成" +
      "自死鎖：自動生成密鑰只在提交初始化時執行，而嚮導被 ready 擋住進不到那一步",
  )
  assert.equal(data.jwt.ready, false, "密鑰確實尚未就緒，UI 仍需提示")

  const issue = data.issues.find((i: any) => i.code === "JWT_SECRET_MISSING")
  assert.ok(issue, "仍要給出提示，讓用戶知道可以手動配置更穩妥")
  assert.equal(
    issue.level,
    "warning",
    "缺密鑰不是 error：儲存可用時 setup 會自動生成並持久化",
  )
  assert.match(String(issue.suggestion), /let setup generate one/)
})

test("未配置 JWT_SECRET：初始化成功後必須自動生成並持久化密鑰", async () => {
  const kv = fakeKv()
  const env: any = {
    DB_DRIVER: "kv",
    DB_FORMAT: "map",
    KV: kv,
    // 故意不配 JWT_SECRET
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

  assert.equal(res.status, 200, "未配置 JWT_SECRET 不應阻斷初始化")

  // 自動生成的密鑰必須落到加密密鑰槽位，並被 JWT 側可見（否則就是
  // 「看著生成了、實際沒生效」：JWT 側讀的是另一個槽位名）。
  const generated = kv.__store.get("openlist_encryption_secret")
  assert.ok(
    generated && generated.length > 0,
    "setup 必須把自動生成的密鑰持久化到 openlist_encryption_secret",
  )

  // 再來一次 env_check：此時密鑰已就緒
  const after = await buildApp().request(
    "/api/public/env_check",
    { method: "GET" },
    env,
  )
  const afterData = (await after.json()).data
  assert.equal(
    afterData.jwt.ready,
    true,
    "自動生成之後，jwt.ready 必須變為 true —— 這正是「自動生成是否真的生效」的判定",
  )
  assert.equal(afterData.jwt.source, "env-or-persisted")

  // 關鍵不變量：JWT 側實際使用的密鑰必須**就是** setup 生成的那把。
  // 歷史 bug：JWT 讀 openlist_jwt_secret、setup 寫
  // openlist_encryption_secret —— 兩個槽位名不同，於是 JWT 側看不到生成結果，
  // 又自己生成一把寫入另一個槽位。結果是「生成了一份，卻有兩把在漂移」，
  // 多實例驗籤互相失敗、冷啟動即換鑰。這裡直接比對密鑰值。
  const { getJwtSecret, resetJwtSecretCache } = await import("./middlewares")
  resetJwtSecretCache()
  const jwtSecret = await getJwtSecret({ env })
  assert.equal(
    jwtSecret,
    generated,
    "JWT 簽名密鑰必須複用 setup 自動生成的密鑰，而不是另起一把" +
      "（同名密鑰分離會導致「自動生成看著生效、實際驗籤失敗」）",
  )
})
