import { getDb } from "../internal/model/db"
import { getJwtSecret } from "../server/middlewares"
import { hmacSha256 } from "./crypto"
import { getEnableSign } from "../internal/driver/storageopts"

/**
 * 下載鏈接簽名（防盜鏈 / 鏈接過期）。
 *
 * 啟用條件（管理後台設置）：
 * - sign_all === "true"：所有下載鏈接簽發 HMAC 簽名；
 * - link_expiration > 0：鏈接有效期（**小時**，對齊 Go/官方文件），超期失效；
 *   為 0 表示**永不過期**（Go：`LinkExpiration == 0` → `sign.NotExpired`）。
 * 兩者都關閉時本模塊完全靜默（enabled=false），行為與未啟用完全一致。
 *
 * 簽名格式：`${expires}.${hmacSha256(virtualPath:expires, secret)}`；
 * `expires === 0` 表示永不過期，驗籤時不做超期判定（對齊 Go pkg/sign 的
 * `expires != 0` 分支）。secret 複用 getJwtSecret（env.JWT_SECRET → KV/D1
 * 持久化隨機 → 進程內隨機），與 JWT 同源但用途獨立，無需額外配置。
 *
 * 與 Go 的差異（有意保留，不影響判簽結果）：Go 用 `base64url(hmac) + ":" +
 * expire`，這裡用 `expire + "." + hex(hmac)`，兩種實現的簽名不互通。
 */

/** 恆定時間比較（十六進制字符串），避免 HMAC 驗籤被時序側信道攻擊（M-1） */
function constantTimeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

export interface SignPolicy {
  enabled: boolean
  /** 簽名有效期（**秒**）。0 表示永不過期（對齊 Go 的 expire == 0 語義）。 */
  expiresIn: number
}

export async function getSignPolicy(c: any): Promise<SignPolicy> {
  try {
    const db = await getDb(c?.env)
    const settings: Record<string, string> = {}
    for (const s of db.settings || []) settings[s.key] = s.value
    const signAll = settings.sign_all === "true"
    // link_expiration 的單位是**小時**：Go 用 time.Duration(expire)*time.Hour，
    // 官方文件（configuration/global.md）亦寫明 "in hours"，0 = 永不過期。
    const linkExpHours = parseInt(settings.link_expiration, 10) || 0
    if (!signAll && linkExpHours <= 0) {
      return { enabled: false, expiresIn: 0 }
    }
    return {
      enabled: true,
      expiresIn: linkExpHours > 0 ? linkExpHours * 3600 : 0,
    }
  } catch {
    return { enabled: false, expiresIn: 0 }
  }
}

/** 規範化路徑（對齊 Go utils.FixAndCleanPath） */
function fixAndCleanPath(p: string): string {
  return "/" + String(p || "").split("/").filter(Boolean).join("/")
}

/**
 * meta 是否覆蓋該路徑（對齊 Go server/common.MetaCoversPath）。
 * applyToSubFolder 為 false 時僅匹配自身，為 true 時向上匹配所有祖先。
 */
export function metaCoversPath(
  metaPath: string,
  reqPath: string,
  applyToSubFolder: boolean,
): boolean {
  const mp = fixAndCleanPath(metaPath).toLowerCase()
  let rp = fixAndCleanPath(reqPath).toLowerCase()
  if (mp === rp) return true
  if (!applyToSubFolder) return false
  while (rp !== "/") {
    rp = fixAndCleanPath(rp.split("/").slice(0, -1).join("/"))
    if (mp === rp) return true
  }
  return false
}

/**
 * 取距離該路徑最近的 meta（對齊 Go op.GetNearestMeta）：
 * 從自身逐級向上查找，返回首個存在的 meta。
 */
export async function getNearestMeta(
  c: any,
  reqPath: string,
): Promise<any | null> {
  try {
    const db = await getDb(c?.env)
    const metas = db.metas || []
    if (!metas.length) return null
    let p = fixAndCleanPath(reqPath)
    for (;;) {
      const hit = metas.find(
        (m: any) => fixAndCleanPath(m.path).toLowerCase() === p.toLowerCase(),
      )
      if (hit) return hit
      if (p === "/") return null
      p = fixAndCleanPath(p.split("/").slice(0, -1).join("/"))
    }
  } catch {
    return null
  }
}

/**
 * 該路徑所在儲存是否開啟了儲存級簽名（對齊 Go common.IsStorageSignEnabled）。
 *
 * Go 版通過 op.GetBalancedStorage(path) 由路徑反查儲存，再讀 EnableSign。
 * 這裡用 storage 層已有的 resolvePath 做同樣的解析，避免重複實現路徑匹配。
 */
export async function isStorageSignEnabled(
  c: any,
  reqPath: string,
): Promise<boolean> {
  try {
    const { resolvePath } = await import("../internal/model/db")
    const resolved = await resolvePath(reqPath)
    if (!resolved?.storage) return false
    return getEnableSign(resolved.storage)
  } catch {
    return false
  }
}

/**
 * 該路徑是否處於「密碼保護」狀態（對齊 Go server/handles.isEncrypt）。
 *
 * Go 的 isEncrypt 判定順序為：儲存級 EnableSign → meta 密碼 → 其餘 false。
 */
export async function isEncryptPath(
  c: any,
  reqPath: string,
): Promise<boolean> {
  // 對齊 Go：儲存級 EnableSign 優先於 meta 密碼分支
  if (await isStorageSignEnabled(c, reqPath)) return true
  const meta = await getNearestMeta(c, reqPath)
  if (!meta || !meta.password) return false
  return metaCoversPath(meta.path, reqPath, !!meta.p_sub)
}

/**
 * 下載是否必須攜帶簽名（對齊 Go server/middlewares.needSign）。
 *
 * Go 的 /d、/p 是「公開下載端點」，鏈路為
 *   PathParse → Down(sign.Verify) → downloadLimiter → handles.Down/Proxy
 * 全程沒有 Auth 中間件。是否放行僅取決於本函數：
 *   - sign_all 開啟              → 需要簽名
 *   - （TS 擴展）link_expiration → 需要簽名
 *   - meta 設了密碼且覆蓋該路徑  → 需要簽名
 *   - 否則                       → 無需簽名，直接公開訪問
 */
export async function needDownloadSign(
  c: any,
  reqPath: string,
): Promise<boolean> {
  const policy = await getSignPolicy(c)
  if (policy.enabled) return true
  return await isEncryptPath(c, reqPath)
}

/**
 * 簽名有效期（**秒**，0 = 永不過期）。
 *
 * link_expiration 以小時配置、為 0 時表示永不過期（對齊 Go sign.Sign 在
 * LinkExpiration == 0 時走 NotExpired）。meta 密碼保護路徑即使未開
 * sign_all/link_expiration 也需要簽發簽名，此時返回 0（永久），與 Go 一致。
 */
export async function getSignExpiresIn(c: any): Promise<number> {
  try {
    const db = await getDb(c?.env)
    for (const s of db.settings || []) {
      if (s.key === "link_expiration") {
        const hours = parseInt(s.value, 10) || 0
        if (hours > 0) return hours * 3600
        break
      }
    }
  } catch {}
  return 0
}

/**
 * 簽發下載簽名。
 *
 * `expiresIn === 0` 表示**永不過期**（對齊 Go sign.NotExpired 的 expire=0），
 * 傳負數仍會得到「已過期」的簽名（對齊 Go 傳負 duration 的行為）。
 */
export async function signDownloadPath(
  c: any,
  virtualPath: string,
  expiresIn: number,
): Promise<string> {
  const secret = await getJwtSecret(c)
  const expires =
    expiresIn === 0 ? 0 : Math.floor(Date.now() / 1000) + expiresIn
  const hmac = await hmacSha256(`${virtualPath}:${expires}`, secret)
  return `${expires}.${hmac}`
}

export async function verifyDownloadSign(
  c: any,
  virtualPath: string,
  sign: string,
): Promise<boolean> {
  const dot = sign.lastIndexOf(".")
  if (dot <= 0) return false
  const expires = parseInt(sign.slice(0, dot), 10)
  const hmac = sign.slice(dot + 1)
  if (!Number.isFinite(expires)) return false
  // expires === 0 表示永不過期（對齊 Go HMACSign.Verify 的 `expires != 0` 判定）
  if (expires !== 0 && expires <= Math.floor(Date.now() / 1000)) {
    return false
  }
  const secret = await getJwtSecret(c)
  const expect = await hmacSha256(`${virtualPath}:${expires}`, secret)
  return constantTimeEqualHex(expect, hmac)
}
