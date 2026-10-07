/**
 * Crypto utilities for OpenList.
 * Uses Web Crypto API (crypto.subtle + crypto.getRandomValues) —
 * compatible with Cloudflare Workers and Node.js 18+.
 * All functions are async.
 *
 * 例外：`chacha20-poly1305` 與 `des/3des` 這兩類**WebCrypto 不提供**的算法，
 * 分別由 `./chacha20`（自帶 RFC 8439 實現）與 `./legacy-ciphers`（crypto-js）
 * 提供，詳見文件末尾的 DB_CIPHER 說明。
 */
import { chacha20Poly1305Open, chacha20Poly1305Seal } from "./chacha20"
import { desCbcDecrypt, desCbcEncrypt } from "./legacy-ciphers"

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hexEncode(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

function toBytes(data: string | Uint8Array): any {
  if (typeof data === "string") return new TextEncoder().encode(data)
  return data
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

// ─── MD5 (pure-JS, SubtleCrypto does not support MD5) ───────────────────────

function md5Sync(input: string | Uint8Array): string {
  // RFC 1321 pure-JS MD5 — minimal implementation
  const msg =
    typeof input === "string" ? new TextEncoder().encode(input) : input
  const msgLen = msg.length
  const bitLen = msgLen * 8

  // Pre-processing: padding
  const padLen = (56 - ((msgLen + 1) % 64) + 64) % 64
  const padded = new Uint8Array(msgLen + 1 + padLen + 8)
  padded.set(msg)
  padded[msgLen] = 0x80
  const dv = new DataView(padded.buffer)
  dv.setUint32(padded.length - 8, bitLen >>> 0, true)
  dv.setUint32(padded.length - 4, Math.floor(bitLen / 0x100000000), true)

  const T = new Int32Array(64)
  for (let i = 0; i < 64; i++)
    T[i] = (Math.abs(Math.sin(i + 1)) * 0x100000000) | 0

  const r = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
    9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
    16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10,
    15, 21,
  ]

  let a0 = 0x67452301,
    b0 = 0xefcdab89,
    c0 = 0x98badcfe,
    d0 = 0x10325476

  for (let i = 0; i < padded.length; i += 64) {
    const chunk = new DataView(padded.buffer, i, 64)
    const M = Array.from({ length: 16 }, (_, j) => chunk.getInt32(j * 4, true))
    let [A, B, C, D] = [a0, b0, c0, d0]

    for (let j = 0; j < 64; j++) {
      let F: number, g: number
      if (j < 16) {
        F = (B & C) | (~B & D)
        g = j
      } else if (j < 32) {
        F = (D & B) | (~D & C)
        g = (5 * j + 1) % 16
      } else if (j < 48) {
        F = B ^ C ^ D
        g = (3 * j + 5) % 16
      } else {
        F = C ^ (B | ~D)
        g = (7 * j) % 16
      }
      const tmp = D
      D = C
      C = B
      const sum = (A + F + T[j] + M[g]) | 0
      B = (B + ((sum << r[j]) | (sum >>> (32 - r[j])))) | 0
      A = tmp
    }
    a0 = (a0 + A) | 0
    b0 = (b0 + B) | 0
    c0 = (c0 + C) | 0
    d0 = (d0 + D) | 0
  }

  const result = new DataView(new ArrayBuffer(16))
  result.setInt32(0, a0, true)
  result.setInt32(4, b0, true)
  result.setInt32(8, c0, true)
  result.setInt32(12, d0, true)
  return hexEncode(result.buffer)
}

export function md5(data: string | Uint8Array): string {
  return md5Sync(data)
}

// ─── SHA-1 / SHA-256 / HMAC-SHA-256 ─────────────────────────────────────────

export async function sha1(data: string | Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", toBytes(data))
  return hexEncode(buf)
}

export async function sha256(data: string | Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", toBytes(data))
  return hexEncode(buf)
}

export async function hmacSha256(
  data: string | Uint8Array,
  key: string,
): Promise<string> {
  const keyMat = await crypto.subtle.importKey(
    "raw",
    toBytes(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", keyMat, toBytes(data))
  return hexEncode(sig)
}

/** HMAC-SHA1（base64 輸出，阿里雲 OSS V1 簽名使用） */
export async function hmacSha1Base64(
  data: string,
  key: string,
): Promise<string> {
  const keyMat = await crypto.subtle.importKey(
    "raw",
    toBytes(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", keyMat, toBytes(data))
  const bytes = new Uint8Array(sig)
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

// ─── AES-256-GCM helpers ─────────────────────────────────────────────────────

const PBKDF2_ITERATIONS = 100000

// 僅提示一次的 legacy 弱 KDF 告警標記（M-4）
let legacyKdfWarned = false

async function deriveKey(
  password: string,
  salt: Uint8Array | string = "salt",
  iterations = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const enc = toBytes(password)
  const saltBytes = toBytes(salt)
  const keyMat = await crypto.subtle.importKey("raw", enc, "PBKDF2", false, [
    "deriveKey",
  ])
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
    keyMat,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  )
}

/**
 * Encrypt data with AES-256-GCM.
 * Returns "<saltHex>:<ivHex>:<ciphertextHex>" (authTag is appended by SubtleCrypto).
 */
export async function encrypt(data: string, key: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ck = await deriveKey(key, salt, PBKDF2_ITERATIONS)
  const cipherBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    ck,
    toBytes(data),
  )
  return `${hexEncode(salt.buffer)}:${hexEncode(iv.buffer)}:${hexEncode(cipherBuf)}`
}

/**
 * Decrypt data encrypted by `encrypt()`.
 * Supports both new format (<saltHex>:<ivHex>:<cipherHex>) and legacy format (<ivHex>:<cipherHex>).
 */
export async function decrypt(
  encryptedData: string,
  key: string,
): Promise<string> {
  const parts = encryptedData.split(":")
  let salt: Uint8Array | string = "salt"
  let ivHex = ""
  let cipherHex = ""
  let iterations = 1

  if (parts.length === 3) {
    // New secure format: salt:iv:ciphertext
    salt = fromHex(parts[0])
    ivHex = parts[1]
    cipherHex = parts[2]
    iterations = PBKDF2_ITERATIONS
  } else if (parts.length === 2) {
    // Legacy format compatibility: iv:ciphertext (1 iteration, static "salt")
    ivHex = parts[0]
    cipherHex = parts[1]
    iterations = 1
    if (!legacyKdfWarned) {
      legacyKdfWarned = true
      console.warn(
        "[Crypto] Decrypting legacy weak-KDF format. It will be re-encrypted " +
          "with the current config format on the next save.",
      )
    }
  } else {
    throw new Error("Invalid encrypted data format")
  }

  const iv = fromHex(ivHex)
  const cipherBuf = fromHex(cipherHex)
  const ck = await deriveKey(key, salt, iterations)
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as any },
    ck,
    cipherBuf as any,
  )
  return new TextDecoder().decode(plainBuf)
}

// ─── Low-CPU config encryption helpers ──────────────────────────────────────

/**
 * Derive the AES key used by the versioned config-encryption envelope.
 *
 * Config encryption is keyed by JWT_SECRET or by a randomly generated secret
 * persisted during setup. Running a password-strengthening KDF separately for
 * every encrypted field made a single config load exceed the CPU allowance of
 * Cloudflare Workers. HKDF keeps this key independent from other JWT_SECRET
 * uses while allowing all fields in one load or save to reuse one CryptoKey.
 *
 * The legacy PBKDF2 envelope remains supported by decrypt() above. Callers can
 * therefore migrate existing values when they next persist the config.
 */
export async function deriveConfigEncryptionKey(
  secret: string,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    toBytes(secret),
    "HKDF",
    false,
    ["deriveKey"],
  )
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toBytes("openlist-config-encryption-v2"),
      info: toBytes("AES-256-GCM"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  )
}

/** Encrypt one config field with an already-derived AES key. */
export async function encryptConfigValue(
  data: string,
  key: CryptoKey,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipherBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    toBytes(data),
  )
  return `${hexEncode(iv.buffer)}:${hexEncode(cipherBuf)}`
}

/** Decrypt one config field encrypted by encryptConfigValue(). */
export async function decryptConfigValue(
  encryptedData: string,
  key: CryptoKey,
): Promise<string> {
  const parts = encryptedData.split(":")
  if (parts.length !== 2) {
    throw new Error("Invalid config encrypted data format")
  }
  const iv = fromHex(parts[0])
  const cipherBuf = fromHex(parts[1])
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as any },
    key,
    cipherBuf as any,
  )
  return new TextDecoder().decode(plainBuf)
}

/** Generate a random hex string of given length */
export function randomString(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(length / 2)))
  return hexEncode(bytes.buffer).slice(0, length)
}

/**
 * AES-CBC + PKCS7 encrypt, returns base64.
 * Used by chaoxing login (key = "u2oh6Vu^HWe4_AES", IV = key).
 * Web Crypto supports AES-CBC with 128/192/256-bit keys.
 *
 * NOTE: the standard WebCrypto (Cloudflare Workers, browsers) does NOT apply
 * PKCS#7 padding automatically — non-block-aligned input throws. Node's
 * `crypto.subtle` (undici/webcrypto) DOES auto-pad. To behave identically in
 * both runtimes, we pad manually only outside Node.
 */
export async function aesCbcEncryptBase64(
  plaintext: string,
  key: string,
  iv?: string,
): Promise<string> {
  const keyBytes = toBytes(key)
  const ivBytes = iv ? toBytes(iv) : keyBytes
  const keyMat = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-CBC" },
    false,
    ["encrypt"],
  )
  const pt = toBytes(plaintext) as Uint8Array
  const isNode =
    typeof process !== "undefined" && process?.release?.name === "node"
  const data = isNode ? pt : pkcs7Pad(pt)
  const cipherBuf = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: ivBytes as any },
    keyMat,
    data as any,
  )
  const bytes = new Uint8Array(cipherBuf)
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

// ─── 靜態加密算法選擇（DB_CIPHER）───────────────────────────────────────────
//
// 設計要點：
//
// 1. **算法由環境變量選擇，歷史密文由前綴識別**。寫入時按所選算法加版本前綴
//    （`enc:v1:` ~ `enc:v6:`），讀取時只看前綴、完全不依賴當前配置，
//    因此「換算法」「關掉加密」都不會讓既有密文變成亂碼 —— 舊密文會在本次讀取時
//    按舊算法解開，並在下一次寫入時按新算法（或明文）重新落盤。
//
// 2. `none` 是默認值：不加密直接落盤。
//
// 3. 所有算法都基於同一把密鑰（JWT_SECRET / 持久化的共享密鑰）：
//
//    | 前綴      | DB_CIPHER               | 實現                                     |
//    |-----------|-------------------------|------------------------------------------|
//    | enc:v1:   | aes-256-gcm-pbkdf2      | PBKDF2-SHA256(10 萬次) 逐欄位派生（歷史） |
//    | enc:v2:   | aes-256-gcm             | HKDF-SHA256 派生一把 AES key（#69，推薦）|
//    | enc:v3:   | aes-256-cbc-hmac        | AES-256-CBC + HMAC-SHA256（EtM）          |
//    | enc:v4:   | chacha20-poly1305       | ChaCha20-Poly1305（RFC 8439，純 JS）      |
//    | enc:v5:   | des-cbc-hmac            | 單 DES-CBC + HMAC-SHA256（僅相容，不安全）|
//    | enc:v6:   | 3des-cbc-hmac           | 3DES-CBC + HMAC-SHA256（僅相容，已棄用）  |
//
//    說明：WebCrypto（CF Workers / 瀏覽器 / Node）**沒有** ChaCha20 與 DES/3DES，
//    且本倉庫邊緣構建會把 `node:crypto` 換成拋錯 shim（`scripts/node-shim.mjs`），
//    因此 v4 為自帶純 JS 實現，v5/v6 複用已有依賴 crypto-js（詳見 chacha20.ts /
//    legacy-ciphers.ts 中的安全說明）。
//
// 4. v3 採用「長度前綴」包裹明文：WebCrypto 的 AES-CBC 在部分運行時（Node 的
//    OpenSSL 後端）會自動做/去 PKCS#7 padding，而 CF Workers/瀏覽器不會。
//    把真實長度寫進密文頭部（4 字節大端），解密後只取該長度即可，從而在任何
//    運行時都得到一致結果（多餘 padding 與額外整塊 padding 都會被忽略）。
//
// 5. **密鑰派生結果在進程內快取**（見 cachedDerive）：同一 (算法, 密鑰) 只派生
//    一次，後續讀/寫直接複用 —— #69 的「每次操作派生一次」在此進一步降為
//    「每個 isolate 派生一次」。這是純 memoization，不改變任何密文內容。

export type DbCipher =
  | "none"
  | "aes-256-gcm"
  | "aes-256-gcm-pbkdf2"
  | "aes-256-cbc-hmac"
  | "chacha20-poly1305"
  | "des-cbc-hmac"
  | "3des-cbc-hmac"

/** DB_CIPHER 的默認值：不加密（向後相容「明文落盤」的既有部署） */
export const DEFAULT_DB_CIPHER: DbCipher = "none"

/** 可選算法（文件與錯誤提示用，順序即推薦順序） */
export const DB_CIPHER_VALUES: DbCipher[] = [
  "none",
  "aes-256-gcm",
  "aes-256-gcm-pbkdf2",
  "aes-256-cbc-hmac",
  "chacha20-poly1305",
  "des-cbc-hmac",
  "3des-cbc-hmac",
]

/**
 * 不推薦用於真實資料的算法（僅相容/測試用途）。
 *
 * 選用它們時會打印**一次性告警**：DES 有效密鑰只有 56-bit（可暴力破解）、
 * 3DES 已被 NIST SP 800-131A 棄用（64-bit 分組 + Sweet32）。實現完整性保護
 * （Encrypt-then-MAC）不代表密鑰強度足夠。
 */
export const WEAK_DB_CIPHERS: DbCipher[] = ["des-cbc-hmac", "3des-cbc-hmac"]

/**
 * 別名映射（全部小寫、去空白後匹配）。
 *
 * 允許別名是為了讓 `DB_CIPHER=AES-256-GCM`、`chacha20`、`v4` 這類習慣寫法都能工作，
 * 避免用戶因為大小寫或短名不同而靜默退回 `none`（那會讓「以為開了加密」的部署
 * 實際明文落盤）。
 */
const DB_CIPHER_ALIASES: Record<string, DbCipher> = {
  none: "none",
  off: "none",
  no: "none",
  plain: "none",
  plaintext: "none",
  "aes-256-gcm": "aes-256-gcm",
  "aes-gcm": "aes-256-gcm",
  aesgcm: "aes-256-gcm",
  "aes-256-gcm-hkdf": "aes-256-gcm",
  "gcm-hkdf": "aes-256-gcm",
  hkdf: "aes-256-gcm",
  gcm: "aes-256-gcm",
  v2: "aes-256-gcm",
  "aes-256-gcm-pbkdf2": "aes-256-gcm-pbkdf2",
  "aes-gcm-pbkdf2": "aes-256-gcm-pbkdf2",
  pbkdf2: "aes-256-gcm-pbkdf2",
  legacy: "aes-256-gcm-pbkdf2",
  v1: "aes-256-gcm-pbkdf2",
  "aes-256-cbc-hmac": "aes-256-cbc-hmac",
  "aes-cbc-hmac": "aes-256-cbc-hmac",
  "cbc-hmac": "aes-256-cbc-hmac",
  "aes-256-cbc": "aes-256-cbc-hmac",
  cbc: "aes-256-cbc-hmac",
  v3: "aes-256-cbc-hmac",
  "chacha20-poly1305": "chacha20-poly1305",
  chacha20: "chacha20-poly1305",
  chacha: "chacha20-poly1305",
  "chacha20-ietf-poly1305": "chacha20-poly1305",
  "aead-chacha20": "chacha20-poly1305",
  v4: "chacha20-poly1305",
  "des-cbc-hmac": "des-cbc-hmac",
  "des-cbc": "des-cbc-hmac",
  des: "des-cbc-hmac",
  v5: "des-cbc-hmac",
  "3des-cbc-hmac": "3des-cbc-hmac",
  "3des-cbc": "3des-cbc-hmac",
  "3des": "3des-cbc-hmac",
  des3: "3des-cbc-hmac",
  tripledes: "3des-cbc-hmac",
  "triple-des": "3des-cbc-hmac",
  v6: "3des-cbc-hmac",
}

/**
 * 解析 DB_CIPHER 取值。
 *
 * @returns `known=false` 表示取值無法識別（調用方應告警，但仍拿到安全默認值 `none`，
 *          絕不因為拼錯變量而悄悄啟用一把誰也不知道的算法）
 */
export function resolveDbCipher(raw: unknown): {
  cipher: DbCipher
  known: boolean
} {
  const key = String(raw ?? "")
    .trim()
    .toLowerCase()
  if (!key) return { cipher: DEFAULT_DB_CIPHER, known: true }
  const hit = DB_CIPHER_ALIASES[key]
  if (hit) return { cipher: hit, known: true }
  return { cipher: DEFAULT_DB_CIPHER, known: false }
}

/** 算法 → 密文版本號（前綴中的數字） */
const CIPHER_VERSION: Record<Exclude<DbCipher, "none">, number> = {
  "aes-256-gcm-pbkdf2": 1,
  "aes-256-gcm": 2,
  "aes-256-cbc-hmac": 3,
  "chacha20-poly1305": 4,
  "des-cbc-hmac": 5,
  "3des-cbc-hmac": 6,
}

/** 密文版本號 → 算法 */
const VERSION_CIPHER: Record<number, Exclude<DbCipher, "none">> = {
  1: "aes-256-gcm-pbkdf2",
  2: "aes-256-gcm",
  3: "aes-256-cbc-hmac",
  4: "chacha20-poly1305",
  5: "des-cbc-hmac",
  6: "3des-cbc-hmac",
}

/** 密文前綴正則：`enc:v<數字>:` */
const CIPHER_PREFIX_RE = /^enc:v(\d+):/

/** 算法對應的密文前綴（`none` 無前綴） */
export function cipherPrefix(cipher: DbCipher): string {
  if (cipher === "none") return ""
  return `enc:v${CIPHER_VERSION[cipher]}:`
}

/**
 * 識別密文前綴。**只看前綴，不看當前配置** —— 這是「換算法/關加密不丟資料」的關鍵。
 *
 * @returns 命中的算法與前綴（調用方用 `prefix.length` 切出密文主體）；明文返回 null
 */
export function detectCipherPrefix(
  value: unknown,
): { cipher: Exclude<DbCipher, "none">; prefix: string } | null {
  if (typeof value !== "string") return null
  const m = CIPHER_PREFIX_RE.exec(value)
  if (!m) return null
  const cipher = VERSION_CIPHER[Number(m[1])]
  if (!cipher) return null
  return { cipher, prefix: m[0] }
}

/** 該值是否為本模塊產生的密文（任意版本） */
export function isSealedCiphertext(value: unknown): boolean {
  return detectCipherPrefix(value) !== null
}

// ── v3：AES-256-CBC + HMAC-SHA256（Encrypt-then-MAC）────────────────────────

const V3_ENC_INFO = "openlist-db-cipher-v3-enc"
const V3_MAC_INFO = "openlist-db-cipher-v3-mac"

function bytesToHex(bytes: Uint8Array): string {
  let out = ""
  for (const b of bytes) out += b.toString(16).padStart(2, "0")
  return out
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/** 定長（時間無關）比較：用於校驗 HMAC，避免比較短路洩露信息。 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

// ── 密鑰派生快取（性能：每次讀/寫不再重複派生）────────────────────────────
//
// #69 已經把「逐欄位派生」降為「每次 save/load 派生一次」；這裡再進一步：
// 同一 (算法, 密鑰) 在**進程/isolate 內只派生一次**，後續所有讀寫直接複用。
//
// 為什麼安全：`cachedDerive` 是純 memoization —— 輸入相同則輸出必然相同，
// 不改變任何密文/明文，也不改變密鑰來源與優先級；快取鍵包含密鑰本身，
// 因此密鑰輪換（或 env 變更）會自動 miss 並生成新條目。
//
// 容量：只保留最近 KEY_CACHE_LIMIT 條（正常情況下 1~2 條），密鑰輪換時
// 舊的派生結果被淘汰，記憶體不會無限增長。

const KEY_CACHE_LIMIT = 8
const keyDerivationCache = new Map<string, unknown>()

async function cachedDerive<T>(
  id: string,
  secret: string,
  factory: () => Promise<T>,
): Promise<T> {
  const cacheId = `${id}\u0000${secret}`
  if (keyDerivationCache.has(cacheId)) {
    return keyDerivationCache.get(cacheId) as T
  }
  // 先 await 再入快取：派生失敗（如 WebCrypto 異常）不會被快取，
  // 避免一次瞬時故障被固化成「該密鑰永久不可用」。
  const value = await factory()
  if (keyDerivationCache.size >= KEY_CACHE_LIMIT) {
    const oldest = keyDerivationCache.keys().next().value
    if (oldest !== undefined) keyDerivationCache.delete(oldest)
  }
  keyDerivationCache.set(cacheId, value)
  return value
}

/** 僅供測試：清空密鑰派生快取（與 db.ts 的 __resetDbCacheForTest 聯動）。 */
export function __resetCipherKeyCacheForTest(): void {
  keyDerivationCache.clear()
  weakCipherWarned = false
}

/** 單次告警：選用了弱算法（DES/3DES） */
let weakCipherWarned = false

/** SHA-256 摘要（字節） */
async function sha256Bytes(input: string | Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", toBytes(input))
  return new Uint8Array(buf)
}

/**
 * 由共享密鑰派生 `length` 字節的密鑰材料（SHA-256）。
 *
 * 前提：共享密鑰本身足夠隨機（`openssl rand -hex 32` 或 setup 生成的 64 位 hex）。
 * 因此這裡不做 KDF 拉伸（PBKDF2 的 10 萬次迭代代價太高，見 v1 的歷史包袱）；
 * 若密鑰是低熵口令，請使用 `aes-256-gcm-pbkdf2`。
 */
async function deriveKeyBytes(
  secret: string,
  info: string,
  length: number,
): Promise<Uint8Array> {
  const digest = await sha256Bytes(`${info}|${secret}`)
  return digest.slice(0, length)
}

/** 導入 HMAC-SHA256 簽名密鑰 */
async function importHmacKey(bytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    bytes as any,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
}

/** HMAC-SHA256 簽名（返回 32 字節） */
async function hmacSha256Sign(
  key: CryptoKey,
  data: Uint8Array,
): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data as any))
}

/** 明文包裹：4 字節大端長度 + 原文（用於解密後精確切出原文，見上方說明 4） */
function wrapWithLength(bytes: Uint8Array): Uint8Array {
  const head = new Uint8Array(4)
  new DataView(head.buffer).setUint32(0, bytes.length, false)
  return concatBytes(head, bytes)
}

function unwrapWithLength(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4) throw new Error("Invalid encrypted data format")
  const len = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false)
  if (len > bytes.length - 4) throw new Error("Invalid encrypted data length")
  return bytes.slice(4, 4 + len)
}

/** SHA-256 派生一把 AES-CBC 密鑰（v3 用；與 encrypt/decrypt 的 PBKDF2 無關） */
async function deriveSha256AesCbcKey(secret: string, info: string) {
  const digest = await crypto.subtle.digest("SHA-256", toBytes(`${info}|${secret}`))
  return crypto.subtle.importKey("raw", digest, { name: "AES-CBC" }, false, [
    "encrypt",
    "decrypt",
  ])
}

async function hmacSha256RawKey(secret: string, info: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", toBytes(`${info}|${secret}`))
  return crypto.subtle.importKey(
    "raw",
    digest,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
}

interface V3Keys {
  enc: CryptoKey
  mac: CryptoKey
}

async function aesCbcHmacEncrypt(
  data: string,
  keys: V3Keys,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(16))
  const padded = pkcs7Pad(wrapWithLength(utf8Bytes(data)))
  const cipherBuf = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv },
    keys.enc,
    padded as any,
  )
  const cipherBytes = new Uint8Array(cipherBuf)
  const mac = await hmacSha256Sign(keys.mac, concatBytes(iv, cipherBytes))
  return `${bytesToHex(iv)}:${bytesToHex(cipherBytes)}:${bytesToHex(mac)}`
}

async function aesCbcHmacDecrypt(body: string, keys: V3Keys): Promise<string> {
  const parts = body.split(":")
  if (parts.length !== 3) throw new Error("Invalid encrypted data format")
  const iv = fromHex(parts[0])
  const cipherBytes = fromHex(parts[1])
  const mac = fromHex(parts[2])

  // Encrypt-then-MAC：先驗籤再解密，避免把未經認證的資料送進解密器。
  const expect = await hmacSha256Sign(keys.mac, concatBytes(iv, cipherBytes))
  if (!timingSafeEqual(expect, mac)) {
    throw new Error("Encrypted data failed integrity check (wrong key?)")
  }

  const plain = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: iv as any },
    keys.enc,
    cipherBytes as any,
  )
  return new TextDecoder().decode(unwrapWithLength(new Uint8Array(plain)))
}

// ── v4：ChaCha20-Poly1305（RFC 8439，純 JS）─────────────────────────────────
//
// WebCrypto 不提供 ChaCha20，故使用自帶的 `chacha20.ts`。佈局：
//   `<nonceHex(12B)>:<cipherHex>:<tagHex(16B)>`
// 其中 key = 32 字節派生材料。AEAD 自帶完整性校驗（Poly1305），無需額外 HMAC。

const V4_INFO = "openlist-db-cipher-v4-chacha20"

async function chachaEncrypt(data: string, key: Uint8Array): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const { ciphertext, tag } = chacha20Poly1305Seal(key, nonce, utf8Bytes(data))
  return `${bytesToHex(nonce)}:${bytesToHex(ciphertext)}:${bytesToHex(tag)}`
}

async function chachaDecrypt(body: string, key: Uint8Array): Promise<string> {
  const parts = body.split(":")
  if (parts.length !== 3) throw new Error("Invalid encrypted data format")
  const nonce = fromHex(parts[0])
  const ciphertext = fromHex(parts[1])
  const tag = fromHex(parts[2])
  return new TextDecoder().decode(
    chacha20Poly1305Open(key, nonce, ciphertext, tag),
  )
}

// ── v5/v6：DES / 3DES-CBC + HMAC-SHA256（Encrypt-then-MAC）──────────────────
//
// WebCrypto 不提供 DES/3DES，故使用 crypto-js（項目已有依賴，見 legacy-ciphers.ts）。
// 佈局：`<ivHex(8B)>:<cipherHex>:<macHex(32B)>`，MAC 覆蓋 iv‖cipher。
// 注意 DES/3DES 僅作相容用途，強度不足（見 legacy-ciphers.ts 的安全說明）。

const V5_INFO = "openlist-db-cipher-v5-des"
const V6_INFO = "openlist-db-cipher-v6-3des"
/**
 * DES/3DES 的 MAC 密鑰域（與加密密鑰分離，且兩種算法之間也分離 ——
 * 避免「同一把密鑰同時用於加密與認證」以及跨算法複用）。
 */
const V5_MAC_INFO = "openlist-db-cipher-v5-des-mac"
const V6_MAC_INFO = "openlist-db-cipher-v6-3des-mac"

async function desCbcHmacEncrypt(
  data: string,
  keyBytes: Uint8Array,
  macKey: CryptoKey,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(8))
  const cipherBytes = desCbcEncrypt(utf8Bytes(data), keyBytes, iv)
  const mac = await hmacSha256Sign(macKey, concatBytes(iv, cipherBytes))
  return `${bytesToHex(iv)}:${bytesToHex(cipherBytes)}:${bytesToHex(mac)}`
}

async function desCbcHmacDecrypt(
  body: string,
  keyBytes: Uint8Array,
  macKey: CryptoKey,
): Promise<string> {
  const parts = body.split(":")
  if (parts.length !== 3) throw new Error("Invalid encrypted data format")
  const iv = fromHex(parts[0])
  const cipherBytes = fromHex(parts[1])
  const mac = fromHex(parts[2])

  const expect = await hmacSha256Sign(macKey, concatBytes(iv, cipherBytes))
  if (!timingSafeEqual(expect, mac)) {
    throw new Error("Encrypted data failed integrity check (wrong key?)")
  }
  return new TextDecoder().decode(desCbcDecrypt(cipherBytes, keyBytes, iv))
}

/**
 * 欄位加解密器：把「寫入算法」和「共享密鑰」綁定成一個對象，供 db.ts 在
 * 一次 save / load 內複用（密鑰派生結果進一步在進程內快取，見 cachedDerive）。
 *
 * 關鍵約定：`encrypt()` 用**寫入算法**，`decrypt()` 用**密文前綴**識別算法。
 * 因此歷史 v1 密文、#69 寫入的 v2 密文、以及本實現新增的 v3/v4/v5/v6 密文都能讀；
 * 而「關掉加密 / 換算法」隻影響新寫入的內容。
 */
export interface FieldCipher {
  /** 寫入時使用的算法（`none` 不會構造本對象） */
  cipher: DbCipher
  /**
   * 「算法 + 密鑰」指紋（不含密鑰本身，16 位 hex）。
   *
   * 用途：db.ts 的「未變化欄位跳過重新加密」快取靠它判斷快取條目是否仍然有效 ——
   * 只要算法或密鑰變了，指紋就變，快取必然失效，絕不會把舊密鑰/舊算法的密文
   * 當成新配置下的結果寫回去。
   */
  fingerprint: string
  /** 按寫入算法加密，返回**不含前綴**的密文主體 */
  encrypt(value: string): Promise<string>
  /** 解密（入參是**含前綴**的完整密文），按前綴自動選擇算法 */
  decrypt(sealed: string): Promise<string>
}

export async function createFieldCipher(
  cipher: DbCipher,
  secret: string,
): Promise<FieldCipher> {
  // 弱算法（DES/3DES）只提示一次：它們是相容手段，不是安全選擇。
  if (cipher !== "none" && WEAK_DB_CIPHERS.includes(cipher) && !weakCipherWarned) {
    weakCipherWarned = true
    console.warn(
      `[Crypto] DB_CIPHER=${cipher} is for compatibility only: single DES ` +
        "(56-bit) is brute-forceable and 3DES is deprecated (NIST SP 800-131A). " +
        "Use aes-256-gcm or chacha20-poly1305 for real data.",
    )
  }

  const fingerprint =
    cipher === "none"
      ? "none"
      : await cachedDerive(`fp:${cipher}`, secret, async () => {
          const digest = await sha256Bytes(
            `openlist-db-cipher-fp|${cipher}|${secret}`,
          )
          return bytesToHex(digest).slice(0, 16)
        })

  // 各算法的密鑰材料：**派生結果在進程內快取**，同一次/後續讀寫都只派生一次。
  const getV2Key = () =>
    cachedDerive("v2", secret, () => deriveConfigEncryptionKey(secret))
  const getV3Keys = () =>
    cachedDerive(
      "v3",
      secret,
      async (): Promise<V3Keys> => ({
        enc: await deriveSha256AesCbcKey(secret, V3_ENC_INFO),
        mac: await hmacSha256RawKey(secret, V3_MAC_INFO),
      }),
    )
  const getV4Key = () =>
    cachedDerive("v4", secret, () => deriveKeyBytes(secret, V4_INFO, 32))
  const getV5Key = () =>
    cachedDerive("v5", secret, () => deriveKeyBytes(secret, V5_INFO, 8))
  const getV6Key = () =>
    cachedDerive("v6", secret, () => deriveKeyBytes(secret, V6_INFO, 24))
  const getV5MacKey = () =>
    cachedDerive("v5-mac", secret, async () =>
      importHmacKey(await deriveKeyBytes(secret, V5_MAC_INFO, 32)),
    )
  const getV6MacKey = () =>
    cachedDerive("v6-mac", secret, async () =>
      importHmacKey(await deriveKeyBytes(secret, V6_MAC_INFO, 32)),
    )

  return {
    cipher,
    fingerprint,
    async encrypt(value: string): Promise<string> {
      switch (cipher) {
        case "none":
          return value
        case "aes-256-gcm":
          return await encryptConfigValue(value, await getV2Key())
        case "aes-256-gcm-pbkdf2":
          return await encrypt(value, secret)
        case "aes-256-cbc-hmac":
          return await aesCbcHmacEncrypt(value, await getV3Keys())
        case "chacha20-poly1305":
          return await chachaEncrypt(value, await getV4Key())
        case "des-cbc-hmac":
          return await desCbcHmacEncrypt(
            value,
            await getV5Key(),
            await getV5MacKey(),
          )
        case "3des-cbc-hmac":
          return await desCbcHmacEncrypt(
            value,
            await getV6Key(),
            await getV6MacKey(),
          )
        default:
          throw new Error(`Unsupported DB_CIPHER: ${String(cipher)}`)
      }
    },
    async decrypt(sealed: string): Promise<string> {
      const hit = detectCipherPrefix(sealed)
      if (!hit) return sealed
      const body = sealed.slice(hit.prefix.length)
      switch (hit.cipher) {
        case "aes-256-gcm":
          return await decryptConfigValue(body, await getV2Key())
        case "aes-256-gcm-pbkdf2":
          return await decrypt(body, secret)
        case "aes-256-cbc-hmac":
          return await aesCbcHmacDecrypt(body, await getV3Keys())
        case "chacha20-poly1305":
          return await chachaDecrypt(body, await getV4Key())
        case "des-cbc-hmac":
          return await desCbcHmacDecrypt(
            body,
            await getV5Key(),
            await getV5MacKey(),
          )
        case "3des-cbc-hmac":
          return await desCbcHmacDecrypt(
            body,
            await getV6Key(),
            await getV6MacKey(),
          )
        default:
          throw new Error(`Unsupported ciphertext: ${String(hit.cipher)}`)
      }
    },
  }
}

/** PKCS#7 padding for AES-CBC (block size 16). */
function pkcs7Pad(pt: Uint8Array, blockSize = 16): Uint8Array {
  const padLen = blockSize - (pt.length % blockSize)
  const padded = new Uint8Array(pt.length + padLen)
  padded.set(pt)
  padded.fill(padLen, pt.length)
  return padded
}
