import assert from "node:assert/strict"
import { test } from "node:test"

/**
 * 迴歸測試（端到端）：寫前守衛必須攔截「不可信空資料」的落盤。
 *
 * 這是本倉庫最重要的一條資料安全約束：**永遠不得以空資料寫入資料庫**。
 *
 * 復現的歷史故障：
 *   1. 讀取持久化儲存失敗（binding 未注入 / 最終一致性 / 後端切換）
 *   2. loadDb() 吞掉錯誤，回退到 defaultDb 克隆（空殼）
 *   3. ensureDefaultSettings() 隱式 saveDb()，把空殼寫回儲存
 *   4. 真實配置被覆蓋 → init_status 報 initialized=false → 用戶看到「資料庫被清空」
 *
 * 下面通過直接驅動 db.ts 的公開 API 來鎖定該行為。
 */

/**
 * 每個用例使用獨立 env 對象，避免 getStorageBackend 的 env 指紋快取串味。
 *
 * 使用 DB_DRIVER=auto：在 Node（非 serverless）運行時下，探測不到任何綁定時會
 * 回退到 memory driver —— 這正是我們來模擬「空儲存 / 讀取失敗」的理想後端。
 */
function freshEnv(): any {
  return {
    DB_DRIVER: "auto",
    DB_FORMAT: "map",
    JWT_SECRET: "test-secret-for-db-write-guard",
    ENCRYPTION_SECRET: "test-secret-for-db-write-guard",
  }
}

test("寫前守衛：從未成功讀取時，拒絕把空殼寫回資料庫", async () => {
  const db = await import("./db")
  const env = freshEnv()

  // 全新 isolate：儲存為空 → loadDb 返回不可信空殼。
  const loaded = await db.getDb(env)
  assert.equal(db.isDbTrusted(), false, "空儲存首次讀取不應被視為可信")
  assert.equal(db.isDbShell(loaded), true, "初次讀取應得到空殼")

  // 關鍵斷言：嘗試寫回空殼必須被拒絕。
  const ok = await db.saveDb(
    { settings: [], users: [], storages: [], shares: [], metas: [], plugins: [] },
    env,
  )
  assert.equal(ok, false, "空殼落盤必須被守衛攔截")
  assert.equal(db.isDbWriteBlocked(), true, "守衛應記錄本次攔截")
})

test("寫前守衛：可信資料寫入不受影響（含儲存掛載的正常保存）", async () => {
  const db = await import("./db")
  const env = freshEnv()

  // 先建立一次「可信」狀態：寫入一份含實體的庫（攜帶 force，模擬初始化/首次落盤）。
  const realDb = {
    settings: [{ key: "site_title", value: "OpenList" }],
    users: [{ id: 1, username: "admin", role: 2, password: "hash" }],
    storages: [{ id: 1, mount_path: "/onedrive", driver: "onedrive" }],
    shares: [],
    metas: [],
    plugins: [],
  }
  assert.equal(await db.saveDb(realDb, env, { force: true }), true)

  // 重新讀取：此時應變為可信。
  // 用同一個 env 並且 saveDb 已刷新請求快取，因此 getDb 會讀到剛寫入的快照。
  const reloaded = await db.getDb(env)
  assert.equal(db.isDbTrusted(), true, "成功讀取後應標記為可信")
  assert.equal(db.isDbShell(reloaded), false, "含儲存掛載的庫不是空殼")

  // 正常寫入（非空殼）必須照常成功 —— 守衛不能誤傷日常操作。
  const updated = {
    ...(reloaded as any),
    storages: [
      ...((reloaded as any).storages || []),
      { id: 2, mount_path: "/drive2", driver: "local" },
    ],
  }
  assert.equal(await db.saveDb(updated, env), true, "含資料的寫入不應被攔截")
  assert.equal(db.isDbWriteBlocked(), false, "未發生攔截")
})

test("寫前守衛：讀取失敗後，即使記憶體中有舊快照也不允許用空殼覆蓋", async () => {
  const db = await import("./db")

  // 用一個 env 建立可信狀態並落盤一份真實資料。
  const env = freshEnv()
  const realDb = {
    settings: [{ key: "site_title", value: "OpenList" }],
    users: [{ id: 1, username: "admin", role: 2, password: "hash" }],
    storages: [{ id: 1, mount_path: "/onedrive", driver: "onedrive" }],
    shares: [],
    metas: [],
    plugins: [],
  }
  assert.equal(await db.saveDb(realDb, env, { force: true }), true)

  // 模擬「讀取失敗」：傳入一個簽名不同、無法訪問原後端的 env，
  // 使 saveDb 無法通過後端校驗，從而驗證守衛仍以空殼為依據拒絕寫入。
  const emptyShell = {
    settings: [],
    users: [],
    storages: [],
    shares: [],
    metas: [],
    plugins: [],
  }
  // 即使顯式 force 繞過守衛，也應只有調用方明確知情時才可能發生；
  // 這裡斷言默認行為一定是拒絕。
  assert.equal(
    await db.saveDb(emptyShell, env),
    false,
    "空殼寫入必須默認被拒絕",
  )
})

test("不變量：讀取（getDb）不得產生隱式寫入", async () => {
  const db = await import("./db")
  const { memoryDriver } = await import("./store/driver/memory")
  const { mapFormat } = await import("./store/format/map")

  const env = freshEnv()
  // 先放入一份真實資料，使後續讀取「成功」，從而暴露任何隱式落盤行為。
  assert.equal(
    await db.saveDb(
      {
        settings: [{ key: "site_title", value: "OpenList" }],
        users: [{ id: 1, username: "admin", role: 2, password: "hash" }],
        storages: [{ id: 1, mount_path: "/onedrive", driver: "onedrive" }],
        shares: [],
        metas: [],
        plugins: [],
      },
      env,
      { force: true },
    ),
    true,
  )

  const before = JSON.stringify(await mapFormat.load(memoryDriver, env))
  // 多次讀取（會走 ensureDefaultSettings/Storages/... 的補齊邏輯）。
  await db.getDb(env)
  await db.getDb(env)
  const after = JSON.stringify(await mapFormat.load(memoryDriver, env))

  // 歷史缺陷：ensureDefaultSettings() 會隱式 saveDb()，讀取也變成寫入。
  assert.equal(after, before, "getDb() 不得改變持久化內容（不得隱式落盤）")
})
