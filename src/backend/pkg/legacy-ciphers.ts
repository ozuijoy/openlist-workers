/**
 * DES / 3DES-CBC（PKCS#7）純 JS 實現。
 *
 * ## 為什麼用 crypto-js 而不是 WebCrypto
 *
 * WebCrypto（CF Workers / 瀏覽器 / Node 的 `crypto.subtle`）**都不提供 DES/3DES**
 * （DES 早已從 WebCrypto 規範中移除）；本倉庫的邊緣構建還會把 `node:crypto`
 * 換成拋錯 shim（見 `scripts/node-shim.mjs`）。而 `crypto-js` 已在本倉庫依賴裡
 * （多個網盤驅動在用，已被打進產物），其 `TripleDES` 支持 8 / 16 / 24 字節密鑰：
 *
 *   - 8 字節  → 單 DES（EDE(K,K,K) ≡ DES，已與 OpenSSL `des-ede3-cbc` 交叉驗證一致）
 *   - 24 字節 → 3-key 3DES（168-bit，已與 OpenSSL 交叉驗證一致）
 *
 * ## 安全性提醒（務必知悉）
 *
 * 兩者都**只應作為相容手段**，不應用於保護真實資料：
 *   - 單 DES 有效密鑰僅 56-bit，可被專用硬件在小時級暴力破解；
 *   - 3DES 的 64-bit 分組在資料量大時受 Sweet32 攻擊影響，NIST SP 800-131A
 *     已不再認可其用於加密。
 * 因此本項目把 `des-cbc-hmac` / `3des-cbc-hmac` 實現為「CBC + 獨立的
 * HMAC-SHA256（Encrypt-then-MAC）」以保證**完整性**，但**不提供**任何強度承諾；
 * 需要真正的靜態加密請使用 `aes-256-gcm` 或 `chacha20-poly1305`。
 *
 * 該模塊只做「字節進、字節出」，十六進制編解碼與密鑰派生由 `crypto.ts` 負責。
 */
import CryptoJS from "crypto-js"

/** Uint8Array → crypto-js WordArray（按字節，不依賴 lib-typedarrays） */
function bytesToWordArray(bytes: Uint8Array): any {
  const words: number[] = []
  for (let i = 0; i < bytes.length; i++) {
    words[i >>> 2] |= bytes[i] << (24 - (i % 4) * 8)
  }
  return CryptoJS.lib.WordArray.create(words, bytes.length)
}

/** crypto-js WordArray → Uint8Array */
function wordArrayToBytes(wa: any): Uint8Array {
  const sigBytes = Number(wa?.sigBytes ?? 0)
  const words: number[] = wa?.words ?? []
  const out = new Uint8Array(sigBytes)
  for (let i = 0; i < sigBytes; i++) {
    out[i] = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff
  }
  return out
}

const DES_BLOCK = 8

/**
 * DES / 3DES-CBC 加密（PKCS#7 填充）。
 *
 * @param keyBytes 8 字節 → 單 DES；16 字節 → 2-key 3DES；24 字節 → 3-key 3DES
 * @param iv 必須為 8 字節（DES 分組長度）
 */
export function desCbcEncrypt(
  plain: Uint8Array,
  keyBytes: Uint8Array,
  iv: Uint8Array,
): Uint8Array {
  if (iv.length !== DES_BLOCK) throw new Error("DES IV must be 8 bytes")
  const out = CryptoJS.TripleDES.encrypt(
    bytesToWordArray(plain),
    bytesToWordArray(keyBytes),
    {
      iv: bytesToWordArray(iv),
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    },
  )
  return wordArrayToBytes(out.ciphertext)
}

/** DES / 3DES-CBC 解密（校驗並去除 PKCS#7 填充） */
export function desCbcDecrypt(
  cipher: Uint8Array,
  keyBytes: Uint8Array,
  iv: Uint8Array,
): Uint8Array {
  if (iv.length !== DES_BLOCK) throw new Error("DES IV must be 8 bytes")
  const out = CryptoJS.TripleDES.decrypt(
    { ciphertext: bytesToWordArray(cipher) } as any,
    bytesToWordArray(keyBytes),
    {
      iv: bytesToWordArray(iv),
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    },
  )
  return wordArrayToBytes(out)
}
