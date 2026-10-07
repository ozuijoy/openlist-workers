/**
 * TOTP (Time-based One-Time Password) 雙因素認證模塊
 * 添加日期: 2026-09-05
 * 
 * 基於 RFC 6238 標準實現，支持 Google Authenticator、Microsoft Authenticator 等 TOTP 應用
 */

import { authenticator } from "otplib"
import QRCode from "qrcode"

/**
 * 生成 TOTP 密鑰和 QR 碼
 * @param username 用戶名
 * @param issuer 發行者名稱（應用名稱）
 * @returns { secret, qrcode } 密鑰和 QR 碼資料 URL
 */
export async function generateTOTPSecret(
  username: string,
  issuer: string = "OpenList",
): Promise<{ secret: string; qrcode: string; otpauth_url: string }> {
  // 生成 32 字符的 Base32 密鑰
  const secret = authenticator.generateSecret()

  // 生成 otpauth URL（標準格式）
  const otpauth_url = authenticator.keyuri(username, issuer, secret)

  // 生成 QR 碼（Data URL 格式，可直接在前端顯示）
  const qrcode = await QRCode.toDataURL(otpauth_url)

  return {
    secret,
    qrcode,
    otpauth_url,
  }
}

/**
 * 驗證 TOTP 令牌
 * @param token 用戶輸入的 6 位數字令牌
 * @param secret 用戶的 TOTP 密鑰
 * @returns 是否驗證成功
 */
export function verifyTOTPToken(token: string, secret: string): boolean {
  try {
    // 配置容錯窗口（允許前後 1 個時間窗口，即 ±30 秒）
    authenticator.options = {
      window: 1, // 允許時間偏移
    }

    return authenticator.verify({ token, secret })
  } catch (err) {
    console.error("[TOTP] Verification error:", err)
    return false
  }
}

/**
 * 生成當前 TOTP 令牌（用於測試）
 * @param secret TOTP 密鑰
 * @returns 6 位數字令牌
 */
export function generateTOTPToken(secret: string): string {
  return authenticator.generate(secret)
}

/**
 * 驗證 TOTP 密鑰格式
 * @param secret TOTP 密鑰
 * @returns 是否有效
 */
export function isValidTOTPSecret(secret: string): boolean {
  try {
    // Base32 密鑰應該只包含 A-Z 和 2-7
    const base32Regex = /^[A-Z2-7]+=*$/
    return base32Regex.test(secret) && secret.length >= 16
  } catch {
    return false
  }
}

/**
 * 批量驗證備用碼（用於緊急登入）
 * 備用碼應該由調用方生成並加密儲存
 */
export function generateBackupCodes(count: number = 10): string[] {
  if (!Number.isInteger(count) || count < 1 || count > 1000) {
    throw new Error("Backup code count must be an integer between 1 and 1000")
  }
  // 使用 CSPRNG 生成恢復碼，避免 Math.random 可預測導致 2FA 被繞過
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // 去除易混淆字符 I/O/0/1
  const bytes = new Uint8Array(count * 8)
  crypto.getRandomValues(bytes)

  const codes: string[] = []
  for (let i = 0; i < count; i++) {
    let code = ""
    for (let j = 0; j < 8; j++) {
      // 取模會有輕微偏置，但對 32 字符集、8 字節/碼的恢復碼場景可忽略；
      // 如需嚴格無偏可改為拒絕採樣。
      code += alphabet[bytes[i * 8 + j] % alphabet.length]
    }
    codes.push(`${code.slice(0, 4)}-${code.slice(4)}`)
  }
  return codes
}

/**
 * 驗證備用碼（調用方需要實現儲存和標記已使用）
 * @param inputCode 用戶輸入的備用碼
 * @param storedCodes 儲存的備用碼列表
 * @returns 是否匹配（調用方需要在匹配後標記為已使用）
 */
export function verifyBackupCode(
  inputCode: string,
  storedCodes: string[],
): boolean {
  const normalized = inputCode.trim().toUpperCase().replace(/\s/g, "")
  return storedCodes.some(
    (code) => code.toUpperCase().replace(/\s/g, "") === normalized,
  )
}

// ============ 相容舊代碼的函數別名 ============

/**
 * 生成 TOTP 密鑰（相容舊代碼）
 * @returns Base32 密鑰字符串
 */
export function generateTotpSecret(): string {
  return authenticator.generateSecret()
}

/**
 * 生成當前 TOTP 令牌（相容舊代碼）
 * @param secret TOTP 密鑰
 * @returns 6 位數字令牌
 */
export function generateTotpCode(secret: string): string {
  return authenticator.generate(secret)
}

/**
 * 驗證 TOTP 令牌（相容舊代碼）
 * @param secret TOTP 密鑰
 * @param code 用戶輸入的令牌
 * @returns 是否驗證成功
 */
export async function verifyTotpCode(secret: string, code: string): Promise<boolean> {
  return verifyTOTPToken(code, secret)
}

/**
 * 構建 otpauth URL（相容舊代碼）
 * @param secret TOTP 密鑰
 * @param username 用戶名
 * @param issuer 發行者名稱
 * @returns otpauth:// URL
 */
export function buildOtpauthUrl(
  secret: string,
  username: string,
  issuer: string = "OpenList",
): string {
  return authenticator.keyuri(username, issuer, secret)
}

/**
 * 構建 QR 碼圖片 URL（相容舊代碼）
 * @param otpauthUrl otpauth:// URL
 * @returns Data URL 格式的 QR 碼
 */
export async function buildQrImageUrl(otpauthUrl: string): Promise<string> {
  return QRCode.toDataURL(otpauthUrl)
}
