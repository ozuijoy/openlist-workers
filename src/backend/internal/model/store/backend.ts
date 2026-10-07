/**
 * 持久化後端工廠：按 DB_DRIVER 和 DB_FORMAT 環境變量選擇驅動和格式。
 *
 * 新架構（驅動層 + 格式層分離）：
 * - DB_DRIVER: 底層儲存驅動（auto/blob/cfkv/kv/d1/do/mysql）
 * - DB_FORMAT: 資料儲存格式（map/key/sql）
 *
 * 向後相容（舊配置自動映射）：
 * - DB_DRIVER=json → DB_FORMAT=map + 自動檢測驅動
 */
import type {
  Driver,
  FormatAdapter,
  StorageDriver,
  StorageFormat,
  StoreBackend,
} from "./types"
import { blobDriver } from "./driver/blob"
import { cfkvDriver } from "./driver/cfkv"
import { checkProxyConfig, kvDriver } from "./driver/kv"
import { d1Driver } from "./driver/d1"
import { doDriver } from "./driver/do"
import { mysqlDriver } from "./driver/mysql"
import { memoryDriver } from "./driver/memory"
import { mapFormat } from "./format/map"
import { keyFormat } from "./format/key"
import { sqlFormat } from "./format/sql"
import {
  DB_CIPHER_VALUES,
  DEFAULT_DB_CIPHER,
  resolveDbCipher,
  type DbCipher,
} from "../../../pkg/crypto"

/**
 * 讀取環境變量（支持 process.env 和 env 對象）。
 */
function readEnv(key: string, defaultValue: string, env?: any): string {
  const e = env || (typeof process !== "undefined" ? process.env : {}) || {}
  return String(e[key] || "").trim().toLowerCase() || defaultValue
}

/**
 * 讀取儲存驅動配置。
 */
export function readDriver(env?: any): StorageDriver {
  const e = env || (typeof process !== "undefined" ? process.env : {}) || {}

  const driver = readEnv("DB_DRIVER", "auto", env) as StorageDriver

  // 向後相容：DB_DRIVER=json → auto（整對象 JSON 由 DB_FORMAT=map 表達）
  if ((driver as string) === "json") {
    console.warn(
      "[DEPRECATED] DB_DRIVER=json is deprecated. Use DB_FORMAT=map instead.",
    )
    return "auto"
  }

  return driver
}

/**
 * 讀取儲存格式配置。
 *
 * 契約（與官方文件一致）：DB_FORMAT 與 DB_DRIVER 是**正交**的兩個維度 ——
 * 前者決定「怎麼組織資料」（map / key / sql），後者決定「存到哪裡」。
 * 因此 DB_FORMAT 缺省時**一律取全局默認 map**，絕不按驅動名改寫：
 * kv / d1 / blob / do / mysql 的缺省格式都是 map。
 *
 * 歷史遺留（已移除）：舊版 DB_DRIVER=kv 承擔「分表儲存」語義，重構為
 * 「驅動層 + 格式層分離」後曾加過一條 `DB_DRIVER=kv 且無 DB_FORMAT → key`
 * 的相容映射。它的代價是「僅設了 DB_DRIVER」的結果依賴驅動名（d1 得 map、
 * kv 得 key），且升級用戶會靜默從 map 佈局切到 key 佈局（兩種佈局的鍵名
 * 不同，互相讀不到）。分表請顯式配置 DB_FORMAT=key。
 */
export function readFormat(env?: any): StorageFormat {
  const e = env || (typeof process !== "undefined" ? process.env : {}) || {}

  // 向後相容：DB_DRIVER=json → map（舊驅動別名，與 readDriver 的 json→auto 成對）
  if (String(e.DB_DRIVER || "").trim().toLowerCase() === "json") {
    return "map"
  }

  return readEnv("DB_FORMAT", "map", env) as StorageFormat
}

/**
 * 讀取資料庫欄位加密算法（DB_CIPHER）。
 *
 * 契約（與 DB_DRIVER / DB_FORMAT 同為「正交的一維」）：僅決定**敏感欄位如何
 * 落盤**，不改變儲存位置與資料組織方式。
 *
 *   none（默認）              - 不加密，敏感欄位與普通 JSON 一樣明文落盤
 *   aes-256-gcm              - HKDF-SHA256 派生一把 AES-256-GCM 密鑰（enc:v2:）
 *   aes-256-gcm-pbkdf2       - AES-256-GCM，PBKDF2-SHA256(10 萬次) 派生（enc:v1:，慢）
 *   aes-256-cbc-hmac         - AES-256-CBC + HMAC-SHA256（enc:v3:，Encrypt-then-MAC）
 *   chacha20-poly1305        - ChaCha20-Poly1305（enc:v4:，RFC 8439，純 JS）
 *   des-cbc-hmac             - 單 DES-CBC + HMAC-SHA256（enc:v5:，**僅相容，不安全**）
 *  3des-cbc-hmac             - 3DES-CBC + HMAC-SHA256（enc:v6:，**僅相容，已棄用**）
 *
 * 為什麼默認 none：加密會讓「共享庫給 Go 後端 / 直接用 SQL 查詢」變得不可讀，
 * 且讀取時需逐欄位解密（詳見 #69 的 CPU 優化）。需要靜態加密的部署顯式配置即可；
 * 歷史密文帶 `enc:vN:` 前綴，讀取時按前綴自動解密，因此從加密切回 none
 * **不會導致資料不可讀**，僅會在下次寫入時轉為明文（自動遷移）。
 *
 * DES/3DES 僅作為「非 AES 族」的相容選項存在：單 DES 的 56-bit 密鑰可被暴力破解，
 * 3DES 已被 NIST SP 800-131A 棄用，二者都不應保護真實資料（見 crypto.ts 的
 * WEAK_DB_CIPHERS 與一次性告警）。
 *
 * 取值無法識別時告警並回退 none（而不是靜默啟用某個算法）。注意：讀取時
 * 解密算法由密文前綴決定，與本函數取值無關 —— 拼錯變量僅會影響**新寫入**。
 */
export function readCipher(env?: any): DbCipher {
  const raw = readEnv("DB_CIPHER", DEFAULT_DB_CIPHER, env)
  const { cipher, known } = resolveDbCipher(raw)
  if (!known) {
    console.warn(
      `[DB] Unknown DB_CIPHER "${raw}"; falling back to "${DEFAULT_DB_CIPHER}". ` +
        `Valid values: ${DB_CIPHER_VALUES.join(", ")}.`,
    )
  }
  return cipher
}

/**
 * 是否處於 Serverless / Worker 類運行環境。
 *
 * 判定目的：這些環境（Cloudflare Workers、EdgeOne Edge/Node 雲函數、
 * 阿里雲 ESA 函數等）多實例、隨時冷啟，**記憶體儲存完全無法持久化**，
 * 且會給出「寫入成功」的假象。因此在此類環境中永不使用記憶體後端。
 *
 * 判定依據全部為運行時特徵（不依賴用戶配置），命中任一即成立：
 *  1. EdgeOne：請求上下文標記、KV/Blob 相關綁定、EdgeOne 專屬全局變量
 *  2. Cloudflare Workers：WebSocketPair / caches.default / CF 綁定
 *  3. 阿里雲 ESA：ESA 全局對象與綁定
 *  4. 通用：注入型請求上下文（__requestOrigin / __requestContext）
 */
export function isServerlessRuntime(env?: any): boolean {
  const g = globalThis as any
  try {
    // ── 通用：請求上下文由平台注入 ──
    if (env?.__requestOrigin || env?.__requestContext || env?.__makersContext) {
      return true
    }

    // ── EdgeOne ──
    if (
      env?.EDGEONE_BLOB ||
      g?.EDGEONE_BLOB ||
      typeof g?.EdgeOne !== "undefined"
    ) {
      return true
    }

    // ── Cloudflare Workers ──
    // WebSocketPair 是 Workers 運行時專有的全局構造函數
    if (typeof g.WebSocketPair === "function") return true
    // caches.default 是 Workers 的 Cache API 形態
    if (typeof g.caches !== "undefined" && g.caches?.default) return true

    // ── 阿里雲 ESA ──
    if (
      env?.ESA_BLOB ||
      g?.ESA_BLOB ||
      typeof g?.ESA !== "undefined"
    ) {
      return true
    }

    // ── EdgeOne Node 雲函數環境變量特徵 ──
    // 平台會注入 SCF 相關變量，可據此識別（固定變量名，平台自動注入）
    if (
      env?.TENCENTCLOUD_SCF_FUNCTIONNAME ||
      (typeof process !== "undefined" && process.env?.TENCENTCLOUD_SCF_FUNCTIONNAME)
    ) {
      return true
    }
  } catch {
    // 檢測自身的異常不應影響判定；保守視為非 serverless（本地/容器）
  }
  return false
}

/**
 * 自動檢測可用的驅動（優先級：mysql → d1 → kv → cfkv → blob → do）。
 *
 * mysql 僅在顯式配置連接信息時參與探測（詳見 hasMysqlConfig）。
 *
 * 若全部不可用：
 *  - 本地/容器環境：回退記憶體（便於開發調試）
 *  - Serverless / Worker 環境：**不回退記憶體**，拋錯並引導用戶配置，
 *    避免「操作成功但資料丟失」的假象
 */
async function autoDetectDriver(env?: any): Promise<Driver> {
  // 檢測順序：mysql → d1 → kv → cfkv → blob → do
  //
  // - mysql 需要網路連接，僅有顯式配置了連接信息才嘗試，否則每次 auto 探測
  //   都會先嚐試建 TCP 連接（失敗後繼續），在 CF/EO 等邊緣環境上純屬浪費。
  // - kv 與 cfkv 同為 KV 語義：優先本地 binding（更直接、更快），
  //   其次才走 Cloudflare REST API。
  const candidates: Driver[] = []

  if (hasMysqlConfig(env)) candidates.push(mysqlDriver)
  candidates.push(d1Driver, kvDriver, cfkvDriver, blobDriver, doDriver)

  for (const driver of candidates) {
    if (await driver.isAvailable(env)) {
      console.log(`[DB] Auto-detected driver: ${driver.name}`)
      return driver
    }
  }

  if (isServerlessRuntime(env)) {
    // 禁止在 serverless 環境靜默使用記憶體儲存。
    //
    // 這裡必須帶上 hint（否則 hintOf(err) 為 null，上層會回退到「Bind a storage
    // backend or set DB_DRIVER=auto」這句通用話術）。該話術在 auto 模式下會形成
    // **循環建議**：用戶本來就已經是 auto，卻被告知「請設置 auto」。
    // 能走到這裡說明「auto 已探測過所有候選驅動且一個都不可用」，因此真正缺的是
    // **綁定**，而不是改配置值 —— hint 要說清「綁什麼」。
    throw storeError(
      "NO_STORAGE",
      NO_STORAGE_MESSAGE,
      noStorageHint(env),
    )
  }

  console.warn(
    "[DB] No storage binding detected, falling back to memory (data will not persist).",
  )
  return memoryDriver
}

/**
 * 是否顯式配置了 MySQL 連接信息。
 *
 * 用於決定 auto 模式是否嘗試 mysql 驅動：MySQL 是網路連接，
 * 無配置時探測會產生無謂的 TCP 建連開銷，必須由運維顯式聲明。
 */
function hasMysqlConfig(env?: any): boolean {
  const e = env || {}
  const p = typeof process !== "undefined" ? process.env || {} : {}
  return Boolean(
    e.MYSQL_URLS ||
      p.MYSQL_URLS ||
      e.MYSQL_HOST ||
      p.MYSQL_HOST,
  )
}

/**
 * 無可用儲存時的一句話修復建議（英文），隨運行時平台給出「綁什麼」。
 *
 * ## 為什麼不能複用「set DB_DRIVER=auto」
 *
 * auto 模式下 `DB_DRIVER` **本來就是 auto**。此時還提示「set DB_DRIVER=auto」，
 * 用戶會陷入循環：改也改過了、報錯依舊。真實原因是「auto 已把所有候選驅動探測
 * 了一遍，一個都不可用」——缺的是**平台側綁定**，不是配置值。
 *
 * 因此這裡按平台給出可執行動作，並**明確點出 auto 已經試過了**，避免用戶再去
 * 改那個已經正確的變量。
 *
 * 與 `driverNotAvailableHint` 的區別：那個分支處理「顯式指定了某個不可用的
 * 驅動」；本函數處理「未指定（或 auto）且沒有任何驅動可用」。
 */
function noStorageHint(env?: any): string {
  const g = globalThis as any
  const isEdgeOne =
    Boolean(env?.EDGEONE_BLOB || g?.EDGEONE_BLOB) ||
    typeof g?.EdgeOne !== "undefined" ||
    Boolean(
      env?.TENCENTCLOUD_SCF_FUNCTIONNAME ||
        (typeof process !== "undefined" &&
          process.env?.TENCENTCLOUD_SCF_FUNCTIONNAME),
    )
  const isEsa = Boolean(env?.ESA_BLOB || g?.ESA_BLOB) || typeof g?.ESA !== "undefined"
  // 無 CF 專屬綁定特徵時才可能是 CF；ESA/EdgeOne 已在上方排除
  const isCloudflare = !isEdgeOne && !isEsa

  if (isEdgeOne) {
    return (
      "DB_DRIVER=auto already probed every driver. On EdgeOne, bind a Blob " +
      "store (or enable the EdgeOne Blob SDK), or bind a KV namespace to an " +
      "Edge Function and proxy it (Node functions do not receive KV bindings)."
    )
  }
  if (isEsa) {
    return (
      "DB_DRIVER=auto already probed every driver. On Alibaba ESA, bind an " +
      "ESA_BLOB store, or set DB_DRIVER=blob."
    )
  }
  if (isCloudflare) {
    return (
      "DB_DRIVER=auto already probed every driver. On Cloudflare Workers, add " +
      'a binding to wrangler.jsonc: D1 as {"d1_databases":[{"binding":"DB"}]} ' +
      'or KV as {"kv_namespaces":[{"binding":"KV"}]}, then redeploy so the ' +
      "binding is injected."
    )
  }
  return (
    "DB_DRIVER=auto already probed every driver. Bind a persistent backend " +
    "(Cloudflare: D1/KV; EdgeOne: Blob; ESA: ESA_BLOB), then redeploy."
  )
}

/**
 * 無可用儲存驅動時的錯誤信息（英文）。
 *
 * 面向用戶，需說明「為什麼失敗」與「如何解決」。
 */
export const NO_STORAGE_MESSAGE =
  "No storage backend is available. Data cannot be persisted in this " +
  "runtime (serverless environments cannot use in-memory storage).\n" +
  "Configure one of the following:\n" +
  "  1. EdgeOne Blob (recommended, zero config if the project provides it)\n" +
  "  2. EdgeOne KV: bind a KV namespace to Edge Functions, then set " +
  "DB_DRIVER=kv (DB_FORMAT=map or key) and JWT_SECRET\n" +
  "  3. Cloudflare KV / D1: bind the namespace and set DB_DRIVER accordingly\n" +
  "Environment variables to set in the project settings:\n" +
  "  DB_DRIVER=blob | kv | cfkv | d1 | do | mysql\n" +
  "  DB_FORMAT=map | key | sql"

/**
 * 顯式指定 DB_DRIVER=memory 但運行在 serverless 環境時的錯誤文案。
 *
 * 語義裁決：`memory` 是**合法驅動名**（不是拼寫錯誤），但僅在本地 Node 運行時
 * 有效。serverless（EdgeOne / Cloudflare / ESA）多實例、隨時冷啟，記憶體寫入
 * 立刻隨實例銷燬而消失，卻仍向調用方返回成功 —— 屬於最危險的「靜默資料丟失」，
 * 因此在此環境下一律判為「無可用儲存」（NO_STORAGE）。
 *
 * 文案約束（見 server/storage-error.ts 的 reasonLines）：診斷介面僅透傳前 3 行，
 * 因此結論、原因、下一步動作必須全部落在前 3 行內。
 */
export const MEMORY_SERVERLESS_MESSAGE =
  'DB_DRIVER="memory" is only valid on a local Node runtime.\n' +
  "This deployment is serverless, where in-memory storage loses all data immediately.\n" +
  "Set DB_DRIVER=auto, or bind a persistent backend (D1 / KV / Blob)."

/** 驅動名 → 實現（memory 不在此表中，由 resolveDriver 單獨處理，見下） */
const DRIVER_MAP: Record<string, Driver> = {
  blob: blobDriver,
  cfkv: cfkvDriver,
  kv: kvDriver,
  d1: d1Driver,
  do: doDriver,
  mysql: mysqlDriver,
}

/**
 * 儲存配置類錯誤的機器可讀分類。
 *
 * 供 /public/env_check 與 /public/init_status 把「為什麼不能用」透給前端：
 * 僅給一句 "Storage driver is not configured correctly." 用戶無法區分
 * 「組合寫錯」「綁定沒配」「密鑰缺失」「後端讀不到」。
 */
export type StoreConfigErrorCode =
  | "INVALID_COMBINATION"
  | "DRIVER_UNAVAILABLE"
  | "UNKNOWN_DRIVER"
  | "NO_STORAGE"
  | "PROXY_CONFIG"
  | "HEALTH_ERROR"
  | "DRIVER_ERROR"

/**
 * 構造帶分類碼的錯誤，供 getStoreStatus 摺疊成 configErrorCode。
 *
 * `hint` 是給用戶看的**一句話修復建議**（「改什麼」），與 `message`（完整排查
 * 說明）分開：
 *   - message 在診斷介面裡會被截斷（見 server/public.ts 的 reasonLines），
 *     僅透傳前 3 行，因此「答案」不能僅放在 message 末尾；
 *   - 前端需要把建議放在顯眼位置單獨展示，靠解析 message 文案不可靠。
 */
function storeError(
  code: StoreConfigErrorCode,
  message: string,
  hint?: string,
): Error {
  const err = new Error(message) as Error & {
    storeCode?: StoreConfigErrorCode
    storeHint?: string
  }
  err.storeCode = code
  if (hint) err.storeHint = hint
  return err
}

/** 讀取錯誤上的一句話修復建議（沒有則返回 null）。 */
function hintOf(err: any): string | null {
  const hint = err?.storeHint
  return typeof hint === "string" && hint.trim() ? hint.trim() : null
}

/** 讀取錯誤上的分類碼（未標註時按 DRIVER_ERROR 處理）。 */
function errorCodeOf(err: any): StoreConfigErrorCode {
  return (err?.storeCode as StoreConfigErrorCode) || "DRIVER_ERROR"
}

/** 儲存配置文件（與 server 層的 DOC_DRIVER 指向同一頁） */
const STORAGE_DOC = "https://doc.oplist.org/ecosystem/official_worker/guide"

/**
 * 顯式指定驅動不可用時的針對性提示。
 *
 * 僅報「driver is not available」會讓用戶困惑於「我明明綁了」：每種驅動
 * 需要的前置條件差異很大（KV 還區分 CF 原生綁定與 EdgeOne 代理），因此
 * 逐驅動寫清「需要什麼」與替代方案。
 */
const DRIVER_UNAVAILABLE_HINTS: Record<string, string> = {
  kv:
    "The \"kv\" driver requires one of the following:\n" +
    "  - Cloudflare Workers: a KV namespace binding named exactly \"KV\" " +
    "(wrangler.jsonc: \"kv_namespaces\": [{ \"binding\": \"KV\" }]);\n" +
    "  - EdgeOne Node Functions: KV is NOT injected into Node functions, so the " +
    "Edge Function KV proxy must be reachable (known request origin / EO_KV_URLS) " +
    "and JWT_SECRET (identical on the Edge Function side) must be set.\n" +
    "If neither applies, use DB_DRIVER=auto, DB_DRIVER=blob (EdgeOne) or " +
    "DB_DRIVER=d1 (Cloudflare).\n",
  d1:
    "The \"d1\" driver requires a Cloudflare D1 binding named \"DB\" " +
    "(wrangler.jsonc: \"d1_databases\": [{ \"binding\": \"DB\", ... }]).\n" +
    "EdgeOne has no D1 — use DB_DRIVER=blob there instead.\n",
  cfkv:
    "The \"cfkv\" driver requires Cloudflare API credentials: CF_ACCOUNT " +
    "(or CLOUDFLARE_ACCOUNT_ID), CF_KV_UUID (or CLOUDFLARE_KV_NAMESPACE_ID) " +
    "and CF_API_KEY (or CLOUDFLARE_API_TOKEN) with KV read/write permission.\n",
  do:
    "The \"do\" driver requires a Durable Objects namespace binding named \"DO\" " +
    "(wrangler.jsonc: \"durable_objects\": { \"bindings\": [{ \"name\": \"DO\", " +
    "\"class_name\": \"...\" }] } plus a matching migration).\n",
  mysql:
    "The \"mysql\" driver requires a Node runtime plus connection info " +
    "(MYSQL_URLS, or MYSQL_HOST/MYSQL_PORT/MYSQL_USER/MYSQL_PASS/MYSQL_NAME). " +
    "Cloudflare Workers cannot open raw TCP connections to MySQL.\n",
  blob:
    "The \"blob\" driver requires either the EdgeOne Blob SDK (only present " +
    "inside the EdgeOne Makers runtime) or an ESA_BLOB binding on Alibaba ESA.\n",
}

/**
 * 診斷快取：顯式驅動不可用時，「auto 探測會選中哪個後端」。
 *
 * 為什麼要快取：得到這個答案要跑一次真實探測（KV 代理會發 HTTP 探測請求），
 * 而配置錯誤期間每個請求都會走到這裡。以 env 指紋做鍵，配置一變即失效；
 * 冷啟動後重新計算。
 */
let autoPickCache: { key: string; driver: Driver | null } | null = null

/**
 * 顯式驅動不可用時，auto 會選中哪個可用後端（沒有則 null）。
 *
 * **僅用於提示，絕不改變語義**：顯式配置了 DB_DRIVER 就絕不回退 —— 回退會把
 * 資料寫到用戶沒有指定的後端上，而且「暫時性不可用」（KV 代理 401、網路抖動）
 * 也會觸發切換，恢復後讀路徑又切回去，造成資料分裂。這裡僅是把「那你該改成
 * 什麼」算出來，直接寫進錯誤文案與診斷欄位，用戶抄一下即可。
 *
 * 記憶體兜底（本地開發）不算可用後端：避免把生產部署引導到易失儲存上。
 */
async function autoPickDriver(
  env: any,
  requested: string,
): Promise<Driver | null> {
  const key = `${requested}:${isServerlessRuntime(env) ? "sl" : "local"}:${envFingerprint(env)}`
  if (autoPickCache?.key === key) return autoPickCache.driver

  let driver: Driver | null = null
  try {
    const auto = await autoDetectDriver(env)
    if (auto && auto !== memoryDriver && auto.name !== requested) driver = auto
  } catch {
    // auto 也探測不到任何後端：保持原有提示（NO_STORAGE_MESSAGE 已在別處給出）
  }
  autoPickCache = { key, driver }
  return driver
}

/** 「auto 會選誰」的一行文案（沒有可用後端時為空串）。 */
function autoPickHint(driver: Driver | null): string {
  return driver
    ? `Auto-detection would pick: DB_DRIVER=${driver.name} ` +
        `(or simply set DB_DRIVER=auto).\n`
    : ""
}

/**
 * 驅動 × 格式組合校驗。
 *
 * 歷史上非法組合（如 DB_FORMAT=sql + DB_DRIVER=kv）要到真正讀寫時才在
 * sqlFormat 內拋 "Driver kv does not support SQL queries"：此時 env_check
 * 仍報 ready，用戶看到「環境一切正常」卻在初始化時 500。
 * 這裡在解析階段就拒絕，並列出該驅動支持的格式。
 *
 * ## 為什麼需要「顯式白名單」，而不僅是能力探測
 *
 * 能力探測（有沒有 get/put/delete/list）僅能區分「KV 語義 / 關係語義」，
 * 無法表達某個驅動**僅支持其中一種 KV 格式**。典型是 blob：
 *
 *   - blob 的 `get/put/delete/list` 齊備，因此按能力探測它能通過 map **和** key；
 *   - 但 blob 儲存的實質是「一整個 JSON 文件」，僅有 map 是自洽的：
 *     key 格式會把對象攤平成多條 `prefix:key` 記錄，而 blob 僅能整存整取，
 *     落到 blob 上既寫不出多個鍵、也 list 不出真實結構 —— 運行時才炸。
 *
 * 因此這裡疊加一層白名單：能表達「blob 僅 map」這種細粒度約束，
 * 且未來若某驅動支持 map/sql 但**不支持** key，也能直接聲明。
 */
const DRIVER_FORMAT_WHITELIST: Record<string, StorageFormat[]> = {
  // blob：單文件儲存，僅支持整存整取的 map
  blob: ["map"],
  // 顯式列出其餘驅動，避免新增驅動時「忘了加白名單 = 全放行」的靜默風險。
  kv: ["map", "key"],
  cfkv: ["map", "key"],
  d1: ["map", "key", "sql"],
  do: ["map", "key", "sql"],
  mysql: ["map", "key", "sql"],
  memory: ["map", "key"],
}

function validateDriverFormat(driver: Driver, format: FormatAdapter): void {
  // get/put/delete/list 在介面上是必選，但運行時仍可能缺失（第三方/降級實現），
  // 因此這裡按能力探測而非依賴類型聲明。
  const d = driver as any
  const supportsKv = Boolean(d.get && d.put && d.delete && d.list)
  const supportsSql = Boolean(driver.query && driver.execute && driver.batch)

  // ① 能力探測：先排除與驅動**語義**根本不符的格式（如給 kv 配 sql）。
  const capabilityOk = format.name === "sql" ? supportsSql : supportsKv

  // ② 白名單：再排除「語義上屬於該類、但該驅動並不支持」的格式（如 blob + key）。
  //    未登記的驅動按「不限制」處理（保留第三方驅動的可擴展性），
  //    但內置驅動全部顯式登記，見上表。
  const whitelist = DRIVER_FORMAT_WHITELIST[driver.name]
  const whitelistOk = !whitelist || whitelist.includes(format.name as StorageFormat)

  if (capabilityOk && whitelistOk) return

  const supported = (
    whitelist ??
    [supportsKv ? "map | key" : null, supportsSql ? "sql" : null].filter(Boolean)
  ).join(" | ")

  throw storeError(
    "INVALID_COMBINATION",
    `Invalid storage combination: DB_FORMAT="${format.name}" cannot be used with ` +
      `DB_DRIVER="${driver.name}".\n` +
      `Driver "${driver.name}" supports: ${supported || "no format"}.\n` +
      (format.name === "sql"
        ? "The \"sql\" format needs a relational driver (SQL query support): " +
          "d1 | do | mysql.\n"
        : `The "${format.name}" format needs a key-value driver ` +
          "(get/put/delete/list): kv | cfkv | d1 | do | mysql.\n") +
      `Fix DB_FORMAT or DB_DRIVER. See ${STORAGE_DOC}`,
    // 非法組合通常僅差一個變量，直接給出「改成什麼」。
    // 優先建議改 DB_FORMAT（保持用戶已選定的驅動），因為驅動往往是被平台
    // 唯一支持的（如 ESA 上僅有 blob），而格式才是用戶可自由選擇的維度。
    format.name === "sql"
      ? `Set DB_FORMAT=map (or key), or switch to a relational driver ` +
        `(DB_DRIVER=d1 | do | mysql).`
      : `Set DB_FORMAT=map for DB_DRIVER="${driver.name}"` +
        (supported.includes("|") ? `, or one of: ${supported}.` : `.`),
  )
}

/**
 * 解析驅動。
 *
 * 語義約定：
 *  - `auto`：按優先級探測，全部不可用時：worker 環境報錯，本地回退記憶體。
 *  - `memory`：合法驅動名，**僅本地 Node 有效**；serverless 下拋 NO_STORAGE
 *    （記憶體寫入會靜默丟失，且介面仍返回成功）。
 *  - 其它顯式指定（如 DB_DRIVER=kv）：**不回退**。若該驅動不可用則直接報錯，
 *    避免用戶以為在用 KV、實際卻落到別的後端或記憶體裡。
 */
async function resolveDriver(
  // 形參類型放寬為 string：`DB_DRIVER=memory` 是合法用戶輸入，但 `StorageDriver`
  // 聯合類型**故意不含 "memory"**（它不參與「驅動名 → 實現」查表，見下方註釋）。
  // 若在此收窄為 StorageDriver，下面的 `name === "memory"` 會被 TS 判為
  // 「永不成立的比較」，而這條分支恰恰是 `memory` 的唯一處理入口。
  name: StorageDriver | "memory",
  env?: any,
): Promise<Driver> {
  if (name === "auto") {
    return await autoDetectDriver(env)
  }

  // ── 顯式 DB_DRIVER=memory ──────────────────────────────────────────────
  //
  // memory 是**合法驅動名**（用戶意圖明確：不要持久化），但僅在本地 Node
  // 運行時有效。因此不能像以前那樣走到 DRIVER_MAP 查表、拿到 UNKNOWN_DRIVER
  // 「未知驅動」——那既否定了用戶的合法輸入，也給不出任何修復建議
  // （suggestion 為 null，安裝嚮導無從展示下一步動作）。
  //
  // 這裡在查表**之前**單獨處理：
  //   - 本地：直接返回 memoryDriver（行為與 auto 回退記憶體一致）；
  //   - serverless：拋 NO_STORAGE（語義是「本運行時沒有可用儲存」，而不是
  //     「你寫錯了一個變量」），並帶上「改成什麼」的一句話建議。
  if (name === "memory") {
    if (!isServerlessRuntime(env)) {
      console.log("[DB] Using explicitly configured driver: memory")
      return memoryDriver
    }
    throw storeError(
      "NO_STORAGE",
      MEMORY_SERVERLESS_MESSAGE,
      "Use DB_DRIVER=auto, or bind a persistent backend (D1 / KV / Blob).",
    )
  }

  const driver = DRIVER_MAP[name]
  if (!driver) {
    throw storeError(
      "UNKNOWN_DRIVER",
      `Unknown DB_DRIVER "${name}". Valid values: auto, memory, ${Object.keys(
        DRIVER_MAP,
      ).join(", ")}`,
    )
  }

  // 顯式指定時必須可用，否則報錯（不回退）
  let available = false
  try {
    available = await driver.isAvailable(env)
  } catch {
    available = false
  }

  if (!available) {
    // ── 顯式配置的驅動不可用：直接報錯，絕不回退 ──
    //
    // 回退（哪怕是回退到 auto 會選中的那個後端）都會把資料寫到用戶沒有指定的
    // 後端上，而且「暫時性不可用」（KV 代理 401、網路抖動）同樣會觸發切換，
    // 等它恢復後讀路徑又切回去，造成資料分裂。因此顯式配置一律硬失敗。
    //
    // 代價：校驗期間每個依賴儲存的 API 請求都會被 503 攔截（前端會停在初始化
    // 嚮導並展示下面的原因），所以文案必須自己說清怎麼辦 ——
    //   * 「auto 會選誰」排進前 3 行：診斷介面僅透傳前 3 行（見
    //     server/public.ts 的 reasonLines，那裡也寫了這條約束）；
    //   * 另外單獨給出結構化 suggestion，供前端顯眼展示。
    const auto = await autoPickDriver(env, name)
    throw storeError(
      "DRIVER_UNAVAILABLE",
      // 首行必須是完整的一句短原因：界面僅展示首行摘要（見 storage-error.ts
      // 的 storageErrorSummary），混入後續說明會變成被截斷的半句話。
      `DB_DRIVER is set to "${name}", but that driver is not available in this runtime.\n` +
        `No fallback is performed for an explicitly configured driver.\n` +
        autoPickHint(auto) +
        `Check the binding/credentials for "${name}", or set DB_DRIVER=auto ` +
        `to let the platform pick an available backend.\n` +
        (DRIVER_UNAVAILABLE_HINTS[name] || "") +
        `Environment: ${isServerlessRuntime(env) ? "serverless/worker" : "local/container"}`,
      auto
        ? `Set DB_DRIVER=${auto.name} (or DB_DRIVER=auto) in your deployment variables.`
        : `Set DB_DRIVER=auto in your deployment variables, or provide the ` +
          `binding/credentials required by "${name}".`,
    )
  }

  console.log(`[DB] Using explicitly configured driver: ${driver.name}`)
  return driver
}

/**
 * 解析格式。
 */
function resolveFormat(name: StorageFormat): FormatAdapter {
  switch (name) {
    case "map":
      return mapFormat
    case "key":
      return keyFormat
    case "sql":
      return sqlFormat
    default:
      throw new Error(`Unknown format: ${name}`)
  }
}

/**
 * 全局快取。
 */
let cachedDriver: Driver | null = null
let cachedFormat: FormatAdapter | null = null
let cachedConfig: string | null = null

/**
 * env 對象的穩定身份編號。
 *
 * 為什麼需要：auto 模式下驅動探測結果取決於「該 env 裡有哪些綁定」。
 * 若僅以 driverName:formatName 做快取鍵，同一個進程內先後出現兩個不同
 * env（一個有 Blob、一個僅有 KV）時會串味。這裡給每個 env 對象分配一個
 * 穩定的自增 ID（WeakMap，不阻止 GC），把「是否同一個 env」納入快取鍵。
 *
 * 代價極低：同一 env 對象多次調用恆得同一 ID；不同對象則重探測一次。
 */
const envIds = new WeakMap<object, number>()
let envIdSeq = 0
function envFingerprint(env?: any): string {
  if (env && (typeof env === "object" || typeof env === "function")) {
    let id = envIds.get(env as object)
    if (id === undefined) {
      id = ++envIdSeq
      envIds.set(env as object, id)
    }
    return String(id)
  }
  return "none"
}

/**
 * 獲取儲存後端（驅動 + 格式）。
 */
export async function getStorageBackend(
  env?: any,
): Promise<{ driver: Driver; format: FormatAdapter }> {
  const driverName = readDriver(env)
  const formatName = readFormat(env)
  // 快取鍵必須包含「影響探測結果的環境特徵」。
  // 僅用 driverName:formatName 是不夠的：當 DB_DRIVER=auto 時，不同 env
  // 可能探測出不同驅動（如本地 env 回退 memory、serverless env 報錯，
  // 或一個 env 有 Blob 綁定、另一個僅有 KV），共用快取會返回錯誤結果。
  // 因此額外納入「運行時類型 + env 身份」。
  const runtimeTag = isServerlessRuntime(env) ? "sl" : "local"
  const config = `${driverName}:${formatName}:${runtimeTag}:${envFingerprint(env)}`

  if (cachedDriver && cachedFormat && cachedConfig === config) {
    return { driver: cachedDriver, format: cachedFormat }
  }

  const driver = await resolveDriver(driverName, env)
  const format = resolveFormat(formatName)

  // 非法「驅動 × 格式」組合立即拒絕：否則要到真正讀寫時才報錯，
  // 而 env_check 會顯示 ready，用戶看到「環境正常」卻在初始化時 500。
  validateDriverFormat(driver, format)

  // 初始化驅動（建表等，冪等）
  if (driver.init) {
    try {
      await driver.init(env)
    } catch (err) {
      console.warn(`[DB] Driver init failed (${driver.name}):`, err)
    }
  }

  cachedDriver = driver
  cachedFormat = format
  cachedConfig = config

  console.log(`[DB] Using driver=${driver.name}, format=${format.name}`)
  return { driver, format }
}

/**
 * 獲取儲存後端（StoreBackend 舊介面，供 db.ts 使用）。
 */
export async function getStoreBackend(env?: any): Promise<StoreBackend> {
  const { driver, format } = await getStorageBackend(env)
  return {
    name: driver.name,
    load: (e?: any) => format.load(driver, e),
    save: (data: any, e?: any) => format.save(data, driver, e),
    isConfigured: (e?: any) => driver.isAvailable(e),
    init: (e?: any) => driver.init(e),
    health: (e?: any) => driver.health(e),
  }
}

/**
 * 當前後端的健康/連接狀態，用於 /debug/info 與 /admin/kv/status。
 *
 * 若為 EdgeOne KV 代理模式且缺少必需的密鑰，會返回 configError，
 * 由上層介面透傳給前端，避免用戶僅看到莫名的 401。
 */
export async function getStoreStatus(env?: any): Promise<any> {
  let driver: any = null
  let format: any = null
  let configError: string | null = null
  let configErrorCode: StoreConfigErrorCode | null = null

  try {
    const resolved = await getStorageBackend(env)
    driver = resolved.driver
    format = resolved.format
  } catch (err: any) {
    // 無可用儲存（如 serverless 環境未配置）時不應讓狀態介面崩潰，
    // 而是返回可讀的配置錯誤（含機器可讀的分類碼，供前端展示具體原因）。
    const msg = String(err?.message || err)
    const isNoStorage = msg.includes("No storage backend is available")
    return {
      driver: "none",
      format: "none",
      available: false,
      configError: isNoStorage ? NO_STORAGE_MESSAGE : msg,
      configErrorCode: errorCodeOf(err),
      /** 一句話修復建議（前端在顯眼位置單獨展示，不依賴解析 message） */
      // NO_STORAGE 現在自帶平台感知的 hint（見 noStorageHint），
      // 因此這裡不再需要「or set DB_DRIVER=auto」那句循環話術兜底。
      // 保留兜底僅用於「老代碼/異常路徑沒有帶 hint」的情形，且文案不再提 auto。
      configSuggestion:
        hintOf(err) ||
        (isNoStorage ? "Bind a persistent storage backend, then redeploy." : null),
    }
  }

  let health: any = null
  try {
    health = await driver.health(env)
  } catch (err: any) {
    health = { connected: false, error: err?.message || String(err) }
  }

  // 注意：這裡**刻意不**再做一次 checkProxyConfig 探測。
  //
  // 能走到這裡說明 resolveDriver 已成功返回 kv 實例，而 kv 能成功僅有兩條路：
  //   1. 有原生 KV binding        → checkProxyConfig 首行即 return null
  //   2. 無 binding 但代理可用
  //        （probeProxy 返回 ok 或 401，表示 secret + origin 至少齊全）
  //                                → checkProxyConfig 同樣為 null
  //   3. 無 binding 且缺 secret   → 已在 resolveDriver 拋 DRIVER_UNAVAILABLE，
  //                                  根本到不了這裡
  // 即：能到這裡 ⇒ checkProxyConfig 必為 null，這個分支永遠不會命中。
  // KV 代理的真實問題（缺密鑰 / 401）由 getStoreConfigErrorDetail 統一負責，
  // 那裡才有完整的「原因 + 一句話建議」。
  //
  // 這裡僅保留 health() 的結論：401 在 health 中視為不健康，
  // 因此下面 `...health` 會把 connected=false + error 透出去。
  return {
    driver: driver.name,
    format: format.name,
    ...(health || {}),
  }
}

/**
 * 判斷當前環境是否擁有「可持久化」的儲存。
 *
 * 判定為不可用的情況：
 *   - 沒有任何驅動（driver 為 none / 空）
 *   - 退化為記憶體驅動（重啟即丟，serverless 下不可接受）
 *   - 驅動配置存在錯誤
 *   - 驅動自報不健康（連接失敗、鑑權失敗等）
 */
export async function isPersistentStorageAvailable(env?: any): Promise<boolean> {
  const status = await getStorageStatusSafe(env)
  return isPersistentStatus(status)
}

/** 儲存狀態查詢，任何異常都摺疊成「不可用」狀態而非拋出。 */
async function getStorageStatusSafe(env?: any): Promise<any> {
  try {
    return await getStoreStatus(env)
  } catch (err: any) {
    return {
      driver: "none",
      format: "none",
      available: false,
      configError: String(err?.message || err),
      configErrorCode: errorCodeOf(err),
    }
  }
}

/**
 * 持久化可用性的統一判定（單一來源）。
 *
 * 供 isPersistentStorageAvailable() 與 getStoreConfigErrorDetail() 共用，
 * 避免兩處規則漂移導致「自檢說不可用、實際請求卻放行」。
 */
function isPersistentStatus(status: any): boolean {
  const driver = String(status?.driver ?? "none")
  const hasDriver = driver !== "none" && driver !== ""
  const isMemory = driver === "memory"
  const hasConfigError = Boolean(status?.configError)
  // health 失敗時 getStoreStatus 會帶 available:false
  const driverHealthy = status?.available !== false
  return hasDriver && !isMemory && !hasConfigError && driverHealthy
}

/**
 * 同一份配置錯誤僅打印一次（按實例）。
 *
 * 配置錯誤期間**每個** API 請求都會走到這裡（全局 503 攔截），逐請求打印會把
 * 日誌刷滿、淹沒其它信息（用戶看到的「反覆報錯」多半就是它）。文案變化時
 * （配置改動或換了一種錯）會重新打印；錯誤消失後重置，便於下次復現。
 * 需要實時狀態時用 /api/public/env_check（它豁免攔截且始終返回最新結論）。
 */
let lastConfigErrorLog: string | null = null

/**
 * 儲存配置錯誤的「原因 + 分類碼 + 一句話修復建議」。
 *
 * 供全局中間件（503 攔截）與診斷介面（/public/env_check、/public/init_status）
 * 共用同一判定，避免兩處規則漂移。
 *
 * @param opts.silent 不打印日誌。診斷介面會被前端輪詢（安裝嚮導每秒一次），
 *        由調用方決定是否需要日誌，避免刷屏。
 *
 * 不額外做快取：getStorageBackend 內部已按 env 指紋快取驅動解析，
 * 而 checkProxyConfig 是純同步讀取 env，開銷可忽略。
 */
export async function getStoreConfigErrorDetail(
  env?: any,
  opts: { silent?: boolean } = {},
): Promise<{
  code: StoreConfigErrorCode | null
  message: string | null
  /** 一句話修復建議（「改什麼」）；無建議時為 null */
  suggestion: string | null
}> {
  const log = (label: string, msg: string) => {
    if (opts.silent) return
    const key = label + msg
    if (lastConfigErrorLog === key) return
    lastConfigErrorLog = key
    console.error(label + msg)
  }
  if (!env || typeof env !== "object")
    return { code: null, message: null, suggestion: null }

  // 缺代理密鑰時優先給出「補密鑰」這種可操作提示，而不是籠統的驅動錯誤。
  // checkProxyConfig 是純同步讀取，開銷可忽略。
  //
  // 兩種入口都要覆蓋：
  //   1. 顯式 DB_DRIVER=kv
  //   2. auto 模式最終選中 kv 驅動（否則用戶僅會看到不可讀的 "HTTP 401"，
  //      而真正原因是 X-Internal-Call 的密鑰與 Edge Function 不一致）
  //
  // 兩處返回的 code / suggestion 完全相同，故抽成局部函數，避免文案漂移。
  const proxyConfigError = (kvIssue: string) => {
    log("[DB] KV proxy configuration error:\n", kvIssue)
    return {
      code: "PROXY_CONFIG" as StoreConfigErrorCode,
      message: kvIssue,
      suggestion:
        "Set EO_KV_URLS to the correct deployment origin, or use DB_DRIVER=auto.",
    }
  }

  const isKvRequested =
    String(env?.DB_DRIVER || "").trim().toLowerCase() === "kv"
  if (isKvRequested) {
    const kvIssue = checkProxyConfig(env)
    if (kvIssue) return proxyConfigError(kvIssue)
  }

  const status = await getStorageStatusSafe(env)

  // 配置齊全且健康：無錯誤（重置去重狀態，便於下次復現時仍能看到日誌）
  if (isPersistentStatus(status)) {
    lastConfigErrorLog = null
    return { code: null, message: null, suggestion: null }
  }

  // 選中了 kv 但代理不可用：區分「缺密鑰」與「密鑰不匹配」。
  // 後者表現為 HTTP 401 —— 代理已部署，僅是 JWT_SECRET 與 Edge Function
  // 不一致或被輪換過，需要明確指出來才能排查。
  if (!isKvRequested && String(status?.driver ?? "") === "kv") {
    const kvIssue = checkProxyConfig(env)
    if (kvIssue) return proxyConfigError(kvIssue)
    if (status?.mode === "proxy" && status?.error?.includes("401")) {
      const hint =
        "KV proxy rejected the internal call (HTTP 401). The JWT_SECRET used " +
        "by this deployment does not match the one configured on the Edge " +
        "Functions serving the proxy. Make sure both use the same JWT_SECRET.\n" +
        "Alternatively set EO_KV_URLS to the correct deployment origin."
      log("[DB] KV proxy authentication failed:\n", hint)
      return {
        code: "PROXY_CONFIG",
        message: hint,
        suggestion:
          "Use the same JWT_SECRET on the Edge Function and this deployment.",
      }
    }
  }

  // 已有明確原因（缺密鑰 / 驅動解析失敗 / 組合非法 / 健康檢查失敗）
  const reason: string | null = status?.configError
    ? String(status.configError)
    : null
  if (reason) {
    log("[DB] Storage configuration error:\n", reason)
    return {
      code: (status?.configErrorCode as StoreConfigErrorCode) || "DRIVER_ERROR",
      message: reason,
      // 「改什麼」由驅動解析層給出（如 DRIVER_UNAVAILABLE 會帶上 auto 的探測結論）
      suggestion: (status?.configSuggestion as string) || null,
    }
  }

  // 記憶體兜底：serverless 下寫入會靜默丟失，需要可操作提示
  if (String(status?.driver ?? "none") === "memory") {
    log("[DB] Storage configuration error:\n", NO_STORAGE_MESSAGE)
    return {
      code: "NO_STORAGE",
      message: NO_STORAGE_MESSAGE,
      suggestion:
        "Bind a storage backend (D1 / KV / Blob) or set DB_DRIVER=auto.",
    }
  }

  const healthError = status?.error ? String(status.error) : null
  if (healthError) {
    log("[DB] Storage unhealthy:\n", healthError)
    return {
      code: "HEALTH_ERROR",
      message: healthError,
      suggestion:
        "Check the credentials/bindings of the configured driver, or set DB_DRIVER=auto.",
    }
  }

  // 走到這裡說明 isPersistentStatus 判為「不可用」但沒有任何具體原因欄位
  // （例如驅動自報 available:false 卻未提供 error 文本）。此時**不能返回 null**，
  // 否則 503 攔截會靜默失效，請求繼續以「看似成功」的方式寫進不可用後端。
  // 給出一條基於驅動名的兜底錯誤，保證判定與攔截始終一致。
  const driverName = String(status?.driver ?? "none")
  const fallback =
    driverName === "none" || driverName === ""
      ? NO_STORAGE_MESSAGE
      : `Storage driver "${driverName}" is not available in this runtime. ` +
        `Check its configuration and bindings, or set DB_DRIVER=auto.`
  log("[DB] Storage unavailable:\n", fallback)
  return {
    code: driverName === "none" || driverName === "" ? "NO_STORAGE" : "DRIVER_ERROR",
    message: fallback,
    suggestion:
      driverName === "none" || driverName === ""
        ? "Bind a storage backend (D1 / KV / Blob) or set DB_DRIVER=auto."
        : `Set DB_DRIVER=auto, or provide the binding/credentials required by "${driverName}".`,
  }
}

// 說明：曾有一個僅返回 message 的 getStoreConfigError()，在全局 503 攔截改用
// getStoreConfigErrorDetail()（需要 code/reason/suggestion）後已無調用者，故刪除。
// 若將來確需「僅要原因」的場景，用 getStoreConfigErrorDetail().message 即可，
// 不要重新引入並行實現 —— 兩條規則容易漂移。
