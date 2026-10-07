/**
 * 關係型後端（D1 / MySQL）的表結構定義。
 *
 * 與 Go 後端（OpenList-Backends）完全一致的**列式表**結構：每個欄位對應一列，
 * 而非「主鍵 + data JSON」的鍵值寬表。欄位名對齊 Go 的 `json` tag（snake_case），
 * 因此 D1 / MySQL 中的表結構與 Go 的 GORM 建表結果一致。
 *
 * 類型映射（TS 對象欄位 → SQL 列）：
 *   - string → TEXT
 *   - number → INTEGER（id/role/permission/order 等整型）
 *   - bool   → INTEGER（0/1）
 *   - json   → TEXT（數組/對象，序列化為 JSON 字符串）
 *   - date   → TEXT（ISO 8601 時間字符串）
 *
 * 注意：`key` / `order` / `group` / `index` / `write` 等在 SQL 方言中可能是保留字，
 * 所有列名統一用反引號包裹（SQLite 與 MySQL 均支持）。
 */

/**
 * 參與資料往返（load/save）的表。
 *
 * 這些表的內容由 `db.ts` 的配置對象持有，全量讀寫是有意義的。
 *
 * 注意：**不包含 sshkeys**。TS 側 SSH 公鑰存在 `user.ssh_keys` 內，
 * 從不讀寫頂層的 `db.sshkeys`；而 Go 後端把公鑰存於獨立的
 * `x_ssh_public_keys` 表。若把 sshkeys 納入往返，`sqlFormat.save()` 會執行
 * `DELETE FROM x_ssh_public_keys` 再寫入空數組，**清空 Go 寫入的 SSH 公鑰**。
 * 因此這裡刻意排除，僅保留其 DDL（見 TABLES），與 Go 共享同一物理庫時
 * 既不破壞也不接管該表。
 */
export const TABLE_NAMES = [
  "settings",
  "storages",
  "users",
  "shares",
  "metas",
  "plugins",
] as const

export type TableName = (typeof TABLE_NAMES)[number]

/**
 * 需要建表（DDL）的全部表，含不參與往返的 sshkeys。
 *
 * 與 TABLE_NAMES 分離：建表仍覆蓋 sshkeys，便於與 Go 後端共享物理庫時
 * 表結構一致；但讀寫（load/save/batch）僅針對 TABLE_NAMES。
 */
export const DDL_TABLE_NAMES = [...TABLE_NAMES, "sshkeys"] as const
export type DdlTableName = (typeof DDL_TABLE_NAMES)[number]

/** 欄位類型（決定序列化與 SQL 列類型）。 */
export type FieldType = "string" | "number" | "bool" | "json" | "date"

/** 列定義。 */
export interface ColumnDef {
  /** SQL 列名（snake_case，對齊 Go json tag）。 */
  name: string
  /** 對象欄位名（默認與 name 相同）。 */
  key?: string
  /** 欄位類型。 */
  type: FieldType
  /** 是否主鍵。 */
  pk?: boolean
  /** 是否唯一索引。 */
  unique?: boolean
  /** 是否可空（主鍵默認為不可空）。 */
  nullable?: boolean
}

/** 表定義。 */
export interface TableDef {
  name: DdlTableName
  columns: ColumnDef[]
}

/**
 * 每張表的主鍵對應的「對象欄位名」（用於從實體對象提取主鍵值）。
 * 供 key 格式（分 key 儲存）與 SQL 格式共用。
 *
 * 覆蓋全部 DDL 表（含 sshkeys），以便建表與反射邏輯完整；
 * 參與往返的表由 TABLE_NAMES 決定。
 */
export const TABLE_KEY: Record<DdlTableName, string> = {
  settings: "key",
  storages: "id",
  users: "id",
  shares: "id",
  metas: "id",
  plugins: "id",
  sshkeys: "id",
}

/** 主鍵值統一序列化為字符串，避免數字/字符串 id 混用導致的主鍵類型漂移。 */
export function keyOf(table: TableName, entity: any): string {
  return String(entity?.[TABLE_KEY[table]] ?? "")
}

/**
 * 完整列式表定義。
 *
 * 欄位與 Go 後端模型一一對應（json tag）：
 *   - settings ← model.SettingItem
 *   - storages ← model.Storage
 *   - users    ← model.User（含 TS 特有的 pwd_update_at）
 *   - shares   ← model.SharingDB（Files 序列化自 []string）
 *   - metas    ← model.Meta
 *   - plugins  ← TS 獨有（Go 無插件表）
 */
export const TABLES: Record<DdlTableName, TableDef> = {
  settings: {
    name: "settings",
    columns: [
      { name: "key", type: "string", pk: true },
      { name: "value", type: "string", nullable: true },
      { name: "help", type: "string", nullable: true },
      { name: "type", type: "string", nullable: true },
      { name: "options", type: "string", nullable: true },
      { name: "group", type: "number", nullable: true },
      { name: "flag", type: "number", nullable: true },
      { name: "index", type: "number", nullable: true },
    ],
  },

  storages: {
    name: "storages",
    columns: [
      { name: "id", type: "number", pk: true },
      { name: "mount_path", type: "string", unique: true },
      { name: "order", type: "number", nullable: true },
      { name: "driver", type: "string", nullable: true },
      { name: "cache_expiration", type: "number", nullable: true },
      { name: "custom_cache_policies", type: "string", nullable: true },
      { name: "status", type: "string", nullable: true },
      { name: "addition", type: "string", nullable: true },
      { name: "remark", type: "string", nullable: true },
      { name: "modified", type: "date", nullable: true },
      { name: "disabled", type: "bool", nullable: true },
      { name: "disable_index", type: "bool", nullable: true },
      { name: "enable_sign", type: "bool", nullable: true },
      { name: "seed_policy", type: "string", nullable: true },
      { name: "order_by", type: "string", nullable: true },
      { name: "order_direction", type: "string", nullable: true },
      { name: "extract_folder", type: "string", nullable: true },
      { name: "web_proxy", type: "bool", nullable: true },
      { name: "webdav_policy", type: "string", nullable: true },
      { name: "proxy_range", type: "bool", nullable: true },
      { name: "down_proxy_url", type: "string", nullable: true },
      { name: "disable_proxy_sign", type: "bool", nullable: true },
    ],
  },

  users: {
    name: "users",
    columns: [
      { name: "id", type: "number", pk: true },
      { name: "username", type: "string", unique: true },
      { name: "password", type: "string", nullable: true },
      { name: "base_path", type: "string", nullable: true },
      { name: "role", type: "number", nullable: true },
      { name: "disabled", type: "bool", nullable: true },
      { name: "permission", type: "number", nullable: true },
      { name: "salt", type: "string", nullable: true },
      { name: "otp_secret", type: "string", nullable: true },
      { name: "sso_id", type: "string", nullable: true },
      { name: "authn", type: "string", nullable: true },  // WebAuthn credentials JSON
      { name: "allow_ldap", type: "bool", nullable: true },
      // TS 特有：密碼更新時間（Go 用 pwd_ts/pwd_hash/salt 內部欄位，json:"-" 不落 API）
      { name: "pwd_update_at", type: "date", nullable: true },
    ],
  },

  shares: {
    name: "shares",
    columns: [
      { name: "id", type: "string", pk: true },
      // Go 的 SharingDB.FilesRaw（json:"-" 但落庫，列名 files_raw）存 []string 的 JSON；
      // TS 業務對象欄位名為 files，通過 key 欄位解耦列名與對象欄位名。
      { name: "files_raw", key: "files", type: "json", nullable: true },
      { name: "expires", type: "date", nullable: true },
      { name: "pwd", type: "string", nullable: true },
      { name: "accessed", type: "number", nullable: true },
      { name: "max_accessed", type: "number", nullable: true },
      { name: "creator_id", type: "number", nullable: true },
      { name: "disabled", type: "bool", nullable: true },
      { name: "remark", type: "string", nullable: true },
      { name: "readme", type: "string", nullable: true },
      { name: "header", type: "string", nullable: true },
      { name: "order_by", type: "string", nullable: true },
      { name: "order_direction", type: "string", nullable: true },
      { name: "extract_folder", type: "string", nullable: true },
    ],
  },

  metas: {
    name: "metas",
    columns: [
      { name: "id", type: "number", pk: true },
      { name: "path", type: "string", unique: true },
      { name: "read_users", type: "json", nullable: true },
      { name: "read_users_sub", type: "bool", nullable: true },
      { name: "write_users", type: "json", nullable: true },
      { name: "write_users_sub", type: "bool", nullable: true },
      { name: "password", type: "string", nullable: true },
      { name: "p_sub", type: "bool", nullable: true },
      { name: "write", type: "bool", nullable: true },
      { name: "w_sub", type: "bool", nullable: true },
      { name: "hide", type: "string", nullable: true },
      { name: "h_sub", type: "bool", nullable: true },
      { name: "readme", type: "string", nullable: true },
      { name: "r_sub", type: "bool", nullable: true },
      { name: "header", type: "string", nullable: true },
      { name: "header_sub", type: "bool", nullable: true },
    ],
  },

  sshkeys: {
    name: "sshkeys",
    columns: [
      { name: "id", type: "number", pk: true },
      { name: "user_id", type: "number", nullable: true },   // json:"-" 不走 API 但落庫
      { name: "title", type: "string", nullable: true },
      { name: "fingerprint", type: "string", nullable: true },
      { name: "key_str", type: "string", nullable: true },   // gorm:"type:text" json:"-"
      { name: "added_time", type: "date", nullable: true },
      { name: "last_used_time", type: "date", nullable: true },
    ],
  },

  plugins: {
    name: "plugins",
    columns: [
      { name: "id", type: "string", pk: true },
      { name: "name", type: "string", nullable: true },
      { name: "version", type: "string", nullable: true },
      { name: "description", type: "string", nullable: true },
      { name: "author", type: "string", nullable: true },
      { name: "homepage", type: "string", nullable: true },
      { name: "repository", type: "string", nullable: true },
      { name: "icon", type: "string", nullable: true },
      { name: "type", type: "string", nullable: true },
      { name: "enabled", type: "bool", nullable: true },
      { name: "high_privilege", type: "bool", nullable: true },
      { name: "permissions", type: "json", nullable: true },
      { name: "entry_url", type: "string", nullable: true },
      { name: "script_content", type: "string", nullable: true },
      { name: "style_content", type: "string", nullable: true },
      { name: "config_schema", type: "json", nullable: true },
      { name: "config_values", type: "json", nullable: true },
      { name: "target_hooks", type: "json", nullable: true },
      { name: "is_builtin", type: "bool", nullable: true },
      { name: "tags", type: "json", nullable: true },
      { name: "created_at", type: "date", nullable: true },
      { name: "updated_at", type: "date", nullable: true },
    ],
  },
}

/**
 * SQL 表名映射：TS 分組名 → Go 的 GORM 複數表名（不含前綴）。
 *
 * Go 用 GORM 默認命名策略：結構體名 snake_case + 複數，例如：
 *   - SettingItem → setting_items
 *   - SharingDB   → sharing_dbs
 *   - Storage → storages / User → users / Meta → metas
 *
 * TS 內部對象分組仍用 settings/shares（對齊 db.ts 的對象欄位名），落庫時
 * 通過本映射轉換為 Go 的複數表名，實現與 Go 後端共享同一資料庫。
 *
 * plugins 為 TS 獨有（Go 無插件表），沿用複數名 plugins。
 */
export const TABLE_SQL_NAMES: Record<DdlTableName, string> = {
  settings: "setting_items",
  storages: "storages",
  users: "users",
  shares: "sharing_dbs",
  metas: "metas",
  plugins: "plugins",
  sshkeys: "ssh_public_keys",
}

/**
 * 表前綴，固定為 "x_"（對齊 Go 後端的默認值）。
 */
export function getTablePrefix(_env?: any): string {
  return "x_"
}

/**
 * 返回某張表在 SQL 中的完整表名（前綴 + 複數名）。
 */
export function tableSqlName(table: DdlTableName, env?: any): string {
  return getTablePrefix(env) + TABLE_SQL_NAMES[table]
}

/**
 * 對象欄位值 → SQL 列值。
 */
export function serializeColumn(col: ColumnDef, value: any): any {
  if (value === undefined || value === null) {
    // 主鍵不能為 null，直接返回 null 讓調用方處理
    if (col.pk) return null
    // 可空列（nullable: true）直接存 null
    if (col.nullable) return null
    // 其餘列（舊錶可能有 NOT NULL 約束）按類型返回無害默認值
    switch (col.type) {
      case "string": return ""
      case "number": return 0
      case "bool":   return 0
      case "json":   return "null"
      case "date":   return ""
      default:       return ""
    }
  }
  switch (col.type) {
    case "string":
      return String(value)
    case "number":
      return typeof value === "number" ? value : Number(value)
    case "bool":
      return value ? 1 : 0
    case "json":
      return typeof value === "string" ? value : JSON.stringify(value)
    case "date": {
      if (value instanceof Date) return value.toISOString()
      if (typeof value === "number") return new Date(value).toISOString()
      return String(value)
    }
    default:
      return value
  }
}

/**
 * SQL 列值 → 對象欄位值。
 */
export function deserializeColumn(col: ColumnDef, value: any): any {
  if (value === undefined || value === null) {
    if (col.type === "json") return null
    return null
  }
  switch (col.type) {
    case "string": {
      const s = String(value)
      // 空字符串視為 null，避免 "" 被當作有效密碼/哈希值
      return s === "" ? null : s
    }
    case "number":
      return Number(value)
    case "bool":
      return value === 1 || value === "1" || value === true || value === "true"
    case "json": {
      if (typeof value !== "string") return value
      try {
        return JSON.parse(value)
      } catch {
        return value
      }
    }
    case "date":
      return value
    default:
      return value
  }
}

/**
 * 將一行 SQL 記錄（SELECT * 結果）轉換回對象。
 *
 * 跳過 null/undefined 列：列式表的「缺失欄位」以 NULL 儲存，反序列化時不
 * 輸出這些欄位，避免 roundtrip 後對象被注入大量 null 鍵（與 map/key 格式
 * 的對象形態保持一致）。
 */
export function rowToEntity(table: DdlTableName, row: any): any {
  const def = TABLES[table]
  const out: any = {}
  for (const col of def.columns) {
    const key = col.key ?? col.name
    const value = deserializeColumn(col, row[col.name])
    if (value !== null && value !== undefined) {
      out[key] = value
    }
  }
  return out
}

/**
 * 將對象轉換為 INSERT 的列與參數。
 */
export function entityToRow(table: DdlTableName, entity: any): {
  columns: string[]
  values: any[]
} {
  const def = TABLES[table]
  const columns: string[] = []
  const values: any[] = []
  for (const col of def.columns) {
    const key = col.key ?? col.name
    columns.push(col.name)
    values.push(serializeColumn(col, entity?.[key]))
  }
  return { columns, values }
}

/** SQL 列類型 → 方言類型。 */
function sqlType(col: ColumnDef, dialect: "sqlite" | "mysql"): string {
  switch (col.type) {
    case "number":
      return dialect === "mysql" ? "BIGINT" : "INTEGER"
    case "bool":
      return dialect === "mysql" ? "TINYINT(1)" : "INTEGER"
    case "string":
    case "json":
    case "date":
      return "TEXT"
    default:
      return "TEXT"
  }
}

/** 列標識符統一加反引號（SQLite 與 MySQL 均支持）。 */
function quote(name: string): string {
  return "`" + name + "`"
}

/**
 * 生成單張表的建表語句（含主鍵與唯一索引）。
 */
function buildTableDdl(
  def: TableDef,
  dialect: "sqlite" | "mysql",
  tableName: string,
): string {
  const parts: string[] = []
  for (const col of def.columns) {
    let line = `${quote(col.name)} ${sqlType(col, dialect)}`
    if (col.pk) {
      line += " PRIMARY KEY"
    } else if (!col.nullable) {
      line += " NOT NULL"
    }
    if (col.unique) {
      line += " UNIQUE"
    }
    parts.push(line)
  }
  return `CREATE TABLE IF NOT EXISTS ${quote(tableName)} (${parts.join(", ")})`
}

/**
 * 生成 schema_info 表（標記 SQL 格式是否已初始化）。
 */
function buildSchemaInfoDdl(dialect: "sqlite" | "mysql"): string {
  const k = dialect === "mysql" ? "VARCHAR(255)" : "TEXT"
  const v = "TEXT"
  return `CREATE TABLE IF NOT EXISTS ${quote("schema_info")} (${quote("k")} ${k} PRIMARY KEY, ${quote("v")} ${v})`
}

/**
 * 生成完整的建表語句數組（冪等）。表名固定為 "x_" 前綴（對齊 Go），
 * 複數表名對齊 Go 的 GORM 命名策略。
 */
export function buildDdl(dialect: "sqlite" | "mysql", env?: any): string[] {
  const out: string[] = [buildSchemaInfoDdl(dialect)]
  // 建表覆蓋全部 DDL 表（含不參與往返的 sshkeys），保證與 Go 共享庫時結構一致
  for (const name of DDL_TABLE_NAMES) {
    out.push(buildTableDdl(TABLES[name], dialect, tableSqlName(name, env)))
  }
  return out
}

/** 相容舊導出：SQLite（Cloudflare D1）方言建表語句。 */
export const D1_SCHEMA: string[] = buildDdl("sqlite")

/** 相容舊導出：MySQL 方言建表語句。 */
export const MYSQL_SCHEMA: string[] = buildDdl("mysql")

/**
 * KV 表（供 map/key 格式做鍵值儲存）的建表語句。
 *
 * 與「列式表」分離：map/key 格式仍然以鍵值對方式落盤，sql 格式才用上面的
 * 列式表。驅動層需同時創建這兩類表。
 */
export const KV_SCHEMA_SQLITE: string[] = [
  `CREATE TABLE IF NOT EXISTS ${quote("kv")} (${quote("key")} TEXT PRIMARY KEY, ${quote("value")} TEXT NOT NULL)`,
]

export const KV_SCHEMA_MYSQL: string[] = [
  "CREATE TABLE IF NOT EXISTS `kv` (`key` VARCHAR(512) PRIMARY KEY, `value` LONGTEXT NOT NULL)",
]
