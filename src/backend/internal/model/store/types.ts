/**
 * 持久化後端介面定義。
 *
 * 設計目標：業務層（server/*.ts、internal/op/*.ts）僅依賴 db.ts 暴露的
 * getDb()/saveDb() 等「整對象」契約，契約之下由本介面抽象出不同的持久化
 * 目標（JSON/KV/Blob、Cloudflare D1、MySQL）。
 *
 * 關鍵約定：後端收到/返回的 data 均為「已加密」的完整配置對象（加密由
 * db.ts 的 sealDb/unsealDb 在持久化邊界完成），因此後端無需關心加密細節。
 */

/** 儲存格式類型 */
export type StorageFormat = "map" | "key" | "sql"

/**
 * 運行環境上下文（平台注入的綁定與配置）。
 *
 * 允許任意鍵訪問：不同平台注入的綁定名各異（KV / DB / BLOB / ESA_BLOB …），
 * 驅動層需按平台探測，因此不做嚴格結構約束。
 */
export type EnvContext = Record<string, any>

/** 儲存驅動類型 */
export type StorageDriver = "auto" | "blob" | "cfkv" | "kv" | "d1" | "do" | "mysql"

/**
 * 驅動介面（底層 I/O）
 * 
 * 驅動負責與具體儲存系統交互（KV、Blob、D1、MySQL 等），
 * 提供統一的鍵值讀寫介面和可選的 SQL 執行介面。
 */
export interface Driver {
  /** 驅動名稱 */
  name: string

  /**
   * 檢查驅動是否可用（是否配置了必要的環境變量/綁定）
   */
  isAvailable(env?: any): Promise<boolean>

  /**
   * 初始化驅動（建表、遷移等）
   */
  init(env?: any): Promise<void>

  /**
   * 鍵值操作（用於 map/key 格式）
   */
  get(key: string, env?: any): Promise<string | null>
  put(key: string, value: string, env?: any): Promise<void>
  delete(key: string, env?: any): Promise<void>
  list(prefix: string, env?: any): Promise<string[]>

  /**
   * SQL 操作（用於 sql 格式，可選）
   */
  query?(sql: string, params: any[], env?: any): Promise<any[]>
  execute?(sql: string, params: any[], env?: any): Promise<void>
  batch?(
    statements: Array<{ sql: string; params: any[] }>,
    env?: any
  ): Promise<void>

  /**
   * 健康檢查
   */
  health(env?: any): Promise<any>
}

/**
 * 格式適配器介面
 * 
 * 格式適配器決定資料如何在驅動中儲存和讀取：
 * - map: 整對象 JSON（單個 key）
 * - key: 分 key 儲存（每個實體一條記錄）
 * - sql: 關係表（與 Go 後端一致）
 */
export interface FormatAdapter {
  /** 格式名稱 */
  name: string

  /**
   * 加載完整資料
   */
  load(driver: Driver, env?: any): Promise<any | null>

  /**
   * 保存完整資料
   */
  save(data: any, driver: Driver, env?: any): Promise<boolean>

  /**
   * 單表操作（可選，用於性能優化）
   */
  getTable?(table: string, driver: Driver, env?: any): Promise<any[]>
  saveTable?(
    table: string,
    records: any[],
    driver: Driver,
    env?: any
  ): Promise<void>

  /**
   * 單記錄操作（可選，用於性能優化）
   */
  getRecord?(
    table: string,
    key: string,
    driver: Driver,
    env?: any
  ): Promise<any | null>
  saveRecord?(
    table: string,
    key: string,
    record: any,
    driver: Driver,
    env?: any
  ): Promise<void>
  deleteRecord?(
    table: string,
    key: string,
    driver: Driver,
    env?: any
  ): Promise<void>
}

/**
 * 儲存後端介面（整配置對象讀寫）。
 *
 * 這是 `Driver` + `FormatAdapter` 之上的適配層，由 `backend.ts` 的
 * `getStoreBackend()` 組裝後供 `db.ts` 使用，屏蔽底層驅動/格式差異。
 */
export interface StoreBackend {
  /** 後端標識名 */
  readonly name: string
  /** 讀取完整配置對象（已加密）。無資料時返回 null（由上層回退到默認值）。 */
  load(env?: any): Promise<any | null>
  /**
   * 寫入完整配置對象（已加密）。成功返回 true；未配置持久化目標時返回 false；
   * 寫入失敗應拋出異常（由上層包裝成可讀錯誤）。
   */
  save(data: any, env?: any): Promise<boolean>
  /** 是否配置了真實可用的持久化目標。未實現時視為始終已配置。 */
  isConfigured?(env?: any): Promise<boolean>
  /** 建表（D1、DO、MySQL 需要）。應冪等。 */
  init?(env?: any): Promise<void>
  /** 健康檢查，用於 /debug/info 與 /admin/kv/status。 */
  health?(env?: any): Promise<any>
}
