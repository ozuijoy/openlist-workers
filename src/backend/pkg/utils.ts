import { Context } from "hono"
import { getDb } from "../internal/model/db"

/**
 * Common utilities for OpenList backend services.
 */

export * from "./xml"
export * from "./path"
export * from "./errs"
export * from "./generic"
export * from "./http"
export * from "./crypto"
export * from "./stream"

// Format byte sizes to human-readable strings
export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return "0 Bytes"
  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i]
}

// Check administrator authorization from context
export async function checkAdminAuth(c: Context): Promise<boolean> {
  // 靜態 API token（settings.token）
  if (await isStaticApiToken(c)) return true

  const authHeader = c.req.header("Authorization")
  if (!authHeader) return false
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.substring(7)
    : authHeader

  // JWT：管理員登入用戶也視為管理員（登入用戶變管理員判定）
  try {
    const { verify } = await import("hono/jwt")
    const { getJwtSecret } = await import("../server/middlewares")
    const secret = await getJwtSecret(c)
    const payload: any = await verify(token, secret, "HS256")
    if (payload && payload.role === 2) {
      // 確認該用戶存在於 DB 且未被禁用
      const db = await getDb(c.env)
      const user = (db.users || []).find(
        (u: any) => u.id === payload.id || u.username === payload.username,
      )
      return !!(user && !user.disabled)
    }
  } catch {}
  return false
}

/**
 * 僅判斷請求是否攜帶匹配的靜態 API token（settings.token）。
 * 與 checkAdminAuth 不同：不含 JWT 判定，供身份解析（getUserFromContext）
 * 區分「靜態 token 調用方」與「登入用戶」，避免 JWT 管理員被誤判為 api-token。
 */
export async function isStaticApiToken(c: Context): Promise<boolean> {
  const authHeader = c.req.header("Authorization")
  if (!authHeader) return false
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.substring(7)
    : authHeader
  const db = await getDb(c.env)
  const tokenSetting = db.settings.find((s: any) => s.key === "token")
  if (!tokenSetting || !tokenSetting.value) return false
  const tokenBytes = new TextEncoder().encode(token)
  const expectedBytes = new TextEncoder().encode(String(tokenSetting.value))
  if (tokenBytes.length !== expectedBytes.length) return false
  let match = 0
  for (let i = 0; i < tokenBytes.length; i++) {
    match |= tokenBytes[i] ^ expectedBytes[i]
  }
  return match === 0
}
