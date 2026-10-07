import assert from "node:assert/strict"
import { test } from "node:test"
import type { Driver } from "./types"
import { readDriver, readFormat, getStoreBackend } from "./backend"
import { readPersistedSecret, writePersistedSecret } from "./json"
import { mapFormat } from "./format/map"
import { keyFormat } from "./format/key"
import { sqlFormat } from "./format/sql"
import {
  TABLE_NAMES,
  DDL_TABLE_NAMES,
  TABLE_KEY,
  keyOf,
  TABLES,
  TABLE_SQL_NAMES,
  getTablePrefix,
  tableSqlName,
  D1_SCHEMA,
  MYSQL_SCHEMA,
  serializeColumn,
  deserializeColumn,
  rowToEntity,
  entityToRow,
} from "./schema"

/** 基於局部 Map 的記憶體 KV 驅動（隔離測試）。 */
function createMockKvDriver(): Driver {
  const store = new Map<string, string>()
  return {
    name: "mock-kv",
    isAvailable: async () => true,
    init: async () => {},
    get: async (key) => store.get(key) ?? null,
    put: async (key, value) => {
      store.set(key, value)
    },
    delete: async (key) => {
      store.delete(key)
    },
    list: async (prefix) =>
      [...store.keys()].filter((k) => k.startsWith(prefix)),
    health: async () => ({ connected: true }),
  }
}

/** 基於局部 Map 的簡易 SQL 驅動（隔離測試，支持 sqlFormat 用到的 SQL）。 */
function createMockSqlDriver(name = "mock-sql"): Driver {
  // table -> rows (對象數組)
  const tables = new Map<string, any[]>()
  // schema_info: k -> v
  const schemaInfo = new Map<string, string>()

  const ensureTable = (name: string) => {
    if (!tables.has(name)) tables.set(name, [])
    return tables.get(name)!
  }

  return {
    name,
    isAvailable: async () => true,
    init: async () => {},
    get: async () => null,
    put: async () => {},
    delete: async () => {},
    list: async () => [],
    async query(sql: string, params: any[]): Promise<any[]> {
      const trimmed = sql.trim()
      // SELECT v FROM schema_info WHERE k = ?
      if (/^SELECT v FROM schema_info WHERE k = \?/i.test(trimmed)) {
        const k = String(params[0])
        return schemaInfo.has(k) ? [{ v: schemaInfo.get(k) }] : []
      }
      // SELECT * FROM `table`
      const m = trimmed.match(/^SELECT \* FROM `?(\w+)`?/i)
      if (m) return ensureTable(m[1]).map((r) => ({ ...r }))
      throw new Error(`mock-sql unsupported query: ${sql}`)
    },
    async execute(_sql: string, _params: any[]): Promise<void> {
      // 單條 execute 在測試中不直接調用，保留空實現
    },
    async batch(
      statements: Array<{ sql: string; params: any[] }>,
    ): Promise<void> {
      for (const { sql, params } of statements) {
        const trimmed = sql.trim()
        // DELETE FROM `table`（整表清空）
        const delAll = trimmed.match(/^DELETE FROM `?(\w+)`?$/i)
        if (delAll) {
          tables.set(delAll[1], [])
          continue
        }
        // DELETE FROM `table` WHERE `key` NOT IN (?, ?, ...)（UPSERT 後清理已刪行）
        const delNotIn = trimmed.match(
          /^DELETE FROM `?(\w+)`? WHERE `?(\w+)`? NOT IN \(([^)]*)\)/i,
        )
        if (delNotIn) {
          const [, table, keyCol] = delNotIn
          const keep = new Set(params.map((p) => String(p)))
          const rows = ensureTable(table)
          tables.set(
            table,
            rows.filter((r: any) => keep.has(String(r[keyCol]))),
          )
          continue
        }
        // schema_info 的 UPSERT 必須先於通用 INSERT 匹配，否則會被當作資料行。
        // SQLite 方言：INSERT OR REPLACE INTO `schema_info` (`k`, `v`) VALUES (?, ?)
        if (/^INSERT OR REPLACE INTO `?schema_info`?/i.test(trimmed)) {
          schemaInfo.set(String(params[0]), String(params[1]))
          continue
        }
        // MySQL 方言：INSERT INTO `schema_info` (...) VALUES (...) ON DUPLICATE KEY UPDATE ...
        if (
          /^INSERT INTO `?schema_info`?/i.test(trimmed) &&
          /ON DUPLICATE KEY UPDATE/i.test(trimmed)
        ) {
          schemaInfo.set(String(params[0]), String(params[1]))
          continue
        }
        // 資料行 UPSERT（SQLite）：INSERT OR REPLACE INTO `table` (...) VALUES (...)
        const upSqlite = trimmed.match(
          /^INSERT OR REPLACE INTO `?(\w+)`? \(([^)]+)\) VALUES \(([^)]+)\)/i,
        )
        // 資料行 UPSERT（MySQL）：INSERT INTO `table` (...) VALUES (...) ON DUPLICATE KEY UPDATE ...
        const upMysql = trimmed.match(
          /^INSERT INTO `?(\w+)`? \(([^)]+)\) VALUES \(([^)]+)\)/i,
        )
        const ins = upSqlite || upMysql
        if (ins) {
          const table = ins[1]
          const cols = ins[2].split(",").map((c) => c.trim().replace(/`/g, ""))
          const row: any = {}
          cols.forEach((c, i) => {
            row[c] = params[i]
          })
          // UPSERT 語義：按首列（主鍵）替換同鍵行
          const pkCol = cols[0]
          const rows = ensureTable(table)
          const idx = rows.findIndex(
            (r: any) => String(r[pkCol]) === String(row[pkCol]),
          )
          if (idx >= 0) rows[idx] = row
          else rows.push(row)
          continue
        }
        throw new Error(`mock-sql unsupported statement: ${sql}`)
      }
    },
    health: async () => ({ connected: true }),
  }
}

const SAMPLE_DB = {
  settings: [{ key: "site_title", value: "OpenList" }],
  storages: [{ id: 1, mount_path: "/x", driver: "local" }],
  users: [
    { id: 1, username: "admin", role: 2, permission: 0, disabled: false },
  ],
  shares: [],
  metas: [{ id: 1, path: "/a", read_users: [1, 2], read_users_sub: false }],
  plugins: [],
}

test("schema: columnar tables match Go backend structure", () => {
  // 往返表 6 張（sshkeys 不參與，避免清空 Go 的 x_ssh_public_keys）
  assert.equal(TABLE_NAMES.length, 6)
  // DDL 表 7 張（含 sshkeys，保持與 Go 共享庫的結構一致）
  assert.equal(DDL_TABLE_NAMES.length, 7)
  assert.equal(TABLE_KEY.settings, "key")
  assert.equal(TABLE_KEY.users, "id")
  assert.equal(keyOf("settings", { key: "site_title" }), "site_title")
  assert.equal(keyOf("users", { id: 2 }), "2")

  // 列式表：每個欄位獨立成列，不再是「data JSON」寬表
  assert.ok(TABLES.users.columns.some((c) => c.name === "username"))
  assert.ok(TABLES.users.columns.some((c) => c.name === "base_path"))
  assert.ok(TABLES.storages.columns.some((c) => c.name === "mount_path"))
  assert.ok(TABLES.metas.columns.some((c) => c.name === "read_users"))
  assert.ok(TABLES.plugins.columns.some((c) => c.name === "script_content"))
  assert.ok(TABLES.sshkeys.columns.some((c) => c.name === "key_str"))
  // 不應再有寬表的 data 列
  assert.ok(!TABLES.users.columns.some((c) => c.name === "data"))
  // DDL 冪等生成（schema_info + 7 張業務表）
  assert.ok(D1_SCHEMA.length >= 8)
  assert.ok(MYSQL_SCHEMA.length >= 8)
})

test("schema: SQL table names align with Go GORM naming", () => {
  // 複數名映射（對齊 Go 的 GORM snake_case + 複數）
  assert.equal(TABLE_SQL_NAMES.settings, "setting_items")
  assert.equal(TABLE_SQL_NAMES.shares, "sharing_dbs")
  assert.equal(TABLE_SQL_NAMES.storages, "storages")
  assert.equal(TABLE_SQL_NAMES.users, "users")
  assert.equal(TABLE_SQL_NAMES.metas, "metas")

  // 表前綴固定 x_（對齊 Go 的默認值）
  assert.equal(getTablePrefix({}), "x_")
  assert.equal(getTablePrefix({ TABLE_PREFIX: "abc_" }), "x_")

  // 完整表名 = 前綴 + 複數名
  assert.equal(tableSqlName("settings", {}), "x_setting_items")
  assert.equal(tableSqlName("shares", {}), "x_sharing_dbs")
  assert.equal(tableSqlName("settings", { TABLE_PREFIX: "abc_" }), "x_setting_items")

  // DDL 裡應包含帶前綴的複數表名
  assert.ok(D1_SCHEMA.some((d) => d.includes("x_setting_items")))
  assert.ok(D1_SCHEMA.some((d) => d.includes("x_sharing_dbs")))
})

test("schema: column serialization roundtrip", () => {
  const boolCol = { name: "disabled", type: "bool" as const }
  assert.equal(serializeColumn(boolCol, true), 1)
  assert.equal(deserializeColumn(boolCol, 1), true)
  assert.equal(deserializeColumn(boolCol, 0), false)

  const numCol = { name: "id", type: "number" as const }
  assert.equal(deserializeColumn(numCol, "42"), 42)

  const jsonCol = { name: "read_users", type: "json" as const }
  assert.deepEqual(
    deserializeColumn(jsonCol, serializeColumn(jsonCol, [1, 2])),
    [1, 2],
  )

  const entity = { id: 1, username: "admin", read_users: [1, 2] }
  const { columns, values } = entityToRow("users", entity)
  assert.ok(columns.includes("username"))
  const row: any = {}
  columns.forEach((c, i) => (row[c] = values[i]))
  assert.equal(rowToEntity("users", row).username, "admin")
})

test("backend factory: readDriver/readFormat backward compat", () => {
  assert.equal(readDriver({}), "auto")
  assert.equal(readDriver({ DB_DRIVER: "d1" }), "d1")
  assert.equal(readDriver({ DB_DRIVER: "MYSQL" }), "mysql")
  assert.equal(readDriver({ DB_DRIVER: "cfkv" }), "cfkv")
  // DB_DRIVER=json → auto（舊整對象語義）
  assert.equal(readDriver({ DB_DRIVER: "json" }), "auto")

  // 默認格式 map
  assert.equal(readFormat({}), "map")
  assert.equal(readFormat({ DB_FORMAT: "sql" }), "sql")
  assert.equal(readFormat({ DB_FORMAT: "KEY" }), "key")
})

test("backend factory: auto detection falls back to memory", async () => {
  const b = await getStoreBackend({})
  assert.equal(b.name, "memory")
})

test("map format: roundtrip via mock KV driver", async () => {
  const driver = createMockKvDriver()
  assert.equal(await mapFormat.save(SAMPLE_DB, driver), true)
  assert.deepEqual(await mapFormat.load(driver), SAMPLE_DB)
})

test("key format: roundtrip via mock KV driver (per-table keys)", async () => {
  const driver = createMockKvDriver()
  assert.equal(await keyFormat.save(SAMPLE_DB, driver), true)
  assert.deepEqual(await keyFormat.load(driver), SAMPLE_DB)
})

test("sql format: roundtrip via mock SQL driver (columnar)", async () => {
  const driver = createMockSqlDriver()
  assert.equal(await sqlFormat.save(SAMPLE_DB, driver), true)
  assert.deepEqual(await sqlFormat.load(driver), SAMPLE_DB)
})

test("sql format: MySQL dialect uses ON DUPLICATE KEY UPDATE (no INSERT OR REPLACE)", async () => {
  // 迴歸防護：MySQL 不支持 INSERT OR REPLACE，若方言分支失效，
  // mock 驅動會在收到該語句時拋錯，從而讓本測試失敗。
  const driver = createMockSqlDriver("mysql")
  assert.equal(await sqlFormat.save(SAMPLE_DB, driver), true)
  assert.deepEqual(await sqlFormat.load(driver), SAMPLE_DB)
})

/**
 * 構造一個最小可用的 D1 綁定樁（僅實現 kv 表相關的 prepare 語義）。
 *
 * 用於迴歸驗證：密鑰讀寫必須能走 d1 驅動，而不是隻在 KV 綁定存在時才成功。
 */
function createMockD1Binding() {
  const store = new Map<string, string>()
  return {
    /** 暴露底層 Map，便於斷言密鑰確實落盤（而不是僅存在於記憶體快取）。 */
    store,
    prepare(sql: string) {
      let params: any[] = []
      const stmt = {
        bind(...args: any[]) {
          params = args
          return stmt
        },
        async first() {
          if (/SELECT\s+value\s+FROM\s+kv\s+WHERE\s+key\s*=\s*\?/i.test(sql)) {
            return { value: store.get(String(params[0])) ?? null }
          }
          return null
        },
        async all() {
          if (/SELECT\s+key\s+FROM\s+kv\s+WHERE\s+key\s+LIKE\s*\?/i.test(sql)) {
            const prefix = String(params[0]).replace(/%$/, "")
            return {
              results: [...store.keys()]
                .filter((k) => k.startsWith(prefix))
                .map((k) => ({ key: k })),
            }
          }
          return { results: [] }
        },
        async run() {
          if (/INSERT\s+OR\s+REPLACE\s+INTO\s+kv\s*\(key,\s*value\)/i.test(sql)) {
            store.set(String(params[0]), String(params[1]))
          } else if (/DELETE\s+FROM\s+kv\s+WHERE\s+key\s*=\s*\?/i.test(sql)) {
            store.delete(String(params[0]))
          }
          return { success: true }
        },
      }
      return stmt
    },
    async batch(stmts: any[]) {
      for (const s of stmts) await s.run()
      return []
    },
  }
}

test("secret persistence: write/read works with explicit DB_DRIVER=d1", async () => {
  // 迴歸：此前 readPersistedSecret/writePersistedSecret 僅走 getKvBinding，
  // 而 getKvBinding 不識別 D1，導致 DB_DRIVER=d1 時密鑰既讀不到也寫不進，
  // 每次冷啟動都會生成新的隨機 JWT_SECRET，使多實例簽發/驗籤密鑰不一致，
  // 表現為下載與播放報 "sign verify failed"（401）。
  const d1 = createMockD1Binding()
  const env = { DB_DRIVER: "d1", DB_FORMAT: "key", DB: d1 }

  const written = await writePersistedSecret(
    env,
    "openlist_jwt_secret",
    "stable-secret-value-with-enough-length",
  )
  assert.equal(written, true)
  assert.equal(
    d1.store.get("openlist_jwt_secret"),
    "stable-secret-value-with-enough-length",
  )

  // 寫進去必須能讀回來（修復前該斷言會失敗）
  assert.equal(
    await readPersistedSecret(env, "openlist_jwt_secret"),
    "stable-secret-value-with-enough-length",
  )

  // 不存在的鍵返回 null，且不得拋錯
  assert.equal(await readPersistedSecret(env, "missing-key"), null)
})

test("secret persistence: degrades gracefully when no backend is available", async () => {
  // 未配置任何儲存時：讀返回 null、寫返回 false，不得拋錯。
  const env = { DB_DRIVER: "kv" }
  assert.equal(await readPersistedSecret(env, "openlist_jwt_secret"), null)
  assert.equal(
    await writePersistedSecret(env, "openlist_jwt_secret", "x"),
    false,
  )
})

test("getKvBinding: 同一 env 僅解析一次（含 mode=none），重複調用返回同一快取對象", async () => {
  // 迴歸：此前僅有「成功」的綁定會被快取，`mode=none` 直接 return，於是每次
  // 調用都會重新探測 env.KV / globalThis.KV、重試 Blob SDK 初始化，並重新打印
  // 一次告警。登入失敗計數、註銷黑名單、審計日誌讀寫都在這條路徑上
  // （serverless 日誌被同一行刷屏的來源之一）。
  const { getKvBinding } = await import("./json")
  const env: any = { DB_DRIVER: "auto" }

  const warns: string[] = []
  const origWarn = console.warn
  console.warn = (...args: any[]) => {
    warns.push(String(args[0]))
  }
  try {
    const first = await getKvBinding(env)
    const second = await getKvBinding(env)
    // 關鍵斷言：同一 env 的第二次調用命中快取（同一對象引用），
    // 因此既不重複探測，也不重複告警。
    assert.equal(second, first, "同一 env 應返回同一快取對象")
  } finally {
    console.warn = origWarn
  }

  assert.ok(
    warns.filter((w) => w.includes("getKvBinding")).length <= 1,
    "「未探測到 KV 綁定」的告警每個進程最多打印一次",
  )
})
