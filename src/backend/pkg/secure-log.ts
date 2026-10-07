/**
 * 安全日誌工具 - 自動脫敏敏感信息
 * 
 * 使用方法：
 * import { secureLog, secureWarn, secureError } from './secure-log'
 * secureLog('User data:', userData)  // 自動脫敏 password、token 等欄位
 * 
 * 2026-09-08 創建
 */

/** 需要脫敏的敏感欄位名（不區分大小寫） */
const SENSITIVE_KEYS = new Set([
  "password",
  "pwd",
  "passwd",
  "token",
  "secret",
  "key",
  "authorization",
  "auth",
  "api_key",
  "apikey",
  "access_token",
  "refresh_token",
  "session",
  "cookie",
  "csrf",
  "otp",
  "private",
  "credential",
  "salt",
  "hash",
])

/** 需要部分脫敏的欄位（顯示前幾位） */
const PARTIAL_MASK_KEYS = new Set([
  "email",
  "phone",
  "mobile",
  "telephone",
  "username",
  "userid",
  "user_id",
])

/**
 * 檢查欄位名是否為敏感欄位
 */
function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase()
  return (
    SENSITIVE_KEYS.has(lower) ||
    Array.from(SENSITIVE_KEYS).some((k) => lower.includes(k))
  )
}

/**
 * 檢查欄位名是否需要部分脫敏
 */
function isPartialMaskKey(key: string): boolean {
  const lower = key.toLowerCase()
  return PARTIAL_MASK_KEYS.has(lower)
}

/**
 * 部分脫敏（保留前3位，其餘用*代替）
 */
function partialMask(value: string): string {
  if (value.length <= 3) return "***"
  return value.slice(0, 3) + "*".repeat(Math.min(value.length - 3, 10))
}

/**
 * 遞歸脫敏對象/數組中的敏感信息
 */
function sanitize(obj: any, depth = 0): any {
  // 防止循環引用導致的無限遞歸
  if (depth > 10) return "[Max Depth]"

  // null/undefined 直接返回
  if (obj === null || obj === undefined) return obj

  // 字符串檢查（避免在日誌中輸出長 token）
  if (typeof obj === "string") {
    if (obj.length > 200) {
      return obj.slice(0, 200) + "... [truncated]"
    }
    // 檢測類似 JWT 的字符串（格式：xxxxx.xxxxx.xxxxx）
    if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(obj)) {
      return "[JWT_TOKEN]"
    }
    // 檢測類似 API key 的長隨機字符串
    if (/^[A-Za-z0-9_-]{32,}$/.test(obj)) {
      return "[API_KEY]"
    }
    return obj
  }

  // 數字/布爾值直接返回
  if (typeof obj === "number" || typeof obj === "boolean") return obj

  // 函數不輸出
  if (typeof obj === "function") return "[Function]"

  // 數組遞歸處理
  if (Array.isArray(obj)) {
    return obj.map((item) => sanitize(item, depth + 1))
  }

  // 對象遞歸處理
  if (typeof obj === "object") {
    const copy: any = {}
    for (const key of Object.keys(obj)) {
      if (isSensitiveKey(key)) {
        copy[key] = "[REDACTED]"
      } else if (isPartialMaskKey(key) && typeof obj[key] === "string") {
        copy[key] = partialMask(obj[key])
      } else {
        copy[key] = sanitize(obj[key], depth + 1)
      }
    }
    return copy
  }

  return obj
}

/**
 * 脫敏後輸出日誌（info 級別）
 */
export function secureLog(...args: any[]): void {
  console.log(...args.map((arg) => sanitize(arg)))
}

/**
 * 脫敏後輸出警告日誌
 */
export function secureWarn(...args: any[]): void {
  console.warn(...args.map((arg) => sanitize(arg)))
}

/**
 * 脫敏後輸出錯誤日誌
 */
export function secureError(...args: any[]): void {
  console.error(...args.map((arg) => sanitize(arg)))
}

/**
 * 直接對資料進行脫敏（不輸出日誌）
 */
export function sanitizeData<T = any>(data: T): T {
  return sanitize(data) as T
}
