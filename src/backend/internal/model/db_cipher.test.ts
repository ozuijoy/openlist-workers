import assert from "node:assert/strict"
import { test } from "node:test"
import {
  DB_CIPHER_VALUES,
  type DbCipher,
  cipherPrefix,
  createFieldCipher,
  deriveConfigEncryptionKey,
  detectCipherPrefix,
  encrypt,
  encryptConfigValue,
  isSealedCiphertext,
  resolveDbCipher,
  type DbCipher,
} from "../../pkg/crypto"
import { readCipher } from "./store/backend"
import { memoryDriver } from "./store/driver/memory"
import { mapFormat } from "./store/format/map"

/**
 * DB_CIPHER 迴歸測試。
 *
 * 鎖定三條核心不變量：
 *   1. **默認不加密**（DB_CIPHER 缺省 = none）：敏感欄位明文落盤；
 *   2. **解密由密文前綴驅動**，與當前配置無關：換算法 / 關加密都不會讓既有密文
 *      無法讀取（否則升級會把「登入密碼」變成誰也解不開的亂碼）；
 *   3. **DB_CIPHER=none 不影響 JWT 共享密鑰**：密鑰的生成與持久化照舊。
 */

const SECRET = "test-shared-secret-0123456789abcdef"

/**
 * 全部真實算法（none 之外）。
 *
 * 注意：`aes-256-gcm-pbkdf2` 每次派生要跑 10 萬次 PBKDF2（約 27 ms/欄位），
 * 因此涉及它的用例會明顯更慢 —— 這是歷史 envelope 的固有代價。
 */
const SECRET_CIPHERS = [
  "aes-256-gcm",
  "aes-256-gcm-pbkdf2",
  "aes-256-cbc-hmac",
  "chacha20-poly1305",
  "des-cbc-hmac",
  "3des-cbc-hmac",
] as const

function envFor(cipher?: string): any {
  const env: any = {
    DB_DRIVER: "memory",
    DB_FORMAT: "map",
    JWT_SECRET: SECRET,
  }
  if (cipher !== undefined) env.DB_CIPHER = cipher
  return env
}

function sampleDb() {
  return {
    settings: [
      { key: "site_title", value: "OpenList" },
      { key: "token", value: "tok-123" },
    ],
    users: [
      {
        id: 1,
        username: "admin",
        role: 2,
        permission: 0,
        base_path: "/",
        disabled: false,
        password: "hash-abc",
        otp_secret: "OTP-SECRET",
      },
    ],
    storages: [
      {
        id: 1,
        mount_path: "/drive",
        driver: "local",
        addition: JSON.stringify({ token: "drive-token" }),
      },
    ],
    shares: [],
    metas: [],
    plugins: [],
  }
}

const rawUser = (raw: any) => raw.users.find((u: any) => u.username === "admin")
const rawSetting = (raw: any, key: string) =>
  raw.settings.find((s: any) => s.key === key)
/** 讀取**儲存中的原始內容**（未經 unseal），用於斷言落盤形態 */
const rawStored = (env: any) => mapFormat.load(memoryDriver, env)

// ─── 配置解析 ────────────────────────────────────────────────────────────────

test("readCipher：默認 none，別名可用，非法值回退 none", () => {
  assert.equal(readCipher({}), "none", "缺省必須為 none（默認不加密）")
  assert.equal(readCipher({ DB_CIPHER: "" }), "none")
  assert.equal(readCipher({ DB_CIPHER: "  none  " }), "none")
  assert.equal(readCipher({ DB_CIPHER: "off" }), "none")

  assert.equal(readCipher({ DB_CIPHER: "AES-256-GCM" }), "aes-256-gcm")
  assert.equal(readCipher({ DB_CIPHER: "gcm" }), "aes-256-gcm")
  assert.equal(readCipher({ DB_CIPHER: "v2" }), "aes-256-gcm")
  assert.equal(readCipher({ DB_CIPHER: "pbkdf2" }), "aes-256-gcm-pbkdf2")
  assert.equal(readCipher({ DB_CIPHER: "v1" }), "aes-256-gcm-pbkdf2")
  assert.equal(readCipher({ DB_CIPHER: "v3" }), "aes-256-cbc-hmac")
  assert.equal(readCipher({ DB_CIPHER: "chacha20" }), "chacha20-poly1305")
  assert.equal(readCipher({ DB_CIPHER: "ChaCha20-Poly1305" }), "chacha20-poly1305")
  assert.equal(readCipher({ DB_CIPHER: "v4" }), "chacha20-poly1305")
  assert.equal(readCipher({ DB_CIPHER: "des" }), "des-cbc-hmac")
  assert.equal(readCipher({ DB_CIPHER: "v5" }), "des-cbc-hmac")
  assert.equal(readCipher({ DB_CIPHER: "3des" }), "3des-cbc-hmac")
  assert.equal(readCipher({ DB_CIPHER: "tripledes" }), "3des-cbc-hmac")
  assert.equal(readCipher({ DB_CIPHER: "v6" }), "3des-cbc-hmac")

  // 拼錯不得靜默啟用某個算法
  assert.equal(readCipher({ DB_CIPHER: "rot13" }), "none")
  assert.equal(resolveDbCipher("rot13").known, false)
  assert.equal(resolveDbCipher("aes-256-gcm").known, true)

  for (const cipher of DB_CIPHER_VALUES) {
    assert.equal(readCipher({ DB_CIPHER: cipher }), cipher)
  }
})

test("密文前綴與算法一一對應（v1..v6）", () => {
  assert.equal(cipherPrefix("none"), "")
  assert.equal(cipherPrefix("aes-256-gcm-pbkdf2"), "enc:v1:")
  assert.equal(cipherPrefix("aes-256-gcm"), "enc:v2:")
  assert.equal(cipherPrefix("aes-256-cbc-hmac"), "enc:v3:")
  assert.equal(cipherPrefix("chacha20-poly1305"), "enc:v4:")
  assert.equal(cipherPrefix("des-cbc-hmac"), "enc:v5:")
  assert.equal(cipherPrefix("3des-cbc-hmac"), "enc:v6:")

  assert.equal(detectCipherPrefix("hash-abc"), null)
  assert.equal(detectCipherPrefix("enc:v9:abc"), null, "未知版本不得被識別")
  assert.equal(detectCipherPrefix("enc:v1:aa:bb:cc")?.cipher, "aes-256-gcm-pbkdf2")
  assert.equal(detectCipherPrefix("enc:v2:aa:bb")?.cipher, "aes-256-gcm")
  assert.equal(detectCipherPrefix("enc:v3:aa:bb:cc")?.cipher, "aes-256-cbc-hmac")
  assert.equal(detectCipherPrefix("enc:v4:aa:bb:cc")?.cipher, "chacha20-poly1305")
  assert.equal(detectCipherPrefix("enc:v5:aa:bb:cc")?.cipher, "des-cbc-hmac")
  assert.equal(detectCipherPrefix("enc:v6:aa:bb:cc")?.cipher, "3des-cbc-hmac")
  assert.equal(isSealedCiphertext("enc:v2:aa:bb"), true)
  assert.equal(isSealedCiphertext("plain"), false)
})

// ─── 算法層 ──────────────────────────────────────────────────────────────────

test("各算法加密→解密往返一致（含空串與多字節）", async () => {
  const samples = [
    "",
    "a",
    "hash-abc",
    "中文 / emoji 😀 / 換行\n換行",
    "x".repeat(5000),
  ]
  for (const cipher of SECRET_CIPHERS) {
    const fc = await createFieldCipher(cipher, SECRET)
    for (const plain of samples) {
      const body = await fc.encrypt(plain)
      const sealed = cipherPrefix(cipher) + body
      assert.notEqual(body, plain, `${cipher} 必須產生密文`)
      assert.equal(detectCipherPrefix(sealed)?.cipher, cipher)
      assert.equal(await fc.decrypt(sealed), plain)
    }
  }
})

test("解密由前綴驅動：任意寫入算法都能解開全部版本的密文", async () => {
  // v1/v2 手工產生（對應歷史實現與 #69），v3~v6 分別用各自的寫入器產生，
  // 然後用**寫 v3 的**解密器把它們全部解開（證明解密與當前配置無關）。
  const v1 = "enc:v1:" + (await encrypt("v1-secret", SECRET))
  const v2 =
    "enc:v2:" +
    (await encryptConfigValue(
      "v2-secret",
      await deriveConfigEncryptionKey(SECRET),
    ))
  const producers: Array<[DbCipher, string]> = [
    ["aes-256-cbc-hmac", "v3-secret"],
    ["chacha20-poly1305", "v4-secret"],
    ["des-cbc-hmac", "v5-secret"],
    ["3des-cbc-hmac", "v6-secret"],
  ]
  const sealedList: Array<[string, string]> = []
  for (const [cipher, plain] of producers) {
    const fc = await createFieldCipher(cipher, SECRET)
    sealedList.push([cipherPrefix(cipher) + (await fc.encrypt(plain)), plain])
  }

  const reader = await createFieldCipher("aes-256-cbc-hmac", SECRET)
  assert.equal(await reader.decrypt(v1), "v1-secret")
  assert.equal(await reader.decrypt(v2), "v2-secret")
  for (const [sealed, plain] of sealedList) {
    assert.equal(await reader.decrypt(sealed), plain)
  }
  // 明文原樣返回
  assert.equal(await reader.decrypt("plain-value"), "plain-value")

  // #69 寫入的 v2 密文必須與「寫 v2 的實現」互相相容（同一密鑰、同一 HKDF 參數）
  const v2fc = await createFieldCipher("aes-256-gcm", SECRET)
  const v2Fresh = await v2fc.encrypt("v2-fresh")
  assert.equal(
    await v2fc.decrypt("enc:v2:" + v2Fresh),
    "v2-fresh",
    "v2 寫入/讀取必須與 #69 的 envelope 自洽",
  )
})

test("密鑰不匹配時必須解密失敗，而不是返回亂碼", async () => {
  const wrong = "another-secret-0123456789abcdefgh"
  for (const cipher of SECRET_CIPHERS) {
    const fc = await createFieldCipher(cipher, SECRET)
    const sealed = cipherPrefix(cipher) + (await fc.encrypt("secret-value"))
    // 同密鑰正常
    assert.equal(await fc.decrypt(sealed), "secret-value")
    // 換密鑰必須拋錯（AES-GCM 認證失敗 / CBC-HMAC 驗籤失敗）
    const wrongFc = await createFieldCipher(cipher, wrong)
    await assert.rejects(
      () => wrongFc.decrypt(sealed),
      `換密鑰後 ${cipher} 必須解密失敗`,
    )
  }
})

test("v3 為 Encrypt-then-MAC：篡改密文必須被完整性校驗攔下", async () => {
  const fc = await createFieldCipher("aes-256-cbc-hmac", SECRET)
  const prefix = cipherPrefix("aes-256-cbc-hmac")
  const parts = (await fc.encrypt("secret-value")).split(":")
  const flipped = parts[1][0] === "0" ? "1" : "0"
  const tampered = `${prefix}${parts[0]}:${flipped}${parts[1].slice(1)}:${parts[2]}`
  await assert.rejects(() => fc.decrypt(tampered))
})

// ─── 持久化邊界 ──────────────────────────────────────────────────────────────

test("DB_CIPHER 缺省：敏感欄位明文落盤（默認不加密）", async () => {
  const db = await import("./db")
  db.__resetDbCacheForTest()
  const env = envFor() // 不設置 DB_CIPHER

  assert.equal(await db.saveDb(sampleDb(), env, { force: true }), true)

  const raw: any = await rawStored(env)
  assert.equal(rawUser(raw).password, "hash-abc")
  assert.equal(rawUser(raw).otp_secret, "OTP-SECRET")
  assert.equal(rawSetting(raw, "token").value, "tok-123")
  assert.equal(raw.storages[0].addition, JSON.stringify({ token: "drive-token" }))
  assert.equal(isSealedCiphertext(rawUser(raw).password), false)

  // 讀回同樣為明文
  db.__resetDbCacheForTest()
  const loaded: any = await db.getDb(env)
  assert.equal(rawUser(loaded).password, "hash-abc")
})

test("DB_CIPHER 非 none：敏感欄位按所選算法落盤，讀回自動解密", async () => {
  for (const cipher of SECRET_CIPHERS) {
    const db = await import("./db")
    db.__resetDbCacheForTest()
    const env = envFor(cipher)

    assert.equal(await db.saveDb(sampleDb(), env, { force: true }), true)

    const raw: any = await rawStored(env)
    for (const sealed of [
      rawUser(raw).password,
      rawUser(raw).otp_secret,
      rawSetting(raw, "token").value,
      raw.storages[0].addition,
    ]) {
      assert.equal(detectCipherPrefix(sealed)?.cipher, cipher, `${cipher} 應落盤為密文`)
    }
    assert.notEqual(rawUser(raw).password, "hash-abc")
    // 非敏感設置不應被加密（避免無謂開銷）
    assert.equal(rawSetting(raw, "site_title").value, "OpenList")

    // 冷啟動重新加載（繞過記憶體快照）→ 必須自動解密
    db.__resetDbCacheForTest()
    const loaded: any = await db.getDb(env)
    assert.equal(rawUser(loaded).password, "hash-abc", `${cipher} 讀回必須是明文`)
    assert.equal(rawUser(loaded).otp_secret, "OTP-SECRET")
    assert.equal(rawSetting(loaded, "token").value, "tok-123")
    assert.equal(
      loaded.storages[0].addition,
      JSON.stringify({ token: "drive-token" }),
    )
  }
})

test("舊部署遷移：DB_CIPHER=none 仍能讀加密資料，並在下次保存轉為明文", async () => {
  const db = await import("./db")

  // 1) 模擬 #69 的既有部署：DB_CIPHER 未配置時期望寫入 v2 密文
  const legacyEnv = envFor("aes-256-gcm")
  db.__resetDbCacheForTest()
  assert.equal(await db.saveDb(sampleDb(), legacyEnv, { force: true }), true)
  const legacyRaw: any = await rawStored(legacyEnv)
  assert.equal(isSealedCiphertext(legacyRaw.users[0].password), true)
  assert.equal(
    detectCipherPrefix(legacyRaw.users[0].password)?.cipher,
    "aes-256-gcm",
  )

  // 2) 升級後默認 DB_CIPHER=none：同一份儲存必須仍可解密（否則登入直接壞掉）
  const plainEnv = envFor()
  db.__resetDbCacheForTest()
  const loaded: any = await db.getDb(plainEnv)
  assert.equal(rawUser(loaded).password, "hash-abc", "關掉加密後舊密文必須仍能解開")
  assert.equal(rawUser(loaded).otp_secret, "OTP-SECRET")

  // 3) 下一次保存 → 自動轉為明文（逐欄位遷移，無需手動步驟）
  assert.equal(await db.saveDb(loaded, plainEnv), true)
  const raw: any = await rawStored(plainEnv)
  assert.equal(rawUser(raw).password, "hash-abc")
  assert.equal(isSealedCiphertext(rawUser(raw).password), false)
})

test("舊部署遷移：PBKDF2（enc:v1:）密文在 none 下同樣可讀", async () => {
  const db = await import("./db")
  const env = envFor()

  // 直接向儲存寫入一份「歷史 v1 加密」的庫（模擬 pre-#69 的部署資料）
  const legacy = sampleDb()
  legacy.users[0].password = "enc:v1:" + (await encrypt("hash-abc", SECRET))
  legacy.users[0].otp_secret = "enc:v1:" + (await encrypt("OTP-SECRET", SECRET))
  legacy.settings[1].value = "enc:v1:" + (await encrypt("tok-123", SECRET))
  await mapFormat.save(legacy, memoryDriver, env)

  db.__resetDbCacheForTest()
  const loaded: any = await db.getDb(env)
  assert.equal(rawUser(loaded).password, "hash-abc")
  assert.equal(rawUser(loaded).otp_secret, "OTP-SECRET")
  assert.equal(rawSetting(loaded, "token").value, "tok-123")
})

test("更換算法：舊密文按前綴解密，新寫入使用新算法", async () => {
  const db = await import("./db")

  const v2Env = envFor("aes-256-gcm")
  db.__resetDbCacheForTest()
  assert.equal(await db.saveDb(sampleDb(), v2Env, { force: true }), true)

  const v3Env = envFor("aes-256-cbc-hmac")
  db.__resetDbCacheForTest()
  const loaded: any = await db.getDb(v3Env)
  assert.equal(rawUser(loaded).password, "hash-abc", "舊 v2 密文必須能被 v3 配置讀取")

  assert.equal(await db.saveDb(loaded, v3Env), true)
  const raw: any = await rawStored(v3Env)
  assert.equal(
    detectCipherPrefix(rawUser(raw).password)?.cipher,
    "aes-256-cbc-hmac",
  )
  assert.equal(
    detectCipherPrefix(rawUser(raw).otp_secret)?.cipher,
    "aes-256-cbc-hmac",
  )
})

test("DB_CIPHER=none 不影響共享密鑰的生成與持久化（JWT 仍需密鑰）", async () => {
  const db = await import("./db")
  const env = {
    DB_DRIVER: "memory",
    DB_FORMAT: "map",
    DB_CIPHER: "none",
  }
  db.__resetDbCacheForTest()

  const key = await db.ensureEncryptionSecret(env)
  assert.equal(typeof key, "string", "無 JWT_SECRET 時必須自動生成共享密鑰")
  assert.ok((key as string).length >= 16)
  assert.equal(await db.isEncryptionReady(env), true, "生成後任意實例都能讀到密鑰")
})

// ─── 性能相關不變量（對功能無影響，但必須長期成立）──────────────────────────

test("saveDb 採用寫時複製：不修改調用方傳入的記憶體對象", async () => {
  const db = await import("./db")
  db.__resetDbCacheForTest()
  const env = envFor("chacha20-poly1305")
  const data = sampleDb()

  assert.equal(await db.saveDb(data, env, { force: true }), true)

  // 記憶體中的對象必須保持明文（歷史實現是深拷貝，新實現是寫時複製，
  // 兩者都**不得**把明文替換成密文 —— 否則調用方持有的引用會被汙染）。
  assert.equal(rawUser(data).password, "hash-abc")
  assert.equal(rawUser(data).otp_secret, "OTP-SECRET")
  assert.equal(
    data.storages[0].addition,
    JSON.stringify({ token: "drive-token" }),
  )
  assert.equal(rawSetting(data, "token").value, "tok-123")
  assert.equal(rawSetting(data, "site_title").value, "OpenList")

  // 落盤內容則是密文
  const raw: any = await rawStored(env)
  assert.equal(
    detectCipherPrefix(rawUser(raw).password)?.cipher,
    "chacha20-poly1305",
  )
})

test("未變化欄位跳過重新加密：密文保持不變，且只重新加密改動過的欄位", async () => {
  const db = await import("./db")
  db.__resetDbCacheForTest()
  const env = envFor("aes-256-gcm")

  assert.equal(await db.saveDb(sampleDb(), env, { force: true }), true)
  const first: any = await rawStored(env)

  // 內容完全相同再存一次 → 複用上次的密文（逐字節一致）
  assert.equal(await db.saveDb(sampleDb(), env), true)
  const second: any = await rawStored(env)
  assert.equal(
    rawUser(second).password,
    rawUser(first).password,
    "未變化的欄位不應重新加密",
  )
  assert.equal(rawUser(second).otp_secret, rawUser(first).otp_secret)
  assert.equal(second.storages[0].addition, first.storages[0].addition)
  assert.equal(rawSetting(second, "token").value, rawSetting(first, "token").value)

  // 只改一個欄位 → 只有它重新加密，其餘欄位的密文原樣保留
  const changed = sampleDb()
  changed.users[0].password = "hash-xyz"
  assert.equal(await db.saveDb(changed, env), true)
  const third: any = await rawStored(env)
  assert.notEqual(rawUser(third).password, rawUser(first).password)
  assert.equal(rawUser(third).otp_secret, rawUser(first).otp_secret)
  assert.equal(third.storages[0].addition, first.storages[0].addition)

  // 新值仍可正常解回
  db.__resetDbCacheForTest()
  const loaded: any = await db.getDb(env)
  assert.equal(rawUser(loaded).password, "hash-xyz")
})

test("load → save 複用：讀回後原樣保存不會重複加密（3DES 同樣）", async () => {
  const db = await import("./db")
  db.__resetDbCacheForTest()
  const env = envFor("3des-cbc-hmac")

  assert.equal(await db.saveDb(sampleDb(), env, { force: true }), true)
  const first: any = await rawStored(env)

  // 強制一次真實加載（清快取 → 讀儲存 → 解密，並在解密時記賬）
  db.__resetDbCacheForTest()
  const loaded: any = await db.getDb(env)
  assert.equal(rawUser(loaded).password, "hash-abc")

  // 未做任何修改就保存 → 複用加載時記下的密文
  assert.equal(await db.saveDb(loaded, env), true)
  const second: any = await rawStored(env)
  assert.equal(rawUser(second).password, rawUser(first).password)
  assert.equal(second.storages[0].addition, first.storages[0].addition)
})
