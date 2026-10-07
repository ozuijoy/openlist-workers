import { Hono, type Context } from "hono"
import { sign, verify } from "hono/jwt"
import { getDb, saveDb } from "../internal/model/db"
import {
  getJwtSecret,
  getUserFromContext,
  revokeToken,
  isTokenRevoked,
  generateCSRFToken,
} from "./middlewares"
import {
  generateTotpSecret,
  generateTotpCode,
  verifyTotpCode,
  buildOtpauthUrl,
  buildQrImageUrl,
} from "../pkg/totp"
import {
  listUserSshKeys,
  addUserSshKey,
  deleteUserSshKey,
} from "../internal/op/sshkey"
import {
  staticHash,
  saltedHash,
  generateSalt,
  setUserPassword,
  isHex64,
} from "../pkg/password"
import { setCSRFToken, clearCSRFToken } from "../pkg/csrf"
import { getAuditLogger } from "../pkg/audit"

export const authRouter = new Hono()
export const meRouter = new Hono()

// --- 登入防爆破（增強版：KV 共享 + 指數退避）---
// 2026-09-08 安全增強：
// 1. 使用 KV 儲存失敗計數，支持多實例共享
// 2. 指數退避鎖定時間，增加暴力破解成本
// 3. 失敗達到閾值後要求額外驗證（預留驗證碼集成）
const LOGIN_MAX_FAILURES = 5
const LOGIN_MAX_FAILURES_GLOBAL = 20
const LOGIN_LOCK_MS = 15 * 60 * 1000
const LOGIN_MAX_LOCK_MS = 24 * 60 * 60 * 1000 // 最長鎖定 24 小時
const loginFailures = new Map<
  string,
  { count: number; lockedUntil: number; attempts: number }
>()

function clientIpOf(c: Context): string {
  return (
    c.req.header("CF-Connecting-IP") ||
    c.req.header("x-real-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  )
}

function loginKey(c: Context, username: string): string {
  return `${clientIpOf(c)}|${String(username || "").toLowerCase()}`
}

// 與 IP 無關的用戶名維度計數，用於抵禦「偽造 IP 繞過鎖定」的分佈式爆破。
function globalLoginKey(username: string): string {
  return `__global__|${String(username || "").toLowerCase()}`
}

/**
 * 計算指數退避鎖定時間
 * 第 1-5 次失敗：15 分鐘
 * 第 6-10 次失敗：30 分鐘
 * 第 11-15 次失敗：1 小時
 * 第 16+ 次失敗：最長 24 小時
 */
function calculateLockDuration(attempts: number): number {
  const baseTime = LOGIN_LOCK_MS
  const multiplier = Math.pow(2, Math.floor(attempts / 5))
  return Math.min(baseTime * multiplier, LOGIN_MAX_LOCK_MS)
}

async function bumpLoginFailure(
  key: string,
  maxFailures: number,
  env: any,
): Promise<void> {
  const now = Date.now()
  let rec = loginFailures.get(key) || { count: 0, lockedUntil: 0, attempts: 0 }

  // 嘗試從 KV 讀取（多實例共享）
  try {
    const { getKvBinding } = await import("../internal/model/db")
    const kvInfo = await getKvBinding(env)
    if (kvInfo.mode !== "none" && kvInfo.binding) {
      const kvKey = `login_fail:${key}`
      let val: any = null
      try {
        val = await kvInfo.binding.get(kvKey, "text")
      } catch {
        val = await kvInfo.binding.get(kvKey)
      }
      if (val && typeof val.text === "function") {
        val = await val.text()
      }
      if (val) {
        try {
          rec = JSON.parse(String(val))
        } catch {
          // 解析失敗，使用默認值
        }
      }
    }
  } catch {
    // KV 不可用，回退到記憶體模式
  }

  if (rec.lockedUntil > now) return // already locked

  rec.count += 1
  rec.attempts += 1

  if (rec.count >= maxFailures) {
    const lockDuration = calculateLockDuration(rec.attempts)
    rec.lockedUntil = now + lockDuration
    rec.count = 0
    console.warn(
      `[Auth] Login attempts exceeded for ${key}. Locked for ${Math.round(lockDuration / 60000)} minutes (attempt #${rec.attempts}).`,
    )
  }

  loginFailures.set(key, rec)

  // 持久化到 KV
  try {
    const { getKvBinding } = await import("../internal/model/db")
    const kvInfo = await getKvBinding(env)
    if (kvInfo.mode !== "none" && kvInfo.binding) {
      const kvKey = `login_fail:${key}`
      const payload = JSON.stringify(rec)
      // 設置 TTL 為最長鎖定時間 + 1 小時
      const ttl = Math.ceil((LOGIN_MAX_LOCK_MS + 3600000) / 1000)
      if (typeof kvInfo.binding.put === "function") {
        await kvInfo.binding.put(kvKey, payload, { expirationTtl: ttl })
      }
    }
  } catch (err) {
    console.warn("[Auth] Failed to persist login failure to KV:", err)
  }
}

async function isLoginLocked(
  c: Context,
  username: string,
  env: any,
): Promise<boolean> {
  // 懶清理：Map 過大時清掉已過鎖定期/無鎖定的條目，防止無限增長
  if (loginFailures.size > 10000) {
    const now = Date.now()
    for (const [k, v] of loginFailures) {
      if (v.lockedUntil < now && v.count === 0) loginFailures.delete(k)
    }
  }

  const now = Date.now()
  const ipKey = loginKey(c, username)
  const globalKey = globalLoginKey(username)

  // 檢查記憶體快取
  let rec = loginFailures.get(ipKey)
  let grec = loginFailures.get(globalKey)

  // 嘗試從 KV 讀取（多實例共享）
  try {
    const { getKvBinding } = await import("../internal/model/db")
    const kvInfo = await getKvBinding(env)
    if (kvInfo.mode !== "none" && kvInfo.binding) {
      for (const key of [ipKey, globalKey]) {
        const kvKey = `login_fail:${key}`
        let val: any = null
        try {
          val = await kvInfo.binding.get(kvKey, "text")
        } catch {
          val = await kvInfo.binding.get(kvKey)
        }
        if (val && typeof val.text === "function") {
          val = await val.text()
        }
        if (val) {
          try {
            const data = JSON.parse(String(val))
            if (key === ipKey) rec = data
            if (key === globalKey) grec = data
            // 同步到記憶體快取
            loginFailures.set(key, data)
          } catch {
            // 解析失敗
          }
        }
      }
    }
  } catch {
    // KV 不可用，使用記憶體資料
  }

  if (rec && rec.lockedUntil > now) return true
  if (grec && grec.lockedUntil > now) return true
  return false
}

async function recordLoginFailure(
  c: Context,
  username: string,
  env: any,
): Promise<void> {
  await bumpLoginFailure(loginKey(c, username), LOGIN_MAX_FAILURES, env)
  await bumpLoginFailure(
    globalLoginKey(username),
    LOGIN_MAX_FAILURES_GLOBAL,
    env,
  )
}

async function clearLoginFailures(
  c: Context,
  username: string,
  env: any,
): Promise<void> {
  const ipKey = loginKey(c, username)
  const globalKey = globalLoginKey(username)

  loginFailures.delete(ipKey)
  loginFailures.delete(globalKey)

  // 從 KV 中刪除
  try {
    const { getKvBinding } = await import("../internal/model/db")
    const kvInfo = await getKvBinding(env)
    if (kvInfo.mode !== "none" && kvInfo.binding) {
      for (const key of [ipKey, globalKey]) {
        const kvKey = `login_fail:${key}`
        if (typeof kvInfo.binding.delete === "function") {
          await kvInfo.binding.delete(kvKey)
        }
      }
    }
  } catch (err) {
    console.warn("[Auth] Failed to clear login failures from KV:", err)
  }
}

// OpenList/AList StaticHash —— 前端 /login/hash 提交的哈希算法。
// 與新密碼模塊 pkg/password.staticHash 一致，保留舊名以相容既有調用。
export async function hashPasswordSHA256(
  plainPassword: string,
): Promise<string> {
  return staticHash(plainPassword)
}

/**
 * 校驗前端提交的靜態哈希是否匹配該用戶（等價 Go User.ValidatePwdStaticHash）。
 * 相容的儲存格式：
 *   - Go 雙層（user.salt 存在）：password === saltedHash(inputStatic, salt)
 *   - 早期 TSWorker 單層（無 salt）：password === inputStatic
 *   - bcrypt 遺留：返回 false（無明文不可還原），僅明文 /login 可逃生
 */
export async function verifyUserStaticHash(
  user: any,
  inputStatic: string,
): Promise<boolean> {
  const stored = String(user?.password || "")
    .trim()
    .toLowerCase()
  const input = String(inputStatic || "")
    .trim()
    .toLowerCase()
  if (!stored || !isHex64(input) || !isHex64(stored)) return false
  if (user?.salt) {
    const expect = (await saltedHash(input, String(user.salt))).toLowerCase()
    return stored === expect
  }
  return stored === input
}

/**
 * 校驗明文密碼（/login、改密舊密碼校驗、WebDAV Basic Auth 共用）。
 */
export async function verifyUserPassword(
  user: any,
  plain: string,
): Promise<boolean> {
  const stored = String(user?.password || "").trim()
  if (!stored) return false
  return verifyUserStaticHash(user, await staticHash(plain))
}

/**
 * 16 random bytes as hex — used whenever a password must exist but no
 * explicit one was provided. Never use a constant fallback instead.
 */
export function generateRandomPassword(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/** 生成 JWT 唯一標識（jti），用於註銷黑名單精確失效單個 token */
function generateJti(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

// Ensure admin user exists in DB KV space with a default password if unset
export async function getOrInitUsers(envCtx: any) {
  const db = await getDb(envCtx)
  if (!db.users || db.users.length === 0) {
    const envPass =
      (envCtx && envCtx.ADMIN_PASS) ||
      (typeof process !== "undefined" ? process.env?.ADMIN_PASS : "") ||
      ""
    const guest = {
      id: 2,
      username: "guest",
      password: "",
      role: 1,
      permission: 0,
      base_path: "/",
      disabled: false,
      sso_id: "",
      allow_ldap: false,
      pwd_update_at: new Date().toISOString(),
    }
    if (envPass) {
      // 顯式配置了 ADMIN_PASS：自動初始化 admin（保持相容）
      const admin: any = {
        id: 1,
        username: "admin",
        password: "",
        role: 2,
        permission: 0,
        base_path: "/",
        disabled: false,
        sso_id: "",
        allow_ldap: false,
        pwd_update_at: new Date().toISOString(),
      }
      await setUserPassword(admin, envPass)
      // 自愈：資料庫中完全沒有用戶時補回 admin/guest 佔位用戶。
      //
      // 注意：這裡構建出的庫在「尚無密碼、也無其它實體」時會被 saveDb 的寫前守衛
      // 判定為空殼。只有在當前庫可信（曾成功讀取過真實配置）時才允許強制落盤，
      // 否則寧可拒絕寫入，也不要讓「讀取失敗後的空庫」被誤當成已完成初始化。
      db.users = [admin, guest]
    } else {
      // 未初始化：僅創建 guest，admin 由 Web 安裝嚮導（POST /api/public/init/setup）創建
      db.users = [guest]
    }
    // 只有配置了 ADMIN_PASS（或已存在真實管理員）時，這份庫才不是空殼，
    // 才應該落盤。未配置時應等待 init/setup 完成初始化，而不是搶先寫入一個
    // 未初始化的佔位庫（會被 saveDb 的寫前守衛攔截）。
    const persisted = await saveDb(db, envCtx)
    if (!persisted) {
      console.warn(
        "[Auth] getOrInitUsers: skipped persisting an uninitialized placeholder DB " +
          "(expected until POST /api/public/init/setup completes).",
      )
    }
  } else {
    const adminUser = db.users.find((u: any) => u.role === 2)
    // FIX(F-11): the old logic silently reset any non-64-hex password (e.g. a
    // legacy PBKDF2 hash) back to admin/admin — meaning a routine upgrade
    // could quietly reopen the admin account to the world. New behavior:
    //   ADMIN_PASS set     -> explicit reset to that value (operator intent)
    //   password empty    -> random password, printed once to the log
    //   legacy-format     -> LEFT UNTOUCHED, only a warning is logged, so an
    //                        existing deployment is never locked out nor
    //                        silently reset by upgrading.
    const adminPass = adminUser ? String(adminUser.password || "").trim() : ""
    const isValidFormat = /^[0-9a-f]{64}$/i.test(adminPass)
    if (adminUser && !isValidFormat) {
      const envPass =
        (envCtx && envCtx.ADMIN_PASS) ||
        (typeof process !== "undefined" ? process.env?.ADMIN_PASS : "") ||
        ""
      if (envPass) {
        await setUserPassword(adminUser, envPass)
        await saveDb(db, envCtx)
      } else if (!adminPass) {
        // 未初始化：不再自動生成隨機密碼，交由 Web 安裝嚮導（POST /api/public/init/setup）完成。
        // 前端會在 /api/public/init_status 返回未初始化時自動跳轉到安裝嚮導。
        console.warn(
          "[SECURITY] Admin password is empty and no ADMIN_PASS is set — the system is NOT initialized. " +
            "Open the site in a browser to run the setup wizard, or set ADMIN_PASS to initialize automatically.",
        )
      } else {
        console.warn(
          "[SECURITY] Admin password uses a legacy hash format this build cannot verify; " +
            "it has been left untouched. Log in with your existing password and re-set it, " +
            "or set ADMIN_PASS to force a reset. It will NOT be reset to a default value.",
        )
      }
    }
  }
  return { db, users: db.users }
}

export async function authUserFromReq(
  c: any,
): Promise<{ db: any; user: any } | null> {
  const authHeader = c.req.header("Authorization")
  if (!authHeader) return null
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.substring(7)
    : authHeader
  try {
    const secret = await getJwtSecret(c)
    const payload = await verify(token, secret, "HS256")
    if (await isTokenRevoked(payload?.jti as string, c.env)) return null
    const db = await getDb(c.env)
    if (!db.users) db.users = []
    const user = db.users.find(
      (u: any) => u.id === payload.id || u.username === payload.username,
    )
    if (!user) return null
    return { db, user }
  } catch {
    return null
  }
}

async function checkUserOtp(matchedUser: any, body: any) {
  if (!matchedUser.otp_secret) {
    return { ok: true, code: 200, httpStatus: 200 as const, message: "ok" }
  }
  const otpCode = String(body.otp_code || body.code || "").trim()
  if (!otpCode) {
    return {
      ok: false,
      code: 402,
      httpStatus: 200 as const,
      message: "OTP code required",
    }
  }
  const valid = await verifyTotpCode(matchedUser.otp_secret, otpCode)
  if (!valid) {
    return {
      ok: false,
      code: 401,
      httpStatus: 401 as const,
      message: "Invalid OTP code",
    }
  }
  return { ok: true, code: 200, httpStatus: 200 as const, message: "ok" }
}

// POST /api/auth/login
authRouter.post("/login", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const username = (body.username || "").trim()
  const rawPassword = body.password || ""

  // 防爆破：IP+用戶名維度連續失敗鎖定（KV 共享 + 指數退避）
  if (await isLoginLocked(c, username, c.env)) {
    return c.json(
      {
        code: 429,
        message:
          "Too many failed login attempts for this account/IP. Please try again later.",
        data: null,
      },
      429,
    )
  }

  const { users, db } = await getOrInitUsers(c.env)

  const matchedUser = users.find(
    (u: any) => u.username === username && !u.disabled,
  )

  if (matchedUser) {
    // 明文登入：服務端先 StaticHash，再比對儲存哈希（相容單層/雙層/bcrypt 遺留）
    const isPasswordValid = await verifyUserPassword(matchedUser, rawPassword)

    if (isPasswordValid) {
      // 遺留格式（bcrypt / 無鹽單層 SHA256）登入成功後自動升級為 Go 雙層哈希
      const stored = String(matchedUser.password || "").trim()
      const needsMigrate =
        /^\$2[aby]\$/.test(stored) || (!matchedUser.salt && isHex64(stored))
      if (needsMigrate) {
        console.log(`[Auth] Upgrading password hash for user: ${username}`)
        await setUserPassword(matchedUser, rawPassword)
        await saveDb(db, c.env)
      }

      const otpCheck = await checkUserOtp(matchedUser, body)
      if (!otpCheck.ok) {
        return c.json(
          { code: otpCheck.code, message: otpCheck.message, data: null },
          otpCheck.httpStatus,
        )
      }
      await clearLoginFailures(c, username, c.env)

      // 生成 JWT Token
      const payload = {
        id: matchedUser.id,
        username: matchedUser.username,
        role: matchedUser.role,
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
        jti: generateJti(),
      }
      const secret = await getJwtSecret(c)
      const token = await sign(payload, secret)

      // 生成 CSRF Token
      const csrfToken = setCSRFToken(c)

      // 記錄審計日誌
      const auditLogger = getAuditLogger()
      await auditLogger.logLoginSuccess(c, username)

      return c.json({
        code: 200,
        message: "success",
        data: { token, csrf_token: csrfToken },
      })
    }
  }

  // 登入失敗 - 記錄審計日誌
  const auditLogger = getAuditLogger()
  await auditLogger.logLoginFailure(c, username, "Invalid credentials")

  await recordLoginFailure(c, username, c.env)
  return c.json({ code: 401, message: "Invalid credentials", data: null }, 401)
})

// POST /api/auth/login/hash
authRouter.post("/login/hash", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const username = (body.username || "").trim()
  const inputHash = String(body.password || "")
    .trim()
    .toLowerCase()

  // 防爆破：與 /login 同一計數體系（KV 共享 + 指數退避）
  if (await isLoginLocked(c, username, c.env)) {
    return c.json(
      {
        code: 429,
        message:
          "Too many failed login attempts for this account/IP. Please try again later.",
        data: null,
      },
      429,
    )
  }

  const { users, db } = await getOrInitUsers(c.env)

  const matchedUser = users.find(
    (u: any) => u.username === username && !u.disabled,
  )

  if (matchedUser && inputHash.length === 64) {
    const isHashValid = await verifyUserStaticHash(matchedUser, inputHash)

    if (isHashValid) {
      // 無鹽單層 SHA256 舊資料 -> 升級為 Go 雙層哈希（無需明文）
      if (!matchedUser.salt) {
        console.log(`[Auth] Upgrading password hash for user: ${username}`)
        matchedUser.salt = generateSalt()
        matchedUser.password = await saltedHash(inputHash, matchedUser.salt)
        matchedUser.pwd_update_at = new Date().toISOString()
        await saveDb(db, c.env)
      }

      const otpCheck = await checkUserOtp(matchedUser, body)
      if (!otpCheck.ok) {
        return c.json(
          { code: otpCheck.code, message: otpCheck.message, data: null },
          otpCheck.httpStatus,
        )
      }
      await clearLoginFailures(c, username, c.env)

      // 生成 JWT Token
      const payload = {
        id: matchedUser.id,
        username: matchedUser.username,
        role: matchedUser.role,
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
        jti: generateJti(),
      }
      const secret = await getJwtSecret(c)
      const token = await sign(payload, secret)

      // 生成 CSRF Token
      const csrfToken = setCSRFToken(c)

      // 記錄審計日誌
      const auditLogger = getAuditLogger()
      await auditLogger.logLoginSuccess(c, username)

      return c.json({
        code: 200,
        message: "success",
        data: { token, csrf_token: csrfToken },
      })
    }
  }

  // 登入失敗 - 記錄審計日誌
  const auditLogger = getAuditLogger()
  await auditLogger.logLoginFailure(c, username, "Invalid credentials")

  await recordLoginFailure(c, username, c.env)
  return c.json({ code: 401, message: "Invalid credentials", data: null }, 401)
})

// POST /api/me/update or /me/update
export const meUpdateHandler = async (c: any) => {
  const auth = await authUserFromReq(c)
  if (!auth) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const { db, user } = auth
  const body = await c.req.json().catch(() => ({}))

  if (body.username && body.username.trim() !== "") {
    const newUsername = body.username.trim()
    const exists = db.users.some(
      (u: any) => u.id !== user.id && u.username === newUsername,
    )
    if (exists) {
      return c.json(
        { code: 400, message: "Username already exists", data: null },
        400,
      )
    }
    user.username = newUsername
  }

  if (body.password && body.password.trim() !== "") {
    await setUserPassword(user, body.password.trim())
  }

  await saveDb(db, c.env)
  return c.json({ code: 200, message: "success", data: null })
}

// GET /api/me
export const meHandler = async (c: any) => {
  const user = await getUserFromContext(c)
  if (!user || user.disabled) {
    return c.json(
      {
        code: 401,
        message: "Unauthorized",
        data: null,
      },
      401,
    )
  }

  return c.json({
    code: 200,
    message: "success",
    data: {
      id: user.id,
      username: user.username,
      role: user.role,
      permission: user.permission ?? 0,
      base_path: user.base_path || "/",
      disabled: !!user.disabled,
      sso_id: user.sso_id || "",
      allow_ldap: !!user.allow_ldap,
      otp: !!user.otp_secret,
    },
  })
}

authRouter.get("/me", meHandler)
authRouter.post("/me/update", meUpdateHandler)

export const logoutHandler = async (c: any) => {
  // 真正失效 token：解析 Authorization 頭中的 JWT，將其 jti 加入註銷黑名單
  const authHeader = c.req.header("Authorization")
  if (authHeader) {
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.substring(7)
      : authHeader
    try {
      const secret = await getJwtSecret(c)
      const payload: any = await verify(token, secret, "HS256")
      if (payload?.jti) {
        await revokeToken(payload.jti, payload.exp, c.env)
      }
    } catch {
      // token 無效則無需註銷
    }
  }

  // 清除 CSRF Token
  clearCSRFToken(c)

  // 記錄審計日誌
  const auditLogger = getAuditLogger()
  await auditLogger.logLogout(c)

  return c.json({
    code: 200,
    message: "success",
    data: null,
  })
}

authRouter.get("/logout", logoutHandler)
authRouter.post("/logout", logoutHandler)

// GET /api/auth/csrf — 獲取 CSRF token（添加日期: 2026-09-05）
authRouter.get("/csrf", async (c) => {
  try {
    const token = await generateCSRFToken(c)
    return c.json({
      code: 200,
      message: "success",
      data: { csrf_token: token },
    })
  } catch (err: any) {
    return c.json(
      { code: 500, message: "Failed to generate CSRF token", data: null },
      500,
    )
  }
})

// POST /api/auth/2fa/generate — returns a fresh TOTP secret + QR image
authRouter.post("/2fa/generate", async (c) => {
  const auth = await authUserFromReq(c)
  if (!auth) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const { user } = auth
  if (user.otp_secret) {
    return c.json(
      { code: 400, message: "2FA already enabled", data: null },
      400,
    )
  }
  const secret = generateTotpSecret()
  const otpauth = buildOtpauthUrl(secret, user.username)
  const qr = await buildQrImageUrl(otpauth)
  return c.json({
    code: 200,
    message: "success",
    data: { qr, secret },
  })
})

// POST /api/auth/2fa/verify — validate a code against the generated secret,
// then persist it on the user so future logins require the TOTP code.
authRouter.post("/2fa/verify", async (c) => {
  const auth = await authUserFromReq(c)
  if (!auth) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const { db, user } = auth
  const body = await c.req.json().catch(() => ({}))
  const code = String(body.code || "").trim()
  const secret = String(body.secret || "").trim()
  if (!secret) {
    return c.json(
      { code: 400, message: "Missing secret parameter", data: null },
      400,
    )
  }
  if (!/^[A-Z2-7]+$/i.test(secret)) {
    return c.json(
      { code: 400, message: "Invalid secret format", data: null },
      400,
    )
  }
  const valid = await verifyTotpCode(secret, code)
  if (!valid) {
    return c.json({ code: 400, message: "Invalid code", data: null }, 400)
  }
  user.otp_secret = secret.toUpperCase()
  await saveDb(db, c.env)
  return c.json({ code: 200, message: "success", data: null })
})

// Current user SSH Key sub-routes (/api/me/sshkey/*)
meRouter.get("/sshkey/list", async (c) => {
  const auth = await authUserFromReq(c)
  if (!auth) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const keys = await listUserSshKeys(auth.user.id, c.env)
  return c.json({
    code: 200,
    message: "success",
    data: { content: keys, total: keys.length },
  })
})

meRouter.post("/sshkey/add", async (c) => {
  const auth = await authUserFromReq(c)
  if (!auth) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const body = await c.req.json().catch(() => ({}))
  try {
    const key = await addUserSshKey(
      auth.user.id,
      body.key || body.public_key || "",
      body.name || body.title || "",
      c.env,
    )
    return c.json({
      code: 200,
      message: "success",
      data: key,
    })
  } catch (err: any) {
    return c.json(
      {
        code: 400,
        message: err.message || "Failed to add SSH key",
        data: null,
      },
      400,
    )
  }
})

meRouter.post("/sshkey/delete", async (c) => {
  const auth = await authUserFromReq(c)
  if (!auth) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const id = c.req.query("id")
  if (!id) {
    return c.json(
      { code: 400, message: "Missing id parameter", data: null },
      400,
    )
  }
  const removed = await deleteUserSshKey(auth.user.id, id, c.env)
  if (!removed) {
    return c.json({ code: 404, message: "SSH key not found", data: null }, 404)
  }
  const keys = await listUserSshKeys(auth.user.id, c.env)
  return c.json({
    code: 200,
    message: "success",
    data: keys,
  })
})
