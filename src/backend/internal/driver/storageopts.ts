/**
 * 儲存級行為選項：proxy_range / enable_sign / disable_index / cache_expiration
 * / custom_cache_policies。
 *
 * 這些欄位在 Go 版由 internal/model/storage.go 與 internal/op/driver.go 定義並
 * 在下載鏈路中實際生效；在 TSWorker 中此前只有資料庫列與表單項、沒有讀取方，
 * 本模塊把它們統一解析出來，供下載/列表鏈路使用。
 *
 * Go 對應位置：
 *   - model.Storage.ProxyRange            → proxy_range（driver.Config.ProxyRangeOption）
 *   - model.Storage.EnableSign            → common.IsStorageSignEnabled
 *   - model.Storage.DisableIndex          → handles.FsList
 *   - model.Storage.CacheExpiration       → 對象快取時長
 *   - model.Storage.CustomCachePolicies   → 路徑級快取覆蓋
 */

/** 單條自定義快取策略（對齊 Go model.CustomCachePolicy） */
export interface CustomCachePolicy {
  /** 路徑通配符，如 "/photos/*"、"*.log"、"/cache/**" */
  path: string
  /** 命中後的快取時長（分鐘），0 表示不快取 */
  cacheExpiration: number
  /** 可選的 max_age（秒）；缺省時由 cacheExpiration 推導 */
  maxAge?: number
}

const DEFAULT_CACHE_EXPIRATION_MINUTES = 30

/** storage.addition 可能是 JSON 字符串或已解析對象，統一解析 */
export function parseAdditionLoose(addition: any): Record<string, any> {
  if (!addition) return {}
  if (typeof addition === "object") return addition
  if (typeof addition === "string") {
    try {
      const parsed = JSON.parse(addition || "{}")
      return parsed && typeof parsed === "object" ? parsed : {}
    } catch {
      return {}
    }
  }
  return {}
}

function asBool(value: any): boolean {
  if (typeof value === "string") return value.toLowerCase() === "true"
  return value === true
}

function asInt(value: any): number | null {
  if (typeof value === "number" && Number.isFinite(value))
    return Math.trunc(value)
  if (typeof value === "string" && value.trim() !== "") {
    const n = parseInt(value, 10)
    if (Number.isFinite(n)) return n
  }
  return null
}

/**
 * proxy_range（對齊 Go 的 Range 處理）。
 *
 * 語義：下載走服務端代理時，是否把客戶端的 Range 頭透傳給上游。
 *   - true ：透傳 Range（**默認**），上游回 206 時原樣回傳，支持拖進度條/斷點續傳
 *   - false：丟棄 Range，由本服務返回完整文件（用於明確拒絕 Range 的上游）
 *
 * 為什麼默認 true：Go 的透明代理會把客戶端請求頭原樣轉發給上游
 * （internal/net/serve.go 的 ProcessHeader 只按 proxy_ignore_headers 過濾），
 * 也就是說 **Go 默認就透傳 Range**，`proxy_range` 在 Go 裡只是額外啟用驅動的
 * RangeReader/多執行緒路徑。TS 若默認 false，會讓代理模式下的 seek / 斷點續傳
 * 靜默退化。上游拒絕或靜默忽略 Range 時，由 server/proxy_request.ts 的
 * shouldRetryWithoutRange() 去掉 Range 重試兜底。
 */
export function getProxyRange(storage: any): boolean {
  const raw = storage?.proxy_range ?? storage?.proxyRange
  if (raw === undefined || raw === null || raw === "") return true
  return asBool(raw)
}

/** enable_sign（對齊 Go common.IsStorageSignEnabled） */
export function getEnableSign(storage: any): boolean {
  if (!storage) return false
  return asBool(storage.enable_sign ?? storage.enableSign)
}

/** disable_index（對齊 Go model.Storage.DisableIndex） */
export function getDisableIndex(storage: any): boolean {
  if (!storage) return false
  return asBool(storage.disable_index ?? storage.disableIndex)
}

/**
 * 儲存的基礎快取時長（分鐘）。等價於 Go model.Storage.CacheExpiration。
 * 未配置時回退 30 分鐘。
 */
export function getCacheExpiration(storage: any): number {
  const raw = asInt(storage?.cache_expiration ?? storage?.cacheExpiration)
  if (raw === null || raw < 0) return DEFAULT_CACHE_EXPIRATION_MINUTES
  return raw
}

/**
 * 解析 custom_cache_policies（對齊 Go 的路徑級快取覆蓋）。
 *
 * 相容多種書寫形式：
 *   - JSON 字符串：'[{"path":"/a/*","cache_expiration":10}]'
 *   - 對象數組
 *   - key-value 映射：{"/a/*": 10}
 * 逗號分隔的字符串形式也做了容錯。
 */
export function parseCustomCachePolicies(storage: any): CustomCachePolicy[] {
  let raw = storage?.custom_cache_policies ?? storage?.customCachePolicies
  if (!raw) return []

  if (typeof raw === "string") {
    const trimmed = raw.trim()
    if (!trimmed) return []
    try {
      raw = JSON.parse(trimmed)
    } catch {
      // 容錯：退化為 "路徑:分鐘,路徑:分鐘" 形式
      const policies: CustomCachePolicy[] = []
      for (const chunk of trimmed.split(",")) {
        const idx = chunk.lastIndexOf(":")
        if (idx <= 0) continue
        const p = chunk.slice(0, idx).trim()
        const v = asInt(chunk.slice(idx + 1).trim())
        if (p && v !== null) policies.push({ path: p, cacheExpiration: v })
      }
      return policies
    }
  }

  const policies: CustomCachePolicy[] = []

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry) continue
      if (typeof entry === "string") {
        const idx = entry.lastIndexOf(":")
        if (idx <= 0) continue
        const p = entry.slice(0, idx).trim()
        const v = asInt(entry.slice(idx + 1).trim())
        if (p && v !== null) policies.push({ path: p, cacheExpiration: v })
        continue
      }
      if (typeof entry === "object") {
        const p = entry.path ?? entry.Path
        const v =
          asInt(entry.cache_expiration ?? entry.cacheExpiration) ??
          asInt(entry.max_age ?? entry.maxAge)
        if (typeof p === "string" && p && v !== null) {
          const maxAge = asInt(entry.max_age ?? entry.maxAge)
          policies.push({
            path: p,
            cacheExpiration: v,
            ...(maxAge !== null ? { maxAge } : {}),
          })
        }
      }
    }
    return policies
  }

  if (typeof raw === "object") {
    for (const [key, value] of Object.entries(raw)) {
      const v = asInt(value)
      if (key && v !== null) policies.push({ path: key, cacheExpiration: v })
    }
  }

  return policies
}

/** 模式與目標路徑的最大長度，超出直接判為不匹配，避免超長輸入放大開銷 */
const MAX_GLOB_PATTERN_LENGTH = 1024
const MAX_GLOB_TARGET_LENGTH = 4096

/**
 * glob 匹配（對齊 Go 裡 doublestar.Match 的按段語義）。
 * 輸入路徑與模式均已規範化（以 / 開頭）。
 *
 * 實現說明（重要）：本函數**不使用正則**。早期版本把 glob 翻譯成正則，
 * 多個通配符會變成相鄰的貪婪通配，匹配失敗時觸發災難性回溯
 * （catastrophic backtracking）——實測單次匹配耗時 508 秒，
 * 構成一個可由儲存配置規則直接觸發的 DoS 面。
 *
 * 現改為「按 / 切段 + 逐段動態規劃」：
 *   - 完全由 2 個及以上星號構成的段（`**`、`***`）：可跨段，匹配 0..n 段
 *   - 其餘段：在本段內用迭代式雙指針匹配，不跨 `/`
 *   複雜度 O(段數 × 目標段數)，無遞歸、無指數回溯。
 *
 * 通配符語義：
 *   - 雙星段：匹配零個或多個路徑段（可跨 `/`）
 *   - 單星：在段內匹配任意字符（含空），**不跨** `/`
 *   - 問號：在段內匹配任意單個字符，**不跨** `/`
 *
 * 長度上限作為額外兜底，防止超長規則/路徑放大計算量。
 */
export function matchGlob(pattern: string, target: string): boolean {
  if (!pattern) return false
  if (pattern === target) return true
  if (pattern.length > MAX_GLOB_PATTERN_LENGTH) return false
  if (target.length > MAX_GLOB_TARGET_LENGTH) return false

  // 按 / 切分為路徑段後逐段匹配。
  // 這樣處理能自然區分「單星只在本段內通配」與「雙星可跨任意多段」，
  // 避免在字符級實現裡糾纏回溯點的組合問題。
  const pSegs = pattern.split("/")
  const tSegs = target.split("/")

  const pLen = pSegs.length
  const tLen = tSegs.length

  // dp[i][j] 表示 pSegs[i:] 能否匹配 tSegs[j:]
  // 採用一維滾動數組，自後向前填表，複雜度 O(n·m)、無遞歸。
  let next = new Array<boolean>(tLen + 1).fill(false)
  // 空模式只能匹配空目標
  next[tLen] = true

  for (let i = pLen - 1; i >= 0; i--) {
    const seg = pSegs[i]
    const cur = new Array<boolean>(tLen + 1).fill(false)
    // 完全由星號組成且數量 >= 2 的段視為跨段通配（`**`、`***` 等價）
    const isDoubleStar = /^\*{2,}$/.test(seg)

    if (isDoubleStar) {
      // 雙星可匹配 0 段或 1 段後繼續由自身匹配
      cur[tLen] = next[tLen]
      for (let j = tLen - 1; j >= 0; j--) {
        cur[j] = next[j] || cur[j + 1]
      }
    } else {
      // 普通段（可能含單星/問號）只匹配一段
      for (let j = tLen - 1; j >= 0; j--) {
        cur[j] = matchSegment(seg, tSegs[j]) && next[j + 1]
      }
    }
    next = cur
  }

  return next[0]
}

/**
 * 單段匹配：僅支持單星（不跨 /）與問號，不含雙星。
 * 用迭代式雙指針 + 單回溯點實現，為 O(n·m) 且無指數回溯。
 */
function matchSegment(pattern: string, target: string): boolean {
  let pi = 0
  let ti = 0
  let starPi = -1
  let starTi = -1

  const pLen = pattern.length
  const tLen = target.length

  while (ti < tLen) {
    const pc = pi < pLen ? pattern[pi] : undefined
    if (pc === "*") {
      starPi = pi
      starTi = ti
      pi++
      continue
    }
    if (pc === "?" || pc === target[ti]) {
      pi++
      ti++
      continue
    }
    if (starPi !== -1) {
      starTi++
      ti = starTi
      pi = starPi + 1
      continue
    }
    return false
  }

  while (pi < pLen && pattern[pi] === "*") pi++
  return pi === pLen
}

/**
 * 計算某個路徑在特定儲存下的快取時長（分鐘）。
 *
 * 匹配優先級（對齊 Go：自定義策略優先於儲存基礎值）：
 *   1. custom_cache_policies 中命中的規則——**最後一條命中的規則優先**，
 *      與 Go 的順序覆蓋語義一致
 *   2. 儲存級 cache_expiration
 *   3. 默認 30
 *   4. 命中規則時按規則值返回（minute=0 表示不快取）
 */
export function resolveCacheExpiration(storage: any, filePath: string): number {
  const normalized =
    "/" +
    String(filePath || "")
      .split("/")
      .filter(Boolean)
      .join("/")
  const base = getCacheExpiration(storage)

  const policies = parseCustomCachePolicies(storage)
  if (policies.length === 0) return base

  let matched: CustomCachePolicy | null = null
  for (const policy of policies) {
    let pattern = policy.path.trim()
    if (!pattern) continue
    if (!pattern.startsWith("/") && !pattern.startsWith("*"))
      pattern = "/" + pattern
    if (
      matchGlob(pattern, normalized) ||
      matchGlob(pattern, normalized.slice(1))
    ) {
      matched = policy
    }
  }

  return matched ? matched.cacheExpiration : base
}
