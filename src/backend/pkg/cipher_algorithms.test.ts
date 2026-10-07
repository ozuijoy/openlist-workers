import assert from "node:assert/strict"
import { test } from "node:test"
import { createCipheriv, createDecipheriv } from "node:crypto"
import {
  chacha20Poly1305Open,
  chacha20Poly1305Seal,
  poly1305,
} from "./chacha20"
import { desCbcDecrypt, desCbcEncrypt } from "./legacy-ciphers"

/**
 * 新增算法的**獨立正確性驗證**。
 *
 * 這兩個算法都不在 WebCrypto 裡（ChaCha20 全平台缺失、DES/3DES 已被規範移除），
 * 因此必須用權威測試向量 + 與 Node/OpenSSL 原生實現交叉比對來鎖定正確性：
 *
 *   - ChaCha20-Poly1305：RFC 8439 §2.5.2（Poly1305）與 §2.8.2（AEAD）官方向量，
 *     並與 Node 原生 `chacha20-poly1305` 交叉比對。
 *   - DES / 3DES：與 OpenSSL 的 `des-ede3-cbc` 交叉比對。
 *     注意 OpenSSL 3 默認禁用 legacy provider，`des-cbc`（單 DES）不可用，
 *     因此單 DES 用等價形式 EDE(K,K,K) 作為參照（數學上完全等價）。
 */

const hex = (u8: Uint8Array | Buffer) => Buffer.from(u8).toString("hex")
const fromHex = (s: string) =>
  new Uint8Array(Buffer.from(s.replace(/\s+/g, ""), "hex"))

// ─── ChaCha20-Poly1305 ──────────────────────────────────────────────────────

test("Poly1305 匹配 RFC 8439 §2.5.2 官方向量", () => {
  const key = fromHex(
    "85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b",
  )
  const msg = new TextEncoder().encode("Cryptographic Forum Research Group")
  assert.equal(hex(poly1305(msg, key)), "a8061dc1305136c6c22b8baf0c0127a9")
})

test("ChaCha20-Poly1305 匹配 RFC 8439 §2.8.2 官方向量", () => {
  const key = fromHex(
    "808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f",
  )
  const nonce = fromHex("070000004041424344454647")
  const aad = fromHex("50515253c0c1c2c3c4c5c6c7")
  const plain = new TextEncoder().encode(
    "Ladies and Gentlemen of the class of '99: If I could offer you only one " +
      "tip for the future, sunscreen would be it.",
  )

  const { ciphertext, tag } = chacha20Poly1305Seal(key, nonce, plain, aad)
  assert.equal(
    hex(ciphertext),
    "d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d6" +
      "3dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b36" +
      "92ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc" +
      "3ff4def08e4b7a9de576d26586cec64b6116",
  )
  assert.equal(hex(tag), "1ae10b594f09e26a7e902ecbd0600691")

  // 往返
  const back = chacha20Poly1305Open(key, nonce, ciphertext, tag, aad)
  assert.equal(new TextDecoder().decode(back), new TextDecoder().decode(plain))
})

test("ChaCha20-Poly1305 與 Node 原生實現互操作，且拒絕被篡改的資料", () => {
  const key = fromHex(
    "808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f",
  )
  const nonce = fromHex("070000004041424344454647")
  const plain = new TextEncoder().encode("openlist-config-secret-value")

  // 本實現 → Node 原生解密
  const { ciphertext, tag } = chacha20Poly1305Seal(key, nonce, plain)
  const decipher = createDecipheriv("chacha20-poly1305", key, nonce, {
    authTagLength: 16,
  })
  decipher.setAuthTag(tag)
  const nodePlain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  assert.equal(nodePlain.toString("utf8"), "openlist-config-secret-value")

  // Node 原生 → 本實現解密
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, {
    authTagLength: 16,
  })
  const nodeCt = Buffer.concat([cipher.update(plain), cipher.final()])
  assert.equal(
    new TextDecoder().decode(
      chacha20Poly1305Open(
        key,
        nonce,
        new Uint8Array(nodeCt),
        new Uint8Array(cipher.getAuthTag()),
      ),
    ),
    "openlist-config-secret-value",
  )

  // 篡改密文 / 篡改標籤 / 換 nonce 都必須失敗
  const tampered = new Uint8Array(ciphertext)
  tampered[0] ^= 0x01
  assert.throws(() => chacha20Poly1305Open(key, nonce, tampered, tag))
  const badTag = new Uint8Array(tag)
  badTag[0] ^= 0x01
  assert.throws(() => chacha20Poly1305Open(key, nonce, ciphertext, badTag))
  const badNonce = new Uint8Array(nonce)
  badNonce[0] ^= 0x01
  assert.throws(() => chacha20Poly1305Open(key, badNonce, ciphertext, tag))
})

// ─── DES / 3DES ─────────────────────────────────────────────────────────────

const IV8 = new TextEncoder().encode("12345678")
const PLAIN = new TextEncoder().encode(
  "token-abcdefghijklmnopqrstuvwxyz-0123456789",
)

function nodeDes3Encrypt(keyBytes: Uint8Array, data: Uint8Array) {
  const c = createCipheriv("des-ede3-cbc", keyBytes, IV8)
  return new Uint8Array(Buffer.concat([c.update(data), c.final()]))
}

test("單 DES（8 字節密鑰）與 OpenSSL EDE(K,K,K) 完全一致", () => {
  const key8 = new TextEncoder().encode("12345678")
  const mine = desCbcEncrypt(PLAIN, key8, IV8)
  const triple = new Uint8Array([...key8, ...key8, ...key8])
  assert.equal(hex(mine), hex(nodeDes3Encrypt(triple, PLAIN)))
  // 反向：OpenSSL 加密 → 本實現解密
  assert.equal(
    new TextDecoder().decode(desCbcDecrypt(nodeDes3Encrypt(triple, PLAIN), key8, IV8)),
    new TextDecoder().decode(PLAIN),
  )
})

test("3DES（24 字節密鑰）與 OpenSSL des-ede3-cbc 完全一致", () => {
  const key24 = new TextEncoder().encode("0123456789abcdef01234567")
  const mine = desCbcEncrypt(PLAIN, key24, IV8)
  assert.equal(hex(mine), hex(nodeDes3Encrypt(key24, PLAIN)))
  // 反向：OpenSSL 加密 → 本實現解密
  assert.equal(
    new TextDecoder().decode(
      desCbcDecrypt(nodeDes3Encrypt(key24, PLAIN), key24, IV8),
    ),
    new TextDecoder().decode(PLAIN),
  )
})

test("DES/3DES 空串與多字節明文往返一致（PKCS#7 填充正確）", () => {
  const key24 = new TextEncoder().encode("0123456789abcdef01234567")
  for (const text of ["", "a", "中文 / emoji 😀", "x".repeat(300)]) {
    const data = new TextEncoder().encode(text)
    const iv = new Uint8Array(8).fill(7)
    const sealed = desCbcEncrypt(data, key24, iv)
    assert.equal(sealed.length % 8, 0, "密文必須是 8 字節分組的整數倍")
    assert.equal(
      new TextDecoder().decode(desCbcDecrypt(sealed, key24, iv)),
      text,
    )
  }
})
