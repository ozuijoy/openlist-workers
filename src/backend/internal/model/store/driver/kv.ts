/**
 * KV 驅動（自動適配 Cloudflare / EdgeOne）
 *
 * 支持兩種模式：
 * 1. Binding 模式：直接訪問 KV binding（Cloudflare Workers / EdgeOne Edge Functions）
 * 2. HTTP 代理模式：通過 Edge Function 代理訪問（EdgeOne Node Functions）
 *
 * 自動檢測環境並選擇合適的模式。
 */
import { sanitizeProxyOrigin } from "../proxy"
import type { Driver, EnvContext } from "../types"

/**
 * 判斷某個值是否具備 KV Web API 的介面形態。
 *
 * 這一步是必需的：EdgeOne Node 雲函數也會注入一個名為 `KV` 的綁定，
 * 但它走的是 RESP/Redis 協議（TCP socket），調用 put/get 會拋出
 * "cannot find the collection by name"，而不是提供 Web KV API。
 * 必須靠介面形狀區分，否則會把 RESP 客戶端誤當作 KV 使用。
 */
function isWebKvLike(b: any): boolean {
  if (!b || typeof b !== "object") return false
  // 屬性訪問可能觸發異常 getter，任何異常都視為「不是可用綁定」。
  try {
    if (typeof b.get !== "function") return false
    return typeof b.put === "function" || typeof b.set === "function"
  } catch {
    return false
  }
}

/**
 * 獲取 KV binding（僅返回符合 Web KV API 的綁定）。
 *
 * 注意：不能寫成 `env || globalThis` —— 只要 env 是真值就不會回退到
 * globalThis，而 EdgeOne Edge Functions 會把綁定名注入為全局標識符。
 * 因此這裡兩處都要檢查，且都要通過介面形態校驗。
 */
function getKvBinding(env?: any): any | null {
  const g = globalThis as any
  // 綁定名統一為 KV（KV namespace binding 的通用約定名）
  if (isWebKvLike(env?.KV)) return env.KV
  if (isWebKvLike(g?.KV)) return g.KV
  return null
}

/**
 * 獲取代理內部調用密鑰。
 *
 * Edge Function 側用**完整密鑰**校驗 X-Internal-Call。
 *
 * 只從環境變量讀取，原因：
 *  1. 若走 KV 回退讀取密鑰，則需要先訪問 KV 才能拿密鑰、拿密鑰才能訪問 KV，
 *     形成循環依賴；
 *  2. 打包產物中不能依賴源碼相對路徑的動態 import。
 *
 * 因此 KV 代理模式要求顯式配置 JWT_SECRET（推薦 32+ 字符，不強制長度）。
 */
function getProxySecret(env?: EnvContext): string | null {
  try {
    const s = env?.JWT_SECRET
    // 只要求「非空」，不再強制 >=16：
    //   - 強制長度會把用戶合法設置的短密鑰判成「未配置」，進而報一個
    //     看起來無關的 NO_STORAGE / PROXY_CONFIG 錯誤，誤導排查方向；
    //   - 密鑰強度是**運維建議**（推薦 32+ / openssl rand -hex 32），
    //     不是程式可以替他決定的門檻。此處與 db.ts:readEnvEncryptionKey
    //     的策略保持一致，避免同一變量在不同路徑下長度要求不同。
    return typeof s === "string" && s.trim().length > 0 ? s : null
  } catch {
    return null
  }
}

/**
 * 當前環境是否有充分依據啟用 EdgeOne KV HTTP 代理探測。
 *
 * `__requestOrigin` 不能作為平台依據：index.ts 會給所有平台和自託管請求注入它。
 * 舊實現只要同時看到 origin 與 JWT_SECRET，就會在 DB_DRIVER=auto 時請求當前站點
 * 的 /kv-list；沒有該代理的站點若恰好把未知路徑回退成 HTML 200，便會被誤判為
 * KV 可用，隨後把 HTML 當 JSON 讀取，並讓 /env_check 錯報 ready=true。
 *
 * 只有以下情況才允許無 binding 的代理模式：
 *  1. 用戶顯式指定 DB_DRIVER=kv；
 *  2. 用戶顯式提供 EO_KV_URLS；
 *  3. EdgeOne Node 雲函數的可靠 SCF 運行時標記存在。
 */
function shouldProbeProxy(env?: any): boolean {
  const configured = String(env?.DB_DRIVER || "")
    .trim()
    .toLowerCase()
  const procEnv: any =
    typeof process !== "undefined" ? (process as any).env || {} : {}
  return Boolean(
    configured === "kv" ||
    env?.EO_KV_URLS ||
    env?.TENCENTCLOUD_SCF_FUNCTIONNAME ||
    procEnv.TENCENTCLOUD_SCF_FUNCTIONNAME,
  )
}

/**
 * Detect missing configuration for KV proxy mode.
 *
 * Triggered when all of the following hold:
 *  1. The current env has no KV binding, so the HTTP proxy must be used.
 *  2. No JWT_SECRET is configured at all, so the proxy cannot be
 *     authenticated.
 *
 * The combination "no binding + proxy required" only occurs on EdgeOne Node
 * Functions: Cloudflare Workers have a native binding, and other platforms
 * never take the proxy branch. So no platform sniffing is needed.
 *
 * @returns A human-readable configuration error, or null when valid.
 */
export function checkProxyConfig(env?: any): string | null {
  try {
    if (getKvBinding(env) !== null) return null // binding mode, no secret needed
    if (getProxySecret(env)) return null // secret present
  } catch {
    // 探測自身異常（異常 getter 等）視為「無可用 binding」，
    // 繼續走到報錯分支，而不是讓調用方崩潰。
  }

  return (
    "KV proxy mode requires the JWT_SECRET environment variable to be set.\n" +
    "Reason: EdgeOne Node Functions cannot access KV directly and must go " +
    "through an Edge Function proxy, whose authentication depends on this " +
    "secret.\n" +
    "Add it under Environment Variables in the EdgeOne project settings, for " +
    "example:\n" +
    "  JWT_SECRET=<random string, 32+ characters recommended>\n" +
    "Generate one with: openssl rand -hex 32"
  )
}

/**
 * 構建 HTTP 代理請求頭
 */
function buildProxyHeaders(env?: EnvContext): HeadersInit {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
  }

  // 內部調用標識：提交**完整密鑰**（Edge Function 側常量時間比對）。
  // 不截斷 —— 截斷會把熵降到 64 bit，且該通道繞過管理員角色校驗。
  const sharedSecret = getProxySecret(env)
  if (sharedSecret) {
    headers["X-Internal-Call"] = sharedSecret
  }

  // 如果有用戶 token，也攜帶上（用於角色校驗）
  const userToken = (env as any)?._currentUserToken
  if (userToken) {
    headers["Authorization"] = `Bearer ${userToken}`
  }

  return headers
}

/**
 * 獲取 HTTP 代理基礎 URL（必須是絕對地址）。
 *
 * Node 的 fetch 不接受相對 URL（會拋 ERR_INVALID_URL），因此這裡不能返回 ""。
 * 優先級：
 *  1. EO_KV_URLS —— 顯式配置的完整地址（跨域 / 本地調試）
 *  2. __requestOrigin —— 由 index.ts 中間件注入的當前請求 origin，
 *     即同一部署的自身域名，用於 Node 雲函數自調用 Edge Function
 */
function getProxyBaseUrl(env?: EnvContext): string {
  if (!env) return ""

  const explicit = (env as any).EO_KV_URLS
  if (explicit) {
    const safe = sanitizeProxyOrigin(explicit, env)
    if (safe) return safe
  }

  const origin = (env as any).__requestOrigin
  if (origin) {
    const safe = sanitizeProxyOrigin(origin, env)
    if (safe) return safe
  }

  return ""
}

/**
 * KV 代理健康探測（唯一實現）。
 *
 * isAvailable() 與 health() 共用，避免兩處各自實現導致判定標準漂移。
 * 判定：HTTP 200 表示代理與 KV 均可用；401 表示代理可達但鑑權失敗，
 * 屬於「代理部署存在但密鑰不對」。
 *
 * 注意兩個調用方對 401 的取捨不同，故這裡只返回原始探測結果，
 * 由 probeToAvailability() / probeToHealth() 分別映射（見其註釋）：
 *   - isAvailable() 把 401 視為可用（代理已部署，驅動可被選中）
 *   - health() 把 401 視為不可用（鑑權失敗，持久化不可依賴）
 */
async function probeProxy(
  env?: EnvContext,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const configError = checkProxyConfig(env)
  if (configError) {
    return { ok: false, status: 0, error: configError.split("\n")[0] }
  }

  const baseUrl = getProxyBaseUrl(env)
  if (!baseUrl) {
    return {
      ok: false,
      status: 0,
      error:
        "cannot determine deployment origin. " +
        "Set EO_KV_URLS to the deployment origin.",
    }
  }

  try {
    const url = `${baseUrl}/kv-list?prefix=__health__`
    const response = await fetch(url, {
      method: "GET",
      headers: buildProxyHeaders(env),
    })
    return { ok: response.ok, status: response.status }
  } catch (err: any) {
    return { ok: false, status: 0, error: err?.message || String(err) }
  }
}

/**
 * 把「原始探測結果」映射為**可用性**（`isAvailable` 的語義）。
 *
 * 401 視為可用：代理已部署，只是密鑰不匹配 —— 此時應讓 kv 被選中，
 * 再由 `health()` 報出不健康。若這裡判為不可用，`auto` 會悄悄換用別的後端，
 * 而用戶明明配了 KV 代理，只會更困惑。
 */
function probeToAvailability(probe: { ok: boolean; status: number }): boolean {
  return probe.ok || probe.status === 401
}

/**
 * 把「原始探測結果」映射為**健康狀態**（`health()` 的語義）。
 *
 * 401 視為不健康：對依賴持久化的介面而言，鑑權失敗就是不能讀寫，
 * `/env_check` 不應把它判成 ready。
 *
 * 兩者對 401 的取捨**不同且是有意為之**。抽成具名函數是為了讓這個差異
 * 在調用點顯式可見，而不是散落在 `!probe.ok && probe.status !== 401`
 * 這類字面表達式裡（那需要讀者反推語義）。
 */
function probeToHealth(probe: { ok: boolean }): boolean {
  return probe.ok
}

/**
 * 解析代理基礎 URL，無法確定時拋出明確錯誤。
 *
 * 集中校驗「密鑰 + origin」兩個前置條件，避免各方法重複檢查，
 * 也讓 Node 的 ERR_INVALID_URL 不會以晦澀形式出現在日誌裡。
 */
function requireProxyBaseUrl(env?: EnvContext): string {
  const configError = checkProxyConfig(env)
  if (configError) {
    throw new Error("KV proxy misconfigured: " + configError.split("\n")[0])
  }

  const baseUrl = getProxyBaseUrl(env)
  if (!baseUrl) {
    throw new Error(
      "KV proxy base URL unavailable: cannot determine deployment origin. " +
        "Set EO_KV_URLS to the deployment origin.",
    )
  }

  return baseUrl
}

export const kvDriver: Driver = {
  name: "kv",

  async isAvailable(env?: any): Promise<boolean> {
    // 模式1: 檢查 KV binding
    if (getKvBinding(env) !== null) {
      return true
    }

    // 模式2: HTTP 代理（EdgeOne Node Functions 拿不到 binding）
    // __requestOrigin 本身不能證明代理存在；auto 模式下必須有顯式配置或
    // EdgeOne Node 的平台標記，否則未知路由的 HTML 200 會造成假陽性。
    if (!shouldProbeProxy(env)) return false
    const probe = await probeProxy(env)
    if (!probeToAvailability(probe)) {
      if (probe.error)
        console.error("[DB] KV proxy unavailable: " + probe.error)
      return false
    }
    return true
  },

  async init(env?: any): Promise<void> {
    // KV 無需初始化
  },

  async get(key: string, env?: any): Promise<string | null> {
    const kv = getKvBinding(env)

    // 模式1: Binding 模式
    if (kv) {
      // Cloudflare KV 用 get(key, "text")，EdgeOne KV 用 get(key, {type:"text"})，
      // 兩者簽名不相容，需按序嘗試並歸一化返回值（避免拿到對象導致上游 JSON.parse 失敗）。
      //
      // 但要區分「簽名不相容」與「真實故障」：
      //   - 簽名不相容會拋 TypeError（參數類型不符），此時才應回退到第二種簽名；
      //   - 網路/權限錯誤（401、超時等）必須**原樣拋出**，否則會被第二次嘗試
      //     掩蓋成 "key not found"，讓調用方誤判為資料不存在而寫入錯誤狀態。
      const isSignatureError = (e: any): boolean =>
        e instanceof TypeError ||
        /not a function|invalid|unexpected|argument/i.test(
          String(e?.message || ""),
        )

      let value: any
      try {
        value = await kv.get(key, "text")
      } catch (e) {
        if (!isSignatureError(e)) throw e
        value = undefined
      }

      if (value === undefined || value === null) {
        try {
          value = await kv.get(key, { type: "text" })
        } catch (e) {
          // 若第一種簽名已成功執行（未拋簽名錯誤），說明第二種只是"空結果"的回退，
          // 此時真實錯誤同樣要拋出，不得吞掉。
          if (!isSignatureError(e)) throw e
          value = null
        }
      }

      if (value === undefined || value === null) return null
      if (typeof value === "string") return value
      // 綁定誤返回對象時統一序列化，保持 Driver.get 的 string 契約
      return JSON.stringify(value)
    }

    // 模式2: HTTP 代理模式（無原生 binding → 經 Edge Function 代理）
    const baseUrl = requireProxyBaseUrl(env)
    const url = `${baseUrl}/kv-get?key=${encodeURIComponent(key)}`

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: buildProxyHeaders(env),
      })

      if (!response.ok) {
        if (response.status === 404) {
          return null
        }
        throw new Error(`KV proxy get failed: ${response.status}`)
      }

      const data = (await response.json()) as { value?: string | null }
      // 歸一化為 string | null：Edge Function 在錯誤分支只返回 { error }，
      // 此時 data.value 為 undefined，不能直接透傳（調用方按 === null 判斷會漏掉）。
      if (data?.value === undefined || data?.value === null) return null
      return typeof data.value === "string" ? data.value : String(data.value)
    } catch (err) {
      console.error(`[KV] get(${key}) failed:`, err)
      throw err
    }
  },

  async put(key: string, value: string, env?: any): Promise<void> {
    const kv = getKvBinding(env)

    // 模式1: Binding 模式
    if (kv) {
      await kv.put(key, value)
      return
    }

    // 模式2: HTTP 代理模式
    const baseUrl = requireProxyBaseUrl(env)
    const url = `${baseUrl}/kv-put`

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: buildProxyHeaders(env),
        body: JSON.stringify({ key, value }),
      })

      if (!response.ok) {
        throw new Error(`KV proxy put failed: ${response.status}`)
      }
    } catch (err) {
      console.error(`[KV] put(${key}) failed:`, err)
      throw err
    }
  },

  async delete(key: string, env?: any): Promise<void> {
    const kv = getKvBinding(env)

    // 模式1: Binding 模式
    if (kv) {
      await kv.delete(key)
      return
    }

    // 模式2: HTTP 代理模式
    const baseUrl = requireProxyBaseUrl(env)
    const url = `${baseUrl}/kv-delete?key=${encodeURIComponent(key)}`

    try {
      const response = await fetch(url, {
        method: "DELETE",
        headers: buildProxyHeaders(env),
      })

      if (!response.ok && response.status !== 404) {
        throw new Error(`KV proxy delete failed: ${response.status}`)
      }
    } catch (err) {
      console.error(`[KV] delete(${key}) failed:`, err)
      throw err
    }
  },

  async list(prefix: string, env?: any): Promise<string[]> {
    const kv = getKvBinding(env)

    // 模式1: Binding 模式
    if (kv) {
      // EdgeOne KV list() 語義（依據官方 functions-kv 示例）：
      //   page.keys -> [{ key, ttl, meta }]，page.complete 為 true 表示末頁，
      //   下一頁 cursor 需手動取本頁最後一個 key。
      const keys: string[] = []
      let cursor = ""
      let complete = false
      let guard = 0

      while (!complete && guard < 1000) {
        guard += 1

        const page = await kv.list({ prefix, cursor, limit: 256 })
        const pageKeys = Array.isArray(page?.keys) ? page.keys : []

        for (const item of pageKeys) {
          if (item?.key) keys.push(item.key)
        }

        if (pageKeys.length > 0) {
          cursor = pageKeys[pageKeys.length - 1].key || ""
        }

        complete = Boolean(page?.complete) || pageKeys.length === 0
      }

      return keys
    }

    // 模式2: HTTP 代理模式
    const baseUrl = requireProxyBaseUrl(env)
    const url = `${baseUrl}/kv-list?prefix=${encodeURIComponent(prefix)}`

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: buildProxyHeaders(env),
      })

      if (!response.ok) {
        throw new Error(`KV proxy list failed: ${response.status}`)
      }

      const data = (await response.json()) as { keys: string[] }
      return data.keys || []
    } catch (err) {
      console.error(`[KV] list(${prefix}) failed:`, err)
      throw err
    }
  },

  async health(env?: any): Promise<any> {
    const kv = getKvBinding(env)

    // 模式1: Binding 模式
    if (kv) {
      try {
        await kv.get("__health_check__")
        return {
          driver: "kv",
          mode: "binding",
          available: true,
          platform: "Cloudflare KV / EdgeOne KV",
        }
      } catch (err: any) {
        return {
          driver: "kv",
          mode: "binding",
          available: false,
          error: err?.message || String(err),
        }
      }
    }

    // 模式2: HTTP 代理模式。
    //
    // 判定比 isAvailable 更嚴格（見 probeToHealth / probeToAvailability 的註釋）：
    // 健康狀態必須真正可讀寫，401 表示鑑權失敗（代理在但密鑰不對），對依賴
    // 持久化的介面而言應報不可用，而不是被 /env_check 判定為 ready。
    // 共用 probeProxy 僅複用探測動作，語義映射分別具名。
    const probe = await probeProxy(env)
    if (!probeToHealth(probe)) {
      return {
        driver: "kv",
        mode: "proxy",
        available: false,
        error: probe.error || `HTTP ${probe.status}`,
      }
    }

    return {
      driver: "kv",
      mode: "proxy",
      available: true,
      platform: "EdgeOne KV (via Edge Function proxy)",
    }
  },
}
