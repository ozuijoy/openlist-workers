/**
 * SQL 格式適配器（列式表，與 Go 後端完全一致）。
 *
 * 每個欄位對應一列，表結構由 schema.ts 的 TABLES 定義。欄位名對齊 Go 的
 * json tag，表名通過 TABLE_SQL_NAMES 映射為 Go 的複數名並加上固定前綴 "x_"
 * 前綴（默認 x_），因此 D1 / MySQL 中的表結構與 Go 的 GORM 建表結果一致。
 */
import type { FormatAdapter, Driver } from "../types"
import {
  TABLE_NAMES,
  TABLE_KEY,
  TABLES,
  TableName,
  tableSqlName,
  rowToEntity,
  entityToRow,
} from "../schema"

const INIT_MARK = "openlist_config"

function quote(name: string): string {
  return "`" + name + "`"
}

/**
 * 生成 UPSERT 語句。
 *
 * SQLite（D1 / DO）與 MySQL 語法不同，必須按方言分支：
 *   - SQLite: INSERT OR REPLACE INTO ...
 *   - MySQL:  INSERT INTO ... ON DUPLICATE KEY UPDATE ...
 *
 * 驅動名即方言標識：d1 / do 為 SQLite，mysql 為 MySQL。
 */
function upsertSql(
  table: string,
  columns: string[],
  params: any[],
  driver: Driver,
): { sql: string; params: any[] } {
  const cols = columns.map((c) => quote(c)).join(", ")
  const placeholders = columns.map(() => "?").join(", ")

  if (driver.name === "mysql") {
    // MySQL 無 INSERT OR REPLACE；用 ON DUPLICATE KEY UPDATE 覆蓋全部非主鍵列。
    // 主鍵列不參與 UPDATE（寫回自身無意義），其餘列以 VALUES(col) 覆蓋。
    const updates = columns
      .slice(1)
      .map((c) => `${quote(c)} = VALUES(${quote(c)})`)
      .join(", ")
    const sql = updates
      ? `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`
      : `INSERT INTO ${table} (${cols}) VALUES (${placeholders})`
    return { sql, params }
  }

  return {
    sql: `INSERT OR REPLACE INTO ${table} (${cols}) VALUES (${placeholders})`,
    params,
  }
}

/** 帶前綴+複數的完整表名（含反引號）。 */
function qn(table: TableName, env?: any): string {
  return quote(tableSqlName(table, env))
}

/** 列名列表（含反引號）。 */
function cols(table: TableName): string {
  return TABLES[table].columns.map((c) => quote(c.name)).join(", ")
}

export const sqlFormat: FormatAdapter = {
  name: "sql",

  async load(driver: Driver, env?: any): Promise<any | null> {
    if (!driver.query) {
      throw new Error(`Driver ${driver.name} does not support SQL queries`)
    }

    // 檢查是否已初始化（schema_info 為 TS 內部標記表，不加前綴）
    const marks = await driver.query(
      "SELECT v FROM schema_info WHERE k = ?",
      [INIT_MARK],
      env,
    )
    if (!marks || marks.length === 0) return null

    const out: Record<string, any> = {}

    for (const table of TABLE_NAMES) {
      const rows = await driver.query(`SELECT * FROM ${qn(table, env)}`, [], env)
      out[table] = rows.map((r: any) => rowToEntity(table, r))
    }

    return out
  },

  async save(data: any, driver: Driver, env?: any): Promise<boolean> {
    if (!driver.batch) {
      throw new Error(`Driver ${driver.name} does not support batch operations`)
    }

    const statements: Array<{ sql: string; params: any[] }> = []

    // 策略：**UPSERT 每行 + 刪除已不存在的行**，而非「先清空再插入」。
    //
    // 為什麼不用 DELETE 全表：DELETE 與 INSERT 之間存在「表為空」的窗口，
    // 若批量執行中途失敗，資料會整體丟失；與 Go 後端共享同一物理庫時，
    // DELETE 還會清掉 Go 側併發寫入的行。
    //
    // UPSERT 保證既有行先被覆蓋（不丟資料），再刪除本端不再持有的鍵。
    // 注意：仍需按主鍵比對以刪除"本端刪除了的記錄"，且該刪除是必要的，
    // 否則歷史殘留行不會被清理。
    for (const table of TABLE_NAMES) {
      const keyCol = TABLE_KEY[table]
      const entities: any[] = data?.[table] || []
      const keepKeys: string[] = []

      for (const entity of entities) {
        const { columns, values } = entityToRow(table, entity)
        const upsert = upsertSql(qn(table, env), columns, values, driver)
        statements.push({ sql: upsert.sql, params: upsert.params })

        const pk = entity?.[keyCol]
        if (pk !== undefined && pk !== null) keepKeys.push(String(pk))
      }

      // 刪除本端已移除的行（keys 為空則整表清空，與原語義一致）
      const delSql =
        keepKeys.length > 0
          ? `DELETE FROM ${qn(table, env)} WHERE ${quote(keyCol)} NOT IN (${keepKeys
              .map(() => "?")
              .join(", ")})`
          : `DELETE FROM ${qn(table, env)}`
      statements.push({ sql: delSql, params: keepKeys })
    }

    // 標記已初始化（方言相容的 UPSERT）
    statements.push(
      upsertSql(
        quote("schema_info"),
        ["k", "v"],
        [INIT_MARK, String(Date.now())],
        driver,
      ),
    )

    await driver.batch(statements, env)
    return true
  },

  async getTable(table: string, driver: Driver, env?: any): Promise<any[]> {
    if (!driver.query) {
      throw new Error(`Driver ${driver.name} does not support SQL queries`)
    }
    const t = table as TableName
    const rows = await driver.query(`SELECT * FROM ${qn(t, env)}`, [], env)
    return rows.map((r: any) => rowToEntity(t, r))
  },

  async saveTable(
    table: string,
    records: any[],
    driver: Driver,
    env?: any,
  ): Promise<void> {
    if (!driver.batch) {
      throw new Error(`Driver ${driver.name} does not support batch operations`)
    }
    const t = table as TableName

    const statements: Array<{ sql: string; params: any[] }> = [
      { sql: `DELETE FROM ${qn(t, env)}`, params: [] },
    ]

    for (const entity of records) {
      const { columns, values } = entityToRow(t, entity)
      const placeholders = columns.map(() => "?").join(", ")
      const sql = `INSERT INTO ${qn(t, env)} (${columns
        .map((c) => quote(c))
        .join(", ")}) VALUES (${placeholders})`
      statements.push({ sql, params: values })
    }

    await driver.batch(statements, env)
  },

  async getRecord(
    table: string,
    key: string,
    driver: Driver,
    env?: any,
  ): Promise<any | null> {
    if (!driver.query) {
      throw new Error(`Driver ${driver.name} does not support SQL queries`)
    }
    const t = table as TableName
    const keyCol = TABLE_KEY[t]
    const rows = await driver.query(
      `SELECT * FROM ${qn(t, env)} WHERE ${quote(keyCol)} = ?`,
      [key],
      env,
    )
    return rows.length > 0 ? rowToEntity(t, rows[0]) : null
  },

  async saveRecord(
    table: string,
    key: string,
    record: any,
    driver: Driver,
    env?: any,
  ): Promise<void> {
    if (!driver.execute) {
      throw new Error(`Driver ${driver.name} does not support SQL execution`)
    }
    const t = table as TableName
    void key

    const { columns, values } = entityToRow(t, record)
    // 方言相容的 UPSERT（SQLite: INSERT OR REPLACE / MySQL: ON DUPLICATE KEY UPDATE）
    const { sql } = upsertSql(qn(t, env), columns, values, driver)

    await driver.execute(sql, values, env)
  },

  async deleteRecord(
    table: string,
    key: string,
    driver: Driver,
    env?: any,
  ): Promise<void> {
    if (!driver.execute) {
      throw new Error(`Driver ${driver.name} does not support SQL execution`)
    }
    const t = table as TableName
    const keyCol = TABLE_KEY[t]
    await driver.execute(
      `DELETE FROM ${qn(t, env)} WHERE ${quote(keyCol)} = ?`,
      [key],
      env,
    )
  },
}
