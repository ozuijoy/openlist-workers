/**
 * OpenList 資料庫 Durable Object（SQLite 儲存後端）。
 *
 * 調研結論（2026-09）：
 * - Durable Objects 提供內置 SQLite 儲存（`ctx.storage.sql`），自 2024 年 GA，
 *   需要 `wrangler.toml` 的 migrations 聲明 `new_sqlite_classes = ["OpenListDB"]`。
 * - 強一致性 + 事務，適合需要一致性的單租戶部署。
 * - 限制：單 DO 實例有 CPU/記憶體/儲存上限，高吞吐場景需自行分片；按計算與
 *   SQL 讀寫計費，成本高於 D1/KV。
 * - 與 D1 相比：D1 是無伺服器的全局 SQLite，DO 是「有狀態對象 + 內嵌 SQLite」。
 *   本項目的鍵值/列式兩種格式 DO 均可支持。
 *
 * 通過 RPC 調用（stub.kvGet / sqlQuery 等），每個實例用 `idFromName` 定位到
 * 固定實例，保證資料持久在同一 DO 實例。
 */
import { D1_SCHEMA, KV_SCHEMA_SQLITE } from "../internal/model/store/schema"

export class OpenListDB {
  private state: any

  constructor(state: any) {
    this.state = state
  }

  /** SQLite Storage API（僅 SQLite 後端的 DO 可用）。 */
  private get sql(): any {
    return (this.state.storage as any).sql
  }

  /** 建表（冪等）：KV 表（map/key 格式）+ 列式表（sql 格式）。 */
  private ensureSchema(): void {
    for (const ddl of [...KV_SCHEMA_SQLITE, ...D1_SCHEMA]) {
      this.sql.exec(ddl)
    }
  }

  async init(): Promise<void> {
    this.ensureSchema()
  }

  // ---- 鍵值操作（map/key 格式）----

  async kvGet(key: string): Promise<string | null> {
    this.ensureSchema()
    const rows = this.sql
      .exec("SELECT value FROM kv WHERE key = ?", key)
      .toArray()
    return rows[0]?.value ?? null
  }

  async kvPut(key: string, value: string): Promise<void> {
    this.ensureSchema()
    this.sql.exec(
      "INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)",
      key,
      value,
    )
  }

  async kvDelete(key: string): Promise<void> {
    this.ensureSchema()
    this.sql.exec("DELETE FROM kv WHERE key = ?", key)
  }

  async kvList(prefix: string): Promise<string[]> {
    this.ensureSchema()
    const rows = this.sql
      .exec("SELECT key FROM kv WHERE key LIKE ? ORDER BY key", `${prefix}%`)
      .toArray()
    return rows.map((r: any) => r.key)
  }

  // ---- SQL 操作（sql 格式）----

  async sqlQuery(sql: string, params: any[]): Promise<any[]> {
    this.ensureSchema()
    return this.sql.exec(sql, ...params).toArray()
  }

  async sqlExecute(sql: string, params: any[]): Promise<void> {
    this.ensureSchema()
    this.sql.exec(sql, ...params)
  }

  async sqlBatch(
    statements: Array<{ sql: string; params: any[] }>,
  ): Promise<void> {
    this.ensureSchema()
    // 事務內批量執行，保證「清空 + 重寫」的原子性
    ;(this.state.storage as any).transactionSync(() => {
      for (const { sql, params } of statements) {
        this.sql.exec(sql, ...params)
      }
    })
  }

  async health(): Promise<void> {
    this.ensureSchema()
    this.sql.exec("SELECT 1")
  }
}
