/**
 * KV 代理共享模塊
 *
 * EdgeOne Edge Functions 約定：
 * - 目錄 functions/<name>/index.js 自動生成路由 /<name>
 * - 以 `_` 開頭的文件為共享模塊，不生成路由
 * - KV 綁定名在運行時直接可用（官方示例做法，非 env.KV）
 *
 * 鑑權策略（三層）：
 *  1. 內部調用：X-Internal-Call 常量時間比對**完整**密鑰
 *     —— 用於 Node 雲函數（初始化、後台任務等無用戶 token 的場景）
 *  2. 用戶調用：真實校驗 HS256 JWT 簽名 + exp/nbf + 管理員角色
 *     —— 用於外部直接訪問 /kv-* 的請求
 *  3. 其餘一律 401
 *
 * JWT 密鑰來源與 Node 側保持一致：
 *  env.JWT_SECRET -> KV 中的 openlist_jwt_secret -> （都沒有則拒絕用戶調用）
 */

const JWT_SECRET_KV_KEY = "openlist_jwt_secret"
const ADMIN_ROLE = 2

/* ─────────────────────────── KV 綁定解析 ─────────────────────────── */

/**
 * 解析 KV 綁定。
 *
 * 綁定名固定為 `KV`。官方示例中綁定名是直接可用的全局標識符，
 * 這裡相容 env 掛載與全局兩種形態。
 */
export function resolveKv(env) {
  const v = env?.KV
  if (isKvLike(v)) return v
  const gv = globalThis?.KV
  if (isKvLike(gv)) return gv
  return null
}

function isKvLike(v) {
  return !!v && typeof v.get === "function" && typeof v.put === "function"
}

/* ─────────────────────────── 密鑰獲取 ─────────────────────────── */

/**
 * 獲取 JWT 密鑰，優先級與 Node 側 getJwtSecret 一致。
 *
 * **不快取**。KV 密鑰可能被 Node 側隨時寫入或輪換，任何形式的模塊級
 * 快取（哪怕帶 TTL）都會讓本實例在一段時間內持有舊值，導致
 * X-Internal-Call 鑑權失敗。env 讀取本身幾乎無開銷，KV 讀取僅在
 * 未配置 env 時發生，成本可接受。用最簡單的方式換取"永不失效"。
 *
 * @returns {Promise<string|null>}
 */
export async function getJwtSecret(env) {
  // 1) 環境變量（長度需 >= 16，與 Node 側一致）
  const envSecret = env?.JWT_SECRET || globalThis?.JWT_SECRET
  if (typeof envSecret === "string" && envSecret.length >= 16) {
    return envSecret
  }

  // 2) KV 持久化密鑰（與 Node 側共用 openlist_jwt_secret）
  try {
    const kv = resolveKv(env)
    if (kv) {
      const val = await kv.get(JWT_SECRET_KV_KEY, { type: "text" })
      if (typeof val === "string" && val.length >= 16) {
        return val
      }
    }
  } catch {
    // 讀取失敗則視為無密鑰
  }

  return null
}

/* ─────────────────────────── 鑑權 ─────────────────────────── */

/**
 * 常量時間字符串比較（防時序攻擊）
 */
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/* ── base64url 工具 ── */
function b64urlToBytes(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4))
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function b64urlToJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)))
}

function bytesToB64url(bytes) {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/**
 * 校驗 HS256 JWT：簽名 + exp + nbf。
 * @returns {Promise<object|null>} 校驗通過的 payload，失敗返回 null
 */
export async function verifyJwt(token, secret) {
  if (!secret) return null

  const parts = String(token).split(".")
  if (parts.length !== 3) return null

  const [headerB64, payloadB64, signB64] = parts

  // 1) 頭部算法必須為 HS256，拒絕 alg=none 等降級攻擊
  let header
  try {
    header = b64urlToJson(headerB64)
  } catch {
    return null
  }
  if (!header || header.alg !== "HS256") return null

  // 2) 驗籤
  let keyMat
  try {
    keyMat = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    )
  } catch {
    return null
  }

  let signature
  try {
    signature = b64urlToBytes(signB64)
  } catch {
    return null
  }

  let valid
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      keyMat,
      signature,
      new TextEncoder().encode(`${headerB64}.${payloadB64}`),
    )
  } catch {
    valid = false
  }
  if (!valid) return null

  // 3) 時間與角色校驗
  let payload
  try {
    payload = b64urlToJson(payloadB64)
  } catch {
    return null
  }
  if (!payload) return null

  const now = Math.floor(Date.now() / 1000)
  if (typeof payload.exp === "number" && now >= payload.exp) return null
  if (typeof payload.nbf === "number" && now < payload.nbf) return null

  return payload
}

/**
 * 統一鑑權入口
 *
 * @returns {Promise<{ok: boolean, mode: "internal"|"user"|"anonymous", reason?: string}>}
 */
export async function authorize(request, env) {
  /* ── 1) 內部調用（Node 雲函數） ── */
  const internal = request.headers.get("X-Internal-Call")
  if (internal) {
    const secret = await getJwtSecret(env)
    // 使用**完整密鑰**比對（不做截斷）。
    //
    // 歷史實現只比對前 16 個字符，導致熵從 256 bit 降到 64 bit，
    // 且內部通道會繞過後續的管理員角色校驗 —— 一旦猜中即可任意讀寫 KV。
    // 現在要求提交完整密鑰，熵與 JWT_SECRET 一致。
    if (secret && timingSafeEqual(internal, secret)) {
      return { ok: true, mode: "internal" }
    }
    // 帶了內部調用頭但不匹配：直接拒絕，不繼續嘗試用戶鑑權，
    // 避免用錯誤頭繞過後續邏輯
    return { ok: false, mode: "anonymous", reason: "invalid internal call" }
  }

  /* ── 2) 用戶調用（真實校驗 JWT） ── */
  const auth = request.headers.get("Authorization") || ""
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7)
    const secret = await getJwtSecret(env)

    if (!secret) {
      return {
        ok: false,
        mode: "anonymous",
        reason: "no JWT secret configured on edge",
      }
    }

    const payload = await verifyJwt(token, secret)
    if (!payload) {
      return { ok: false, mode: "anonymous", reason: "invalid token" }
    }

    // 管理員角色校驗：KV 為資料面，僅管理員可讀寫
    if (Number(payload.role) !== ADMIN_ROLE) {
      return { ok: false, mode: "user", reason: "admin role required" }
    }

    return { ok: true, mode: "user" }
  }

  return { ok: false, mode: "anonymous", reason: "no credentials" }
}

/* ─────────────────────────── 響應工具 ─────────────────────────── */

/** 統一 JSON 響應，禁止快取 */
export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  })
}

export function unauthorized(message = "Unauthorized") {
  return json({ error: message }, 401)
}

export function forbidden(message = "Forbidden") {
  return json({ error: message }, 403)
}

export function kvMissing() {
  return json(
    {
      error:
        "KV binding not available in Edge Function. " +
        "Check that the KV namespace is bound to Edge Functions (not Node Functions).",
    },
    503,
  )
}

/**
 * 根據鑑權結果返回合適的錯誤響應
 */
export function deny(auth) {
  if (auth.mode === "user") return forbidden(auth.reason || "Forbidden")
  return unauthorized(auth.reason || "Unauthorized")
}

// 供路由模塊複用的驗籤工具（導出以便測試）
export { b64urlToBytes, bytesToB64url, timingSafeEqual }
