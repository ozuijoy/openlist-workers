import assert from "node:assert/strict"
import { test } from "node:test"

/**
 * getDb() 快取迴歸測試（性能事故防護）
 *
 * 背景：曾出現過一次線上性能事故 —— getDb() 在**無參調用**時直接
 * `return loadDb(envCtx)`，繞過了 dbCache / dbInflight 兩個快取。
 * 而倉庫裡有約 30 處無參調用（storage.ts 的驅動回調、getSettings 等五個
 * getter），導致一次 WebDAV PROPFIND 或一次頁面加載會觸發數十次「完整冷加載」：
 * 後端全量讀取 + JSON.parse + 逐欄位 AES 解密。KV 與 D1 兩種後端因此被同時
 * 放大數十倍而變慢。
 *
 * 本文件鎖定修復後的行為：
 *  1. 重複的無參 getDb() 不得重複觸發後端 load（應命中快取）；
 *  2. 併發的無參 getDb() 必須合併為一次 load（in-flight 去重）；
 *  3. saveDb() 之後的無參 getDb() 必須能觀察到最新寫入（寫後讀一致）；
 *  4. 有參調用與無參調用共享同一份快取，不應各自重複加載。
 *
 * 說明：db.ts 內部使用模塊級快取（TTL 1s），因此測試之間通過
 * `__resetDbCacheForTest()` 清理狀態，避免相互干擾。
 */

// 動態導入以避免測試文件頂層就初始化 store 後端探測。
const mod = await import("./db")

const {
  getDb,
  saveDb,
  setEnvCtx,
  __resetDbCacheForTest,
  __setStoreBackendLoaderForTest,
} = mod as any

/** 統計 load 調用次數的偽後端。 */
function createCountingBackend(initial: any) {
  let data = initial ? JSON.parse(JSON.stringify(initial)) : null
  const stats = { load: 0, save: 0 }
  const backend = {
    name: "counting",
    isConfigured: async () => true,
    async load() {
      stats.load++
      // 模擬真實後端的網路 + 解析延遲，讓併發窗口真實存在。
      await new Promise((r) => setTimeout(r, 10))
      return data ? JSON.parse(JSON.stringify(data)) : null
    },
    async save(next: any) {
      stats.save++
      data = JSON.parse(JSON.stringify(next))
      return true
    },
  }
  return { backend, stats, getData: () => data }
}

const SAMPLE = {
  settings: [{ key: "site_title", value: "OpenList" }],
  storages: [],
  users: [],
  shares: [],
  metas: [],
  plugins: [],
}

test("getDb: 重複無參調用僅觸發一次後端 load（快取命中）", async () => {
  __resetDbCacheForTest()
  const { backend, stats } = createCountingBackend(SAMPLE)
  __setStoreBackendLoaderForTest(async () => backend)

  const env = { DB_DRIVER: "counting" }
  setEnvCtx(env)

  const a = await getDb()
  const b = await getDb()
  const c = await getDb()

  assert.equal(stats.load, 1, "連續無參 getDb() 應命中快取，僅 load 一次")
  assert.equal(a, b)
  assert.equal(b, c)

  // 傳入同一 env 也複用同一快取，不應額外 load。
  const d = await getDb(env)
  assert.equal(stats.load, 1, "有參調用應與無參調用共享快取")
  assert.equal(d, a)
})

test("getDb: 併發無參調用合併為一次 load（in-flight 去重）", async () => {
  __resetDbCacheForTest()
  const { backend, stats } = createCountingBackend(SAMPLE)
  __setStoreBackendLoaderForTest(async () => backend)

  setEnvCtx({ DB_DRIVER: "counting" })

  // 同時發起（不 await），模擬一次請求內多個模塊並行取 DB。
  const results = await Promise.all([
    getDb(),
    getDb(),
    getDb(),
    getDb(),
    getDb(),
  ])

  assert.equal(stats.load, 1, "併發無參 getDb() 應合併為一次 load")
  for (const r of results) assert.equal(r, results[0])
})

test("getDb: saveDb 後無參讀取可觀察到最新寫入（寫後讀一致）", async () => {
  __resetDbCacheForTest()
  const { backend, stats, getData } = createCountingBackend(SAMPLE)
  __setStoreBackendLoaderForTest(async () => backend)

  const env = { DB_DRIVER: "counting" }
  setEnvCtx(env)

  await getDb()
  assert.equal(stats.load, 1)

  const next = { ...SAMPLE, settings: [{ key: "site_title", value: "Changed" }] }
  await saveDb(next)
  // 注意：saveDb 內部可能同時寫入加密密鑰等輔助資料，因此不斷言 save 恰好為 1，
  // 僅要求確實發生過持久化寫入。
  assert.ok(stats.save >= 1, "saveDb 應觸發後端持久化")

  // 注意：這裡不等待 TTL 過期，驗證的是 saveDb 主動刷新快取。
  const after = await getDb()
  assert.equal(stats.load, 1, "saveDb 應刷新快取，避免再觸發一次 load")
  assert.equal(after.settings[0].value, "Changed")
  assert.equal(getData().settings[0].value, "Changed")
})

test("saveDb: sensitive fields use the low-CPU v2 envelope and remain readable", async () => {
  __resetDbCacheForTest()
  const { backend, getData } = createCountingBackend({
    ...SAMPLE,
    users: [{ id: 1, username: "admin", password: "password-hash" }],
    // 注意：storage 必須帶 driver / mount_path —— 否則會被 ensureDefaultStorages()
    // 當作損壞條目過濾掉（storages 變為空數組），斷言在 storages[0] 上就會炸。
    storages: [
      {
        id: 1,
        driver: "local",
        mount_path: "/drive",
        addition: '{"refresh_token":"secret"}',
      },
    ],
  })
  __setStoreBackendLoaderForTest(async () => backend)

  const env = {
    DB_DRIVER: "counting",
    JWT_SECRET: "test-config-encryption-secret",
    // 加密是可選的：默認 DB_CIPHER=none（明文落盤），本用例顯式開啟加密，
    // 以鎖定 #69 的低 CPU v2 envelope 行為（見下方「默認不加密」用例）。
    DB_CIPHER: "aes-256-gcm",
  }
  const plain = await getDb(env)
  await saveDb(plain, env)

  const persisted = getData()
  assert.match(persisted.storages[0].addition, /^enc:v2:/)
  assert.match(persisted.users[0].password, /^enc:v2:/)

  __resetDbCacheForTest()
  const reloadedBackend = createCountingBackend(persisted).backend
  __setStoreBackendLoaderForTest(async () => reloadedBackend)
  const reloaded = await getDb(env)
  assert.equal(reloaded.storages[0].addition, plain.storages[0].addition)
  assert.equal(reloaded.users[0].password, plain.users[0].password)
})

test("saveDb: without DB_CIPHER sensitive fields are written as plaintext", async () => {
  __resetDbCacheForTest()
  const { backend, getData } = createCountingBackend({
    ...SAMPLE,
    users: [{ id: 1, username: "admin", password: "password-hash" }],
    storages: [
      {
        id: 1,
        driver: "local",
        mount_path: "/drive",
        addition: '{"refresh_token":"secret"}',
      },
    ],
  })
  __setStoreBackendLoaderForTest(async () => backend)

  // 不配置 DB_CIPHER（默認 none）：即便提供了 JWT_SECRET 也不加密資料庫欄位。
  const env = {
    DB_DRIVER: "counting",
    JWT_SECRET: "test-config-encryption-secret",
  }
  const plain = await getDb(env)
  await saveDb(plain, env)

  const persisted = getData()
  assert.equal(persisted.storages[0].addition, '{"refresh_token":"secret"}')
  assert.equal(persisted.users[0].password, "password-hash")
})

test("getDb: 五個無參 getter 複用同一份快取快照", async () => {
  __resetDbCacheForTest()
  const { backend, stats } = createCountingBackend({
    ...SAMPLE,
    users: [{ id: 1, username: "admin" }],
  })
  __setStoreBackendLoaderForTest(async () => backend)

  setEnvCtx({ DB_DRIVER: "counting" })

  // getSettings/getUsers/getStorages/getMetas/getPlugins 均為無參調用 getDb()。
  // 本用例的核心斷言是 load 次數：修復前每個 getter 都各觸發一次完整冷加載。
  const [settings, users, storages, metas, plugins] = await Promise.all([
    mod.getSettings(),
    mod.getUsers(),
    mod.getStorages(),
    mod.getMetas(),
    mod.getPlugins(),
  ])

  assert.equal(
    stats.load,
    1,
    "五個無參 getter 併發調用應合併為一次 load（修復前為 5 次）",
  )
  // getSettings() 返回「key -> value」的扁平對象，而非數組。
  assert.equal(settings.site_title, "OpenList")
  assert.equal(users[0].username, "admin")
  assert.ok(Array.isArray(storages))
  assert.ok(Array.isArray(metas))
  assert.ok(Array.isArray(plugins))
})

test("getDb: TTL 過期後允許重新加載（快取不是永久固化）", async () => {
  __resetDbCacheForTest()
  const { backend, stats } = createCountingBackend(SAMPLE)
  __setStoreBackendLoaderForTest(async () => backend)

  setEnvCtx({ DB_DRIVER: "counting" })

  await getDb()
  assert.equal(stats.load, 1)

  // 等待 TTL（1s）過期，模擬跨請求/長時間空閒後的重新加載。
  await new Promise((r) => setTimeout(r, 1100))
  await getDb()
  assert.equal(stats.load, 2, "TTL 過期後應重新 load，以獲取其他實例的寫入")
})

test("getDb: __resetDbCacheForTest 同時復位寫前守衛狀態", async () => {
  __resetDbCacheForTest()
  const { backend } = createCountingBackend(SAMPLE)
  __setStoreBackendLoaderForTest(async () => backend)

  const env = { DB_DRIVER: "counting" }
  setEnvCtx(env)

  await getDb()
  assert.equal(mod.isDbTrusted(), true, "成功加載後應標記為記憶體庫可信")

  // 寫回一個空殼 → 必被守衛攔截，並留下 dbWriteBlocked 標記。
  const blocked = await saveDb({
    settings: [],
    users: [],
    storages: [],
    shares: [],
    metas: [],
    plugins: [],
  })
  assert.equal(blocked, false, "空殼寫入必須被拒絕")
  assert.equal(mod.isDbWriteBlocked(), true, "守衛應記錄本次攔截")

  // 關鍵斷言：reset 之後這些模塊級狀態必須回到初始態，否則用例結果會取決於
  // 執行順序（db_write_guard.test.ts 直接斷言 isDbTrusted / isDbWriteBlocked）。
  __resetDbCacheForTest()
  assert.equal(mod.isDbTrusted(), false, "reset 後應回到「不可信」")
  assert.equal(mod.isDbWriteBlocked(), false, "reset 後應清除攔截標記")
  assert.equal(mod.getDbLoadError(), null, "reset 後不應殘留讀取錯誤")
})
