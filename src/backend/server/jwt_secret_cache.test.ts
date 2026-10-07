import assert from "node:assert/strict"
import { test } from "node:test"
import { __resetDbCacheForTest } from "../internal/model/db"
import { getJwtSecret, resetJwtSecretCache } from "./middlewares"

/**
 * getJwtSecret() 快取迴歸測試
 *
 * 背景 1（性能）：getJwtSecret 的「持久化密鑰」分支曾經僅 `return kvSecret`
 * 而不寫快取，導致該函數**自身**沒有快取：僅要底層讀取沒有被其它層記憶化，
 * 每次調用都會重新回源。而它一次請求內會被
 * getUserFromContext / csrfProtection / checkAdminAuth 調用 2-4 次。
 *
 * 背景 2（隔離）：快取必須是**按 env 對象**的。env 決定「去哪個後端讀密鑰」，
 * 單一進程級快取會把先讀到的密鑰發給另一套環境，導致跨環境 token 互相可驗證。
 * （Go 版是單進程單部署、密鑰在啟動時由 conf.Conf.JwtSecret 一次確定，不存在
 * 該問題；TS 版必須按 env 隔離才能保持等價語義。）
 *
 * 說明：底層 getKvBinding 也有按 env 身份的結果快取，因此複用同一個 env 對象時，
 * 即使 getJwtSecret 自身不快取也可能不產生額外讀取。本文件直接用「KV 綁定上的
 * 讀取計數」觀測真實回源次數，並複用同一個 env 對象——這正是生產形態：
 * 一次請求 = 一個 env 對象。
 */

const JWT_SECRET_KV_KEY = "openlist_jwt_secret"
const STRONG_SECRET = "a".repeat(48)

/** 構造帶讀取計數的 KV 綁定（每次新建，綁定到不同的 env 上）。 */
function createCountingKv(
  seed: Record<string, string>,
  stats: { get: number; put: number },
) {
  const data = new Map<string, string>(Object.entries(seed))
  return {
    async get(key: string) {
      stats.get++
      return data.has(key) ? data.get(key)! : null
    },
    async put(key: string, value: string) {
      stats.put++
      data.set(key, value)
    },
  }
}

test("getJwtSecret: 同一 env 命中快取後不再回源（修復前每次調用都回源）", async () => {
  __resetDbCacheForTest()
  resetJwtSecretCache()

  const stats = { get: 0, put: 0 }
  const seed = { [JWT_SECRET_KV_KEY]: STRONG_SECRET }
  // 生產形態：一次請求 = 一個 env 對象，同一對象內可能被調用多次。
  const env = { KV: createCountingKv(seed, stats) }

  const first = await getJwtSecret({ env })
  assert.equal(first, STRONG_SECRET)
  const readsAfterFirst = stats.get
  assert.ok(readsAfterFirst >= 1, "首次調用必須回源儲存")

  const second = await getJwtSecret({ env })
  const third = await getJwtSecret({ env })

  assert.equal(second, STRONG_SECRET)
  assert.equal(third, STRONG_SECRET)
  assert.equal(
    stats.get,
    readsAfterFirst,
    "同一 env 命中快取後不得再回源（修復前此處會 +2 次）",
  )
})

test("getJwtSecret: resetJwtSecretCache 後重新回源（支持令牌全失效）", async () => {
  __resetDbCacheForTest()
  resetJwtSecretCache()

  const stats = { get: 0, put: 0 }
  const seed = { [JWT_SECRET_KV_KEY]: STRONG_SECRET }

  await getJwtSecret({ env: { KV: createCountingKv(seed, stats) } })
  const before = stats.get

  // 模擬 reset_token：清快取後必須重新回源，使舊 token 全部失效。
  resetJwtSecretCache()
  const again = await getJwtSecret({
    env: { KV: createCountingKv(seed, stats) },
  })

  assert.equal(again, STRONG_SECRET)
  assert.ok(stats.get > before, "清快取後必須重新回源 KV")
})

test("getJwtSecret: env.JWT_SECRET 優先級最高且不讀 KV", async () => {
  __resetDbCacheForTest()
  resetJwtSecretCache()

  const stats = { get: 0, put: 0 }
  const envSecret = "b".repeat(40)
  const env: any = {
    KV: createCountingKv({}, stats),
    JWT_SECRET: envSecret,
  }

  const secret = await getJwtSecret({ env })
  assert.equal(secret, envSecret)
  assert.equal(stats.get, 0, "配置了 env.JWT_SECRET 時不應讀取 KV")
})

test("getJwtSecret: 不同 env 各自使用自己後端的密鑰（不得串用）", async () => {
  __resetDbCacheForTest()
  resetJwtSecretCache()

  const secretA = "a".repeat(48)
  const secretB = "b".repeat(48)
  const statsA = { get: 0, put: 0 }
  const statsB = { get: 0, put: 0 }
  const envA = { KV: createCountingKv({ [JWT_SECRET_KV_KEY]: secretA }, statsA) }
  const envB = { KV: createCountingKv({ [JWT_SECRET_KV_KEY]: secretB }, statsB) }

  assert.equal(await getJwtSecret({ env: envA }), secretA)
  const readsA = statsA.get

  // 修復前：envB 會拿到 envA 的密鑰（進程級單變量快取）。
  assert.equal(
    await getJwtSecret({ env: envB }),
    secretB,
    "envB 必須拿到自己後端的密鑰，不能複用 envA 的",
  )
  assert.ok(statsB.get >= 1, "envB 必須實際回源自己的後端")

  // envA 的快取也不應被 envB 覆蓋。
  assert.equal(await getJwtSecret({ env: envA }), secretA)
  assert.equal(statsA.get, readsA, "envA 仍應命中自己的快取")
})
