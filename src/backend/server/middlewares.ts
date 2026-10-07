import { Context } from "hono"
import { verify } from "hono/jwt"
import { checkAdminAuth, isStaticApiToken } from "../pkg/utils"
import { getDb, readPersistedSecret, ENCRYPTION_SECRET_KV_KEY } from "../internal/model/db"

// 不再硬編碼 JWT 密鑰。優先使用環境變量 JWT_SECRET（推薦在生產配置），
// 否則從持久化後端讀取一個隨機密鑰（首次生成後複用，重啟不失效），
// 開發環境（無持久化）回退到進程內隨機密鑰。
//
// 快取粒度：**按 env 對象**，而不是單一的進程級變量。
//
// 為什麼必須分 env：`env` 決定「去哪個後端讀密鑰」（driver 由 env 解析）。
// 一個進程若先後服務兩套不同配置（多環境/多項目共用實例、本地同時連兩套配置、
// 測試），單一進程級快取會把先讀到的那把密鑰發給另一套環境，導致跨環境 token
// 可以互相驗證。Go 版不存在這個問題——它是單進程單部署，密鑰在啟動時由
// `conf.Conf.JwtSecret` 一次性確定（server/router.go: common.SecretKey）；
// TS 版必須按 env 隔離才能保持同樣的語義。
let cachedJwtSecret: string | null = null
let jwtSecretByEnv = new WeakMap<object, string>()
const JWT_SECRET_KV_KEY = "openlist_jwt_secret"

/** 記錄某個 env 的密鑰，並更新進程級 last-known 值（無 env 對象時的兜底）。 */
function rememberJwtSecret(env: any, secret: string): void {
  if (env && typeof env === "object") jwtSecretByEnv.set(env, secret)
  cachedJwtSecret = secret
}

/** 讀取某個 env 的快取密鑰；沒有 env 對象時退回進程級 last-known 值。 */
function readCachedJwtSecret(env: any): string | null {
  if (env && typeof env === "object") return jwtSecretByEnv.get(env) ?? null
  return cachedJwtSecret
}

/**
 * 清除 JWT secret 快取（全部 env），用於強制下次調用重新解析密鑰來源。
 *
 * 語義邊界（與 Go 對齊，勿誇大）：
 *   - Go 的 `reset_token` 重置的是**鏈接簽名密鑰**，即 DB 裡的 `token` 設置
 *     （internal/sign/sign.go: NewHMACSign(setting.GetStr(conf.Token))），
 *     並不更換 JWT 密鑰（JWT 用 common.SecretKey = conf.Conf.JwtSecret）；
 *   - TS 的 JWT 密鑰來自 env.JWT_SECRET 或持久化的 openlist_jwt_secret，清快取
 *     後讀到的是**同一把**密鑰，因此已簽發的 JWT **不會**失效——這與 Go 一致。
 * 若確實要求所有已簽發 JWT 立即失效，必須更換密鑰本身，而不是隻清快取。
 */
export function resetJwtSecretCache(): void {
  cachedJwtSecret = null
  // WeakMap 無法逐項清空，整體替換即可（舊條目隨 env 一起被 GC）。
  jwtSecretByEnv = new WeakMap<object, string>()
}

function generateRandomSecret(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

async function readKvSecret(env: any): Promise<string | null> {
  try {
    // 複用 store/json 的通用密鑰讀取（已支持 binding/blob/api/proxy 全模式）
    const { readPersistedSecret } = await import("../internal/model/db")
    return await readPersistedSecret(env, JWT_SECRET_KV_KEY)
  } catch (e) {
    console.warn("[JWT] Failed to read secret from KV:", e)
    return null
  }
}

async function writeKvSecret(env: any, secret: string): Promise<boolean> {
  try {
    const { writePersistedSecret } = await import("../internal/model/db")
    return await writePersistedSecret(env, JWT_SECRET_KV_KEY, secret)
  } catch (e) {
    console.warn("[JWT] Failed to persist secret to KV:", e)
    return false
  }
}

/**
 * 獲取 JWT 簽名密鑰。
 * 優先級：env.JWT_SECRET > KV 持久化隨機密鑰 > 進程內隨機密鑰（僅開發環境）。
 */
export async function getJwtSecret(c?: Context | any): Promise<string> {
  const env =
    c?.env || (typeof process !== "undefined" ? (process as any).env : {}) || {}

  // ── 長度策略：只要求「非空」，32 字符為**推薦值**（不強制）──
  //
  // 這裡曾有三個互不相同的閾值：env 走 `>=16`、快取走 `>=32`、持久化走
  // `>=32`。後果是 **自動生成/持久化的密鑰會被讀取路徑判為無效**：
  //   setup 寫入的密鑰若不足 32 字符，第 2 步 `>=32` 判定失敗 → 落到第 4 步
  //   **重新生成**一把新密鑰 → 每次冷啟動換鑰 → 已簽發的 token 全部失效、
  //   多實例間驗籤互相失敗（表現為「登入成功後立刻 401」）。
  // 也就是說「自動生成」看著寫了、實際沒生效。現在統一為「非空即有效」，
  // 與 db.ts:readEnvEncryptionKey 完全一致，保證「寫進去的」必定「讀得出來」。
  const useSecret = (s: unknown): string | null =>
    typeof s === "string" && s.trim().length > 0 ? s : null

  // 1. 環境變量顯式配置（最優先）
  const envSecret = useSecret(env.JWT_SECRET)
  if (envSecret) {
    return envSecret
  }

  // 2. 持久化密鑰（跨實例/重啟穩定），按 env 快取
  // 性能修復：命中後直接返回快取，避免每次調用都回源儲存。
  // 修復前此分支只 `return kvSecret` 而不寫快取，導致
  // getUserFromContext / csrfProtection / checkAdminAuth 等每請求 2-4 次調用
  // 都會各自觸發一次後端讀取（KV/D1 後端下這是最貴的操作之一）。
  //
  // 快取粒度按 env 隔離（readCachedJwtSecret/rememberJwtSecret，見文件頭註釋），
  // 判定統一走 useSecret（「非空即有效」），不再用長度閾值。
  const cached = readCachedJwtSecret(env)
  if (useSecret(cached)) {
    return cached as string
  }

  // 2a. 複用 setup 自動生成的共享密鑰（openlist_encryption_secret）。
  //
  // 為什麼必須放在這裡：`ensureEncryptionSecret()` 在 setup 階段把自動生成的
  // 密鑰寫進 **openlist_encryption_secret**，而本函數歷史實現只找
  // **openlist_jwt_secret** —— 兩個槽位名不同。於是「自動生成」的那把密鑰
  // 對 JWT 側**完全不可見**：本函數會再生成一把存到另一個槽位，
  // 造成同一部署裡兩把密鑰各自漂移（多實例驗籤失敗、冷啟動即換鑰）。
  // 約定 JWT 簽名與欄位加密共用同一把密鑰（見 db.ts 的「靜態加密」註釋塊；
  // 欄位加密是否啟用由 DB_CIPHER 決定，與密鑰來源無關），因此這裡
  // 顯式回退讀取該槽位，保證「生成了一份」就等於「兩邊都可用」。
  try {
    const sharedSecret = useSecret(
      await readPersistedSecret(env, ENCRYPTION_SECRET_KV_KEY),
    )
    if (sharedSecret) {
      rememberJwtSecret(env, sharedSecret)
      return sharedSecret
    }
  } catch {
    // 讀取失敗按「無持久化密鑰」處理，繼續走下面的獨立槽位
  }

  // 2b. 獨立的 JWT 密鑰槽位（歷史部署可能已在此寫入）
  const kvSecret = useSecret(await readKvSecret(env))
  if (kvSecret) {
    rememberJwtSecret(env, kvSecret)
    return kvSecret
  }

  // 3. 檢查是否為生產環境
  const isProduction =
    env.NODE_ENV === "production" ||
    env.ENVIRONMENT === "production" ||
    env.CF_PAGES === "1" ||
    env.WORKERS_ENV === "production"

  // 4. 生成隨機密鑰並嘗試持久化（開發 + 生產相容）
  //
  // 以**當前 env** 的快取值判斷是否需要生成：同一 env 的重複/併發調用只生成
  // 一次（這裡先同步 remember 再 await 持久化，避免併發各生成一把密鑰，導致
  // 同一時刻簽發的 token 互相驗不過）。
  if (!readCachedJwtSecret(env)) {
    const generated = generateRandomSecret()
    rememberJwtSecret(env, generated)
    const persisted = await writeKvSecret(env, generated)
    
    if (isProduction) {
      console.error(
        "[JWT] ⚠️ 🔴 生產環境安全警告：JWT_SECRET 未配置！" +
        (persisted
          ? "\n✅ 已自動生成密鑰並持久化到 KV。此密鑰將持續使用，但強烈建議手動配置 JWT_SECRET 環境變量以提高安全性。"
          : "\n❌ 無法持久化密鑰到 KV！密鑰僅存於記憶體，重啟後所有 token 將失效。請立即配置 JWT_SECRET 環境變量！") +
        "\n\n🔒 安全建議：生成密鑰命令: openssl rand -hex 32"
      )
    } else {
      console.warn(
        "[JWT] ⚠️  開發環境警告：JWT_SECRET 未配置，使用臨時隨機密鑰。" +
        (persisted
          ? "密鑰已持久化到 KV，重啟後保持有效。"
          : "密鑰僅存於記憶體，重啟後所有 token 將失效。") +
        "\n生產環境部署前，建議配置 32+ 字符的 JWT_SECRET 環境變量（推薦而非強制）。"
      )
    }
  }
  // 走到這裡一定已有密鑰：步驟 2 命中快取，或步驟 4 剛生成並 remember。
  return readCachedJwtSecret(env) as string
}

// ---- JWT 註銷黑名單（盡力而為：進程內 Set + KV 持久化）----
// 說明：Serverless 多實例下各實例獨立快取，KV 持久化僅在冷啟動時加載一次，
// 因此跨實例的「即時」失效不能保證精確，但能在單實例內立即生效，並隨新實例
// 冷啟動逐步收斂。exp 過期後條目自動清理，不會無限增長。
const REVOKED_KV_KEY = "openlist_revoked_tokens"
const revokedJtis = new Set<string>()
let revokedLoaded = false

async function ensureRevokedLoaded(env: any): Promise<void> {
  if (revokedLoaded) return
  revokedLoaded = true
  try {
    const { getKvBinding } = await import("../internal/model/db")
    const kvInfo = await getKvBinding(env)
    if (kvInfo.mode === "none" || !kvInfo.binding) return
    const { binding, mode } = kvInfo
    let val: any = null
    if (mode === "blob") {
      val = await binding.get(REVOKED_KV_KEY)
    } else {
      try {
        val = await binding.get(REVOKED_KV_KEY, "text")
      } catch {
        val = await binding.get(REVOKED_KV_KEY)
      }
    }
    if (val && typeof val.text === "function") val = await val.text()
    if (!val) return
    const arr = JSON.parse(String(val))
    const now = Math.floor(Date.now() / 1000)
    for (const item of arr) {
      if (item && item.jti && item.exp > now) revokedJtis.add(item.jti)
    }
  } catch {
    // 黑名單加載失敗時降級為不攔截（不影響登入）
  }
}

export async function revokeToken(
  jti: string,
  exp: number,
  env: any,
): Promise<void> {
  if (!jti) return
  revokedJtis.add(jti)
  try {
    const { getKvBinding } = await import("../internal/model/db")
    const kvInfo = await getKvBinding(env)
    if (kvInfo.mode === "none" || !kvInfo.binding) return
    const { binding, mode } = kvInfo
    let arr: Array<{ jti: string; exp: number }> = []
    if (mode === "blob") {
      const val = await binding.get(REVOKED_KV_KEY)
      if (val) arr = typeof val === "string" ? JSON.parse(val) : val
    } else {
      try {
        const val = await binding.get(REVOKED_KV_KEY, "text")
        if (val) arr = JSON.parse(String(val))
      } catch {
        const val = await binding.get(REVOKED_KV_KEY)
        if (val) arr = typeof val === "string" ? JSON.parse(val) : val
      }
    }
    const now = Math.floor(Date.now() / 1000)
    arr = arr.filter((i) => i && i.exp > now)
    arr.push({ jti, exp })
    const payload = JSON.stringify(arr)
    if (mode === "blob") {
      if (typeof binding.set === "function")
        await binding.set(REVOKED_KV_KEY, payload)
      else if (typeof binding.put === "function")
        await binding.put(REVOKED_KV_KEY, payload)
    } else {
      if (typeof binding.put === "function")
        await binding.put(REVOKED_KV_KEY, payload)
      else if (typeof binding.set === "function")
        await binding.set(REVOKED_KV_KEY, payload)
    }
  } catch (e) {
    console.warn("[JWT] Failed to persist revoked token to KV:", e)
  }
}

export async function isTokenRevoked(jti: string, env: any): Promise<boolean> {
  if (!jti) return false
  await ensureRevokedLoaded(env)
  return revokedJtis.has(jti)
}

export async function adminAuthMiddleware(
  c: Context,
  next: () => Promise<void>,
) {
  const isAdmin = await checkAdminAuth(c)
  if (!isAdmin) {
    return c.json(
      {
        code: 401,
        message: "Unauthorized admin privilege required",
        data: null,
      },
      401,
    )
  }
  await next()
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * 定時調度鑑權通道：EdgeOne Schedules 只能攜帶 path/method/payload，
 * 無法附加 Authorization 頭。複用 JWT_SECRET 作為調度密鑰，
 * 允許請求通過 query（?cron_secret=）、JSON body { cron_secret }
 * 或 X-Cron-Secret 頭攜帶匹配值觸發受保護的任務介面。
 */
export async function matchCronSecret(c: Context): Promise<boolean> {
  const env = (c as any)?.env || {}
  const secret =
    env.JWT_SECRET ||
    (typeof process !== "undefined" ? process.env?.JWT_SECRET : "")
  if (!secret || typeof secret !== "string") return false

  const header = c.req.header("x-cron-secret")
  if (header && timingSafeEqual(header, secret)) return true

  const query = c.req.query("cron_secret")
  if (query && timingSafeEqual(query, secret)) return true

  try {
    const body = await c.req.json()
    const provided = body?.cron_secret
    if (
      typeof provided === "string" &&
      provided.length > 0 &&
      timingSafeEqual(provided, secret)
    ) {
      return true
    }
  } catch {}

  return false
}

/**
 * 從請求上下文解析當前用戶：
 * - 靜態 API Token（與 adminAuthMiddleware 同源）→ 視為管理員
 * - JWT（Authorization header 或 query parameter token/access_token）→ 查 DB 用戶
 * - 無憑證時，僅當資料庫中存在且未禁用的 guest 用戶時才返回該遊客信息；
 * - 若 guest 用戶不存在（被刪除）或被禁用，則返回 null（未授權狀態）。
 */
// ============ CSRF 防護 (添加日期: 2026-09-05) ============
/**
 * 生成 CSRF Token（短期有效，1小時過期）
 */
export async function generateCSRFToken(c: Context): Promise<string> {
  const { sign } = await import("hono/jwt")
  const secret = await getJwtSecret(c)
  const token = await sign(
    {
      type: "csrf",
      jti: crypto.randomUUID ? crypto.randomUUID() : generateRandomSecret().slice(0, 16),
      exp: Math.floor(Date.now() / 1000) + 3600, // 1 小時過期
    },
    secret,
  )
  return token
}

/**
 * CSRF 保護中間件：對 POST/PUT/DELETE/PATCH 請求驗證 CSRF token
 * GET/HEAD/OPTIONS 請求豁免檢查
 * 
 * 安全增強 (2026-09-08):
 * - 僅允許從 HTTP Header 獲取 token（移除 Query 和 Body 獲取）
 * - 防止 JSON 劫持和 URL 洩露攻擊
 */
export async function csrfProtection(
  c: Context,
  next: () => Promise<void>,
) {
  const method = c.req.method.toUpperCase()

  // GET/HEAD/OPTIONS 請求無需 CSRF 驗證
  if (["GET", "HEAD", "OPTIONS"].includes(method)) {
    return next()
  }

  // 僅從 HTTP Header 獲取 CSRF token（安全最佳實踐）
  // 移除 Query 和 Body 獲取以防止攻擊者通過 JSON 劫持或 URL 洩露繞過 CSRF 防護
  const token = c.req.header("x-csrf-token") || c.req.header("X-CSRF-Token")

  if (!token) {
    return c.json(
      {
        code: 403,
        message: "CSRF token missing. Please include X-CSRF-Token header.",
        data: null,
      },
      403,
    )
  }

  try {
    const { verify } = await import("hono/jwt")
    const secret = await getJwtSecret(c)
    const payload: any = await verify(token, secret, "HS256")

    if (payload.type !== "csrf") {
      throw new Error("Invalid token type")
    }

    // Token 有效，繼續處理
    await next()
  } catch (err: any) {
    return c.json(
      {
        code: 403,
        message: "Invalid or expired CSRF token",
        data: null,
      },
      403,
    )
  }
}

// ============ 審計日誌中間件 (添加日期: 2026-09-05) ============
/**
 * 審計日誌中間件：記錄所有狀態修改操作
 * 僅記錄 POST/PUT/DELETE/PATCH 請求
 */
export async function auditMiddleware(
  c: Context,
  next: () => Promise<void>,
) {
  const startTime = Date.now()
  const method = c.req.method.toUpperCase()
  const path = c.req.path

  // 僅記錄狀態修改操作
  const shouldAudit = ["POST", "PUT", "DELETE", "PATCH"].includes(method)

  await next()

  if (shouldAudit) {
    try {
      const { logAudit } = await import("../internal/model/audit")
      const user = await getUserFromContext(c).catch(() => null)
      const duration = Date.now() - startTime
      const statusCode = c.res.status || 200
      const status = statusCode >= 200 && statusCode < 400 ? "success" : "failure"

      // 獲取客戶端 IP
      const ip =
        c.req.header("cf-connecting-ip") ||
        c.req.header("x-real-ip") ||
        c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
        "unknown"

      await logAudit(
        {
          user_id: user?.id,
          username: user?.username || "anonymous",
          ip,
          action: `${method} ${path}`,
          resource: path,
          method,
          status,
          status_code: statusCode,
          details: JSON.stringify({ duration_ms: duration }),
          user_agent: c.req.header("user-agent"),
          duration_ms: duration,
        },
        c.env,
      )
    } catch (err) {
      // 審計日誌失敗不影響業務流程
      console.warn("[Audit] Failed to log:", err)
    }
  }
}

export async function getUserFromContext(c: Context): Promise<{
  id?: number
  role: number
  permission: number
  disabled?: boolean
  username?: string
  base_path?: string
  sso_id?: string
  allow_ldap?: boolean
  otp_secret?: string
} | null> {
  // 僅靜態 API token（settings.token）命中才視為匿名管理員；
  // JWT 管理員走下方正常解析，避免用戶名被硬編碼成 "api-token"。
  if (await isStaticApiToken(c)) {
    return {
      role: 2,
      permission: 0,
      disabled: false,
      username: "api-token",
      base_path: "/",
    }
  }

  let authHeader = c.req.header("Authorization")
  if (!authHeader) {
    const queryToken = c.req.query("token") || c.req.query("access_token")
    if (queryToken) {
      authHeader = `Bearer ${queryToken}`
    }
  }

  // 無 Authorization header：嘗試使用 guest 用戶作為後備
  // 注意：guest 不可用時返回 null 是合理的，調用方應該正確處理
  if (!authHeader) {
    try {
      const db = await getDb(c.env)
      const guest = (db.users || []).find((u: any) => u.username === "guest")
      if (guest && !guest.disabled) {
        return {
          id: guest.id,
          role: guest.role ?? 1,
          permission: guest.permission ?? 0,
          disabled: !!guest.disabled,
          username: guest.username,
          base_path: guest.base_path || "/",
          sso_id: guest.sso_id || "",
          allow_ldap: !!guest.allow_ldap,
          otp_secret: guest.otp_secret,
        }
      }
    } catch {}
    // guest 不存在或被禁用，返回 null
    // 調用方應該檢查是否有其他方式獲取用戶（如 query token）
    return null
  }

  const token = authHeader.startsWith("Bearer ")
    ? authHeader.substring(7)
    : authHeader
  try {
    const secret = await getJwtSecret(c)
    const payload: any = await verify(token, secret, "HS256")
    if (await isTokenRevoked(payload?.jti, c.env)) return null
    const db = await getDb(c.env)
    const user = (db.users || []).find(
      (u: any) => u.id === payload.id || u.username === payload.username,
    )
    if (!user || user.disabled) return null
    return {
      id: user.id,
      role: user.role,
      permission: user.permission ?? 0,
      disabled: !!user.disabled,
      username: user.username,
      base_path: user.base_path || "/",
      sso_id: user.sso_id || "",
      allow_ldap: !!user.allow_ldap,
      otp_secret: user.otp_secret,
    }
  } catch {
    return null
  }
}
