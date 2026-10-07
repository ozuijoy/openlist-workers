/**
 * JSON / KV / Blob 後端（默認後端）。
 *
 * 從原 db.ts 原樣遷移：EdgeOne Blob SDK、Cloudflare/EdgeOne KV binding、
 * Cloudflare KV REST API、記憶體回退。行為與原實現完全一致。
 */
import type { StoreBackend } from "./types"
import { sanitizeProxyOrigin } from "./proxy"

// 保持既有引用路徑不變（scripts/_regress.mjs 通過 jsonMod 訪問）
export { sanitizeProxyOrigin } from "./proxy"

// ---- EdgeOne Blob SDK (HTTP API, avoids Redis RESP protocol crashes) ----
let _blobStore: any = null

/**
 * 探測次數上限。
 *
 * 僅快取「成功」結果，失敗不快取：
 * 冷啟動早期 SDK 可能尚未就緒，若把失敗也永久快取，會導致整個實例
 * 生命週期內再也不會嘗試，表現為「明明能用卻一直報無持久化後端」。
 * 同時設上限避免每個請求都重複探測。
 */
let _blobProbeCount = 0

async function getBlobStore(): Promise<any | null> {
  if (_blobStore) return _blobStore // 成功過：直接複用
  if (_blobProbeCount >= 3) return null // 連續失敗：不再重試
  _blobProbeCount++
  try {
    // @ts-ignore
    const { getStore } = await import("@edgeone/pages-blob")
    // In Makers Functions, projectId/token are auto-injected by the runtime.
    // TypeScript types require them, but the SDK works without them inside Functions.
    _blobStore = getStore({
      name: "openlist_db",
      consistency: "strong",
    } as any)
  } catch {
    return null // 不快取失敗，允許後續請求重試
  }
  return _blobStore
}

// ---- Safety net: catch uncaught exceptions from KV binding RESP parser ----
// Only registered in EdgeOne environments (invoked by getKvBinding detection),
// so Cloudflare Workers / local Node.js keep their default global error behavior.
let _respSafetyNetInstalled = false
function installRespSafetyNet() {
  if (_respSafetyNetInstalled) return
  _respSafetyNetInstalled = true
  if (typeof process === "undefined" || typeof process.on !== "function") return
  process.on("uncaughtException", (err: any) => {
    if (
      err?.message?.includes("RESP") ||
      err?.message?.includes("Unknown type") ||
      err?.stack?.includes("processResponses")
    ) {
      console.error(
        "[KV/RESP] Caught uncaught exception from storage binding, continuing:",
        err.message,
      )
      // Do NOT re-throw — let the function instance survive.
      // Subsequent requests will fall back to memoryDb.
    }
    // All other errors: let Node.js default handler process them.
  })
}

// JSON 後端的模塊級環境上下文（與 db.ts 的 globalEnvCtx 並行維護，由
// db.ts 的 setEnvCtx 同步寫入）。
let jsonEnvCtx: any = null

/**
 * getKvBinding() 的結果快取。
 *
 * 為什麼需要它：
 *   - getKvBinding() 每次都會重新探測 env.KV / globalThis.KV、嘗試初始化
 *     Blob SDK，並打印 console.warn；
 *   - 登入失敗計數、註銷黑名單、審計日誌讀寫都會調用它，單次請求可能命中數次。
 * 綁定僅取決於 env 對象的身份（`1 env = 1 請求`），因此按 env 身份用 WeakMap
 * 記憶化既安全又足以消除重複探測與日誌噪聲。
 *
 * 快取語義（重要）：
 *   - 成功結果（binding / blob / api / proxy）永久快取：綁定在實例生命週期內
 *     不會變化；
 *   - `none`（探測不到任何 KV 風格綁定）僅做短 TTL 快取：既消除同一請求內的
 *     重複探測與重複告警，又保留「冷啟動早期 SDK 尚未就緒、稍後重試即可用」的
 *     既有語義（見 getBlobStore() 的探測次數上限）。
 * 鍵是 env 對象本身，條目隨 env 被 GC 回收，不會無限增長。
 */
const KV_BINDING_NONE_TTL_MS = 1000

type KvBindingInfo = {
  binding: any
  platform: string
  mode: "binding" | "blob" | "api" | "proxy" | "none"
}

const kvBindingCache = new WeakMap<object, KvBindingInfo & { ts: number }>()

/** 讀取快取：`none` 結果超過 TTL 視為未命中，允許重新探測。 */
function readKvBindingCache(env: any): KvBindingInfo | null {
  if (!env || typeof env !== "object") return null
  const entry = kvBindingCache.get(env)
  if (!entry) return null
  if (entry.mode === "none" && Date.now() - entry.ts >= KV_BINDING_NONE_TTL_MS) {
    return null
  }
  return entry
}

/**
 * 寫入快取並返回同一對象引用。
 *
 * 返回快取條目本身（而不是另建對象）是為了讓調用方在同一 TTL 窗口內拿到
 * **同一個引用**，行為可被測試直接斷言。
 */
function writeKvBindingCache(env: any, info: KvBindingInfo): KvBindingInfo {
  const entry: KvBindingInfo & { ts: number } = { ...info, ts: Date.now() }
  if (env && typeof env === "object") kvBindingCache.set(env, entry)
  return entry
}

export function setJsonEnvCtx(env: any) {
  if (env) jsonEnvCtx = env
}

/**
 * Universal KV / Blob Storage Adapter for EdgeOne Makers & Cloudflare Workers
 *
 * 默認（auto）按以下順序檢測：
 *   1. @edgeone/pages-blob SDK (EdgeOne — HTTP API, no RESP crashes)
 *   2. KV namespace binding (Cloudflare Workers native)
 *   3. CF REST API (env vars)
 *   4. None (memory fallback)
 */
/**
 * 判斷一個對象是否是「可用的 Web KV binding」。
 *
 * 這一校驗必不可少：EdgeOne Node 雲函數也會注入一個名為 `KV` 的綁定，
 * 但它走 RESP/Redis 協議（TCP socket），調用 get/put 會拋出
 * "cannot find the collection by name"，而不是提供 Web KV API。
 * 僅有具備 get() 且具備 put()/set() 的對象才算可用。
 *
 * 同時排除字符串等原始值 —— 環境變量 `KV` 可能是綁定名（字符串），
 * 直接當綁定使用會得到 "kv.get is not a function"。
 */
export function isWebKv(b: any): boolean {
  if (!b || typeof b !== "object") return false
  // 屬性訪問可能觸發異常 getter（代理對象、SDK 惰性初始化等），
  // 任何異常都視為「不是可用綁定」，避免讓探測本身崩潰。
  try {
    if (typeof b.get !== "function") return false
    return typeof b.put === "function" || typeof b.set === "function"
  } catch {
    return false
  }
}

/**
 * 創建基於 HTTP 代理的 KV 適配器。
 *
 * 用於 EdgeOne Node 雲函數：拿不到 KV binding，必須經 Edge Function
 * （functions/kv-*）代為訪問。對外暴露與原生 binding 相同的介面，
 * 使調用方（middlewares/auth/admin）無需感知差異。
 *
 * 實現**直接委託給 kvDriver**（該代理協議的唯一實現），避免同一協議
 * 在本文件中重複一份、與 driver/kv.ts 的行為產生漂移。
 * 這裡僅負責把 Driver 的 `string[]` 契約適配成 binding 的 `{name,key}[]`。
 *
 * kvDriver 用動態 import 引入：driver/kv.ts 需要本模塊的
 * sanitizeProxyOrigin，靜態互相導入會形成循環依賴。
 */
function createProxyBinding(_origin: string, env: any): any {
  const load = async () => (await import("./driver/kv")).kvDriver

  return {
    async get(key: string): Promise<string | null> {
      return (await load()).get(key, env)
    },

    async put(key: string, value: string): Promise<void> {
      return (await load()).put(key, value, env)
    },

    async delete(key: string): Promise<void> {
      return (await load()).delete(key, env)
    },

    async list(opts: { prefix?: string } = {}): Promise<{ keys: any[] }> {
      const keys = await (await load()).list(opts?.prefix || "", env)
      // 相容 binding 形態：調用方讀取 k.name / k.key 兩種寫法
      return { keys: keys.map((name) => ({ name, key: name })) }
    },
  }
}

/**
 * 「未探測到 KV 風格綁定」的告警是否已打印過。
 *
 * 該分支位於登入失敗計數 / 註銷黑名單 / 審計日誌等熱路徑上，且此前每次調用都會
 * 打印一次，導致 serverless 日誌被同一行刷屏（issue #51 的噪聲來源之一）。
 * 每個進程提示一次即可：這是環境配置結論，不是每請求事件。
 */
let kvNoneWarnedOnce = false

export async function getKvBinding(envCtx?: any): Promise<{
  binding: any
  platform: string
  mode: "binding" | "blob" | "api" | "proxy" | "none"
}> {
  if (envCtx) {
    jsonEnvCtx = envCtx
  }
  const env =
    envCtx || jsonEnvCtx || (typeof process !== "undefined" ? process.env : {})
  const g = typeof globalThis !== "undefined" ? (globalThis as any) : {}

  // 結果快取：同一 env 對象僅解析一次綁定（詳見 kvBindingCache 註釋）。
  const cached = readKvBindingCache(env)
  if (cached) return cached

  /**
   * 原生 KV binding 探測。
   *
   * 兩點必須注意：
   *  1. env 與 globalThis 需獨立檢查 —— env 為真值時不會回退到 globalThis，
   *     而 EdgeOne Edge Functions 把綁定名注入為全局標識符。
   *  2. 必須做介面形態校驗 —— EdgeOne Node 雲函數也會注入名為 `KV` 的綁定，
   *     但它走 RESP/Redis 協議（TCP socket），調用 put/get 會拋
   *     "cannot find the collection by name"，而非提供 Web KV API。
   *     僅有具備 get/put(或 set) 的對象才算可用的 KV binding。
   *
   * 綁定名統一為 `KV`（KV namespace binding 的通用約定名）。
   */
  const nativeKv = isWebKv(env?.KV)
    ? env.KV
    : isWebKv(g?.KV)
      ? g.KV
      : null

  // 0. EdgeOne Node 雲函數：顯式 DB_DRIVER=kv 且無原生 binding → 走 HTTP 代理。
  //    放在 Blob 之前，確保用戶顯式選擇的 KV 優先於自動探測出的 Blob。
  const kvPreferred =
    String(env?.DB_DRIVER || "").trim().toLowerCase() === "kv"
  if (kvPreferred && !nativeKv) {
    let origin: any
    try {
      origin = env?.EO_KV_URLS || env?.__requestOrigin
    } catch {
      origin = undefined
    }
    const safeOrigin = sanitizeProxyOrigin(origin, env)
    if (safeOrigin) {
      const proxyResult = {
        binding: createProxyBinding(safeOrigin, env),
        platform: "EdgeOne KV (via Edge Function proxy)",
        mode: "proxy" as const,
      }
      return writeKvBindingCache(env, proxyResult)
    }
    console.warn(
      "[DB] getKvBinding: KV proxy requested but no origin available " +
        "(set EO_KV_URLS or ensure request origin is injected)",
    )
  }

  // 1. EdgeOne Blob SDK (HTTP API — avoids RESP protocol crashes)
  try {
    const blobStore = await getBlobStore()
    if (blobStore) {
      // Blob SDK only initializes inside the EdgeOne Makers runtime
      installRespSafetyNet()
      const blobResult = {
        binding: blobStore,
        platform: "EdgeOne Blob (@edgeone/pages-blob, strong consistency)",
        mode: "blob" as const,
      }
      return writeKvBindingCache(env, blobResult)
    }
  } catch (err: any) {
    console.error(
      `[DB] getKvBinding: EdgeOne Blob init failed: ${err?.message || err}`,
      `stack=${err?.stack?.substring(0, 300) || ""}`,
    )
  }

  // 2. KV namespace binding（統一名為 KV）
  if (nativeKv) {
    const isEdgeOne =
      Boolean(env && (env.EDGEONE || env.EO_REGION)) ||
      Boolean(g.EDGEONE || typeof g.EdgeOne !== "undefined")
    if (isEdgeOne) installRespSafetyNet()
    const platformName = isEdgeOne
      ? "EdgeOne KV (KV)"
      : "Cloudflare / EdgeOne KV (KV)"
    const bindingResult = {
      binding: nativeKv,
      platform: platformName,
      mode: "binding" as const,
    }
    return writeKvBindingCache(env, bindingResult)
  }

  // 3. Cloudflare REST API 模式（顯式 DB_DRIVER=cfkv 或憑據齊全時自動啟用）
  {
    const cfAccountId =
      env.CF_ACCOUNT ||
      (typeof process !== "undefined" ? process.env.CF_ACCOUNT : "")
    const cfNamespaceId =
      env.CF_KV_UUID ||
      (typeof process !== "undefined" ? process.env.CF_KV_UUID : "")
    const cfApiToken =
      env.CF_API_KEY ||
      (typeof process !== "undefined" ? process.env.CF_API_KEY : "")

    if (cfAccountId && cfNamespaceId && cfApiToken) {
      const apiResult = {
        binding: {
          type: "cf_rest",
          accountId: cfAccountId,
          namespaceId: cfNamespaceId,
          token: cfApiToken,
        },
        platform: "Cloudflare KV (REST API)",
        mode: "api" as const,
      }
      return writeKvBindingCache(env, apiResult)
    }
  }

  // NOTE: this detector only probes KV-flavoured backends (native KV binding,
  // EdgeOne Blob, Cloudflare KV REST, EdgeOne KV proxy). It intentionally does
  // NOT cover D1 / MySQL / DO — but that does NOT mean data is lost: those
  // drivers are resolved by getStorageBackend() instead. The old wording
  // ("memory-only mode (data will not persist)") was therefore misleading, and
  // sent users with a working D1 backend chasing a non-existent problem.
  //
  // Only deployments that are *supposed* to use a KV/Blob backend get a message.
  // When DB_DRIVER names a non-KV driver (d1 / mysql / do), a KV miss is
  // irrelevant by construction — and this function is also reached by the audit
  // log / logout blacklist / login-failure counters, so warning on every such
  // write made "no KV binding" look like the cause of unrelated failures.
  const configuredDriver = String(env?.DB_DRIVER || "")
    .trim()
    .toLowerCase()
  // 兩重條件缺一不可：
  //   - expectsKvStyleBackend：僅有「本該用 KV/Blob」的部署，缺綁定才是異常；
  //     顯式配 d1/mysql/do 時 KV 缺失是設計使然，不該告警（否則誤導用戶）。
  //   - !kvNoneWarnedOnce：每個進程僅提示一次，避免日誌刷屏。
  const expectsKvStyleBackend =
    !configuredDriver ||
    configuredDriver === "auto" ||
    configuredDriver === "kv" ||
    configuredDriver === "cfkv" ||
    configuredDriver === "blob"
  if (expectsKvStyleBackend && !kvNoneWarnedOnce) {
    kvNoneWarnedOnce = true
    if (configuredDriver && configuredDriver !== "auto") {
      console.warn(
        `[DB] getKvBinding: no KV-style binding found; DB_DRIVER="${configuredDriver}" ` +
          `is served by getStorageBackend() instead. This is expected.`,
      )
    } else {
      console.warn(
        "[DB] getKvBinding: no KV/Blob binding found in auto detection.",
      )
    }
  }
  // `none` 同樣要寫快取：否則每次調用都會重新探測一遍並重新告警。
  return writeKvBindingCache(env, {
    binding: null,
    platform: "none",
    mode: "none",
  })
}

async function readFromKv(
  kvInfo: Awaited<ReturnType<typeof getKvBinding>>,
  key = "openlist_config",
): Promise<any | null> {
  const { binding, mode } = kvInfo
  if (mode === "none" || !binding) return null

  try {
    if (mode === "blob") {
      // @edgeone/pages-blob SDK: get(key, { type: "json" }) returns parsed object
      const val = await binding.get(key, { type: "json" })
      if (val) return val
      // Fallback: get as text and parse
      const text = await binding.get(key)
      if (text) {
        return typeof text === "string" ? JSON.parse(text) : text
      }
    } else if (mode === "binding" || mode === "proxy") {
      let val: any = null
      try {
        // Cloudflare KV 支持 (key, "text")，EdgeOne KV 支持 (key)
        val = await binding.get(key, "text")
      } catch {
        val = await binding.get(key)
      }
      if (val === undefined || val === null) {
        val = await binding.get(key)
      }
      if (val) {
        return typeof val === "string" ? JSON.parse(val) : val
      }
    } else if (binding.type === "cf_rest") {
      const url = `https://api.cloudflare.com/client/v4/accounts/${binding.accountId}/storage/kv/namespaces/${binding.namespaceId}/values/${key}`
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${binding.token}` },
      })
      if (res.ok) {
        const text = await res.text()
        return JSON.parse(text)
      }
    }
  } catch (err) {
    console.error("[KV/Blob Store] Error reading key:", key, err)
  }
  return null
}

async function saveToKv(
  kvInfo: Awaited<ReturnType<typeof getKvBinding>>,
  key: string,
  data: any,
): Promise<boolean> {
  const { binding, mode } = kvInfo
  if (mode === "none" || !binding) {
    console.warn(`[KV/Blob Store] saveToKv: mode="${mode}", binding=${!!binding}, skipping write`)
    return false
  }

  const valStr = JSON.stringify(data)
  console.log(`[KV/Blob Store] saveToKv: key="${key}", mode="${mode}", size=${valStr.length} bytes`)

  try {
    if (mode === "blob") {
      // @edgeone/pages-blob SDK: setJSON(key, value) for structured data
      if (typeof binding.setJSON === "function") {
        const result = (await binding.setJSON(key, data)) !== false
        console.log(`[KV/Blob Store] blob.setJSON result=${result}`)
        return result
      }
      // Fallback: set(key, stringified)
      if (typeof binding.set === "function") {
        const result = (await binding.set(key, valStr)) !== false
        console.log(`[KV/Blob Store] blob.set result=${result}`)
        return result
      }
    } else if (mode === "binding" || mode === "proxy") {
      // NOTE: only an explicit `false` counts as failure. Cloudflare KV's
      // put() resolves to void, so `undefined` must stay a success —
      // otherwise every normal write would be reported as failed.
      // proxy 模式複用同一分支：適配器已實現 put/get/delete/list。
      if (typeof binding.put === "function") {
        const putResult = await binding.put(key, valStr)
        const result = putResult !== false
        console.log(`[KV/Blob Store] binding.put result=${putResult}, success=${result}`)
        return result
      }
      if (typeof binding.set === "function") {
        const result = (await binding.set(key, valStr)) !== false
        console.log(`[KV/Blob Store] binding.set result=${result}`)
        return result
      }
    } else if (binding.type === "cf_rest") {
      const url = `https://api.cloudflare.com/client/v4/accounts/${binding.accountId}/storage/kv/namespaces/${binding.namespaceId}/values/${key}`
      const res = await fetch(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${binding.token}`,
          "Content-Type": "text/plain",
        },
        body: valStr,
      })
      console.log(`[KV/Blob Store] cf_rest PUT status=${res.status}`)
      return res.ok
    }
  } catch (err: any) {
    console.error(
      `[KV/Blob Store] Error writing key="${key}", mode="${mode}", dataSize=${valStr.length}:`,
      err?.message || err,
      `stack=${err?.stack?.substring(0, 300) || ""}`,
    )
  }
  console.warn(`[KV/Blob Store] saveToKv: no valid method found for mode="${mode}"`)
  return false
}

export async function getKvStatus(envCtx?: any) {
  const kvInfo = await getKvBinding(envCtx)
  const isConfigured = kvInfo.mode !== "none"
  let connected = false
  let error: string | null = null

  if (isConfigured) {
    try {
      const testVal = await readFromKv(kvInfo, "openlist_config")
      connected = true
      return {
        configured: true,
        connected: true,
        platform: kvInfo.platform,
        mode: kvInfo.mode,
        hasData: !!testVal,
        error: null,
      }
    } catch (err: any) {
      error = err.message || String(err)
    }
  }

  return {
    configured: isConfigured,
    connected,
    platform: kvInfo.platform,
    mode: kvInfo.mode,
    hasData: false,
    error,
  }
}

// ───────────────────────── 持久化密鑰管理 ─────────────────────────
//
// 密鑰（JWT 簽名密鑰、欄位加密密鑰）需要跨實例、跨冷啟動保持一致，
// 因此必須持久化。設計原則：
//
//   1. 生成僅發生在初始化（setup）階段，且僅當鍵不存在時。
//   2. 一旦寫入，永不覆蓋 —— 覆蓋會導致已加密資料無法解密。
//   3. 非初始化階段僅讀；讀不到就是故障，絕不重新生成。
//   4. 判定依據是「鍵是否存在」，而不是「讀取是否成功」。
//
// 鍵名與資料庫中的實體隔離，避免被通用 list(prefix) 誤掃。
//
// 歷史實現僅走 getKvBinding（僅探測 原生 KV / EdgeOne Blob / CF KV REST /
// proxy），**沒有 D1/MySQL 分支**。於是當用戶按推薦配置 DB_DRIVER=d1 時，
// 業務資料能正常落到 D1，密鑰卻讀不到也寫不進去（並打印誤導性的
// "memory-only mode" 日誌），最終每次冷啟動都生成新的隨機 JWT_SECRET，
// 導致多實例間簽發/驗籤密鑰不一致 —— 表現為下載、播放報
// "sign verify failed"（401）。
//
// 現在統一走 getStorageBackend()（與業務資料同一條驅動解析路徑），
// 因此 D1/MySQL/DO/KV/Blob 等所有驅動都能持久化密鑰。

/**
 * 解析用於密鑰讀寫的驅動。
 *
 * 複用業務資料的驅動解析（getStorageBackend），保證「業務資料存哪、
 * 密鑰就存哪」，不會出現兩者不一致。
 *
 * 無可用驅動（如 serverless 環境未配置任何儲存）時 getStorageBackend
 * 會拋出可讀錯誤，由調用方捕獲並按「無持久化」處理。
 */
async function resolveSecretDriver(env: any) {
  const { getStorageBackend } = await import("./backend")
  const { driver } = await getStorageBackend(env)
  return driver
}

/** 從持久化後端讀取密鑰，不存在或失敗返回 null */
export async function readPersistedSecret(
  env: any,
  key: string,
): Promise<string | null> {
  try {
    const driver = await resolveSecretDriver(env)
    const val = await driver.get(key, env)
    if (val === null || val === undefined) return null
    // 部分綁定的 get() 可能返回 Response 形態，相容 text() 取值。
    const resolved: any =
      typeof (val as any)?.text === "function" ? await (val as any).text() : val
    const str = String(resolved).trim()
    return str || null
  } catch (e) {
    console.warn(`[Secret] read "${key}" failed:`, e)
    return null
  }
}

/**
 * 寫入密鑰。
 *
 * 調用方需自行保證「僅在不存在時調用」，本函數不檢查現有值
 * （見上方設計原則第 2 條）。
 */
export async function writePersistedSecret(
  env: any,
  key: string,
  secret: string,
): Promise<boolean> {
  try {
    const driver = await resolveSecretDriver(env)
    await driver.put(key, secret, env)
    return true
  } catch (e) {
    console.warn(
      `[Secret] cannot persist "${key}": ${(e as any)?.message || e}`,
    )
    return false
  }
}

/**
 * 生成一個 64 位十六進制隨機密鑰，與 middlewares.ts 中的生成方式一致。
 */
export function generateSecret(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}
