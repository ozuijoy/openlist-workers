import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { Hono } from "hono"
import { fsRouter } from "./fs"
import { rawRouter } from "./raw"
import { saveDb } from "../internal/model/db"
import { encodeDownloadPath } from "../pkg/path"
import {
  getSignExpiresIn,
  getSignPolicy,
  signDownloadPath,
  verifyDownloadSign,
} from "../pkg/sign"

/**
 * 與 Go 版對齊的兩處語義迴歸：
 *
 * 1. raw_url 的路徑編碼 —— Go 用 utils.EncodePath(reqPath, true)
 *    （url.PathEscape 的 encodePath 模式：保留 A-Za-z0-9-._~ 與 $&+,:;=@，
 *    其餘含 %、?、#、空格、非 ASCII 逐字節編碼，保留 `/`）。
 *    未編碼時 `?`/`#` 會被瀏覽器當成 query/fragment 截斷；裸 `%` 會讓服務端
 *    decodeURIComponent 拋 URIError（raw.ts 路徑解析）。
 *
 * 2. link_expiration 的單位與 0 語義 —— Go internal/sign：
 *    expire == 0 → NotExpired（永不過期）；否則 time.Duration(expire)*time.Hour
 *    （**小時**，官方文件 configuration/global.md 亦為 "in hours"）。
 */

const tmpRoots: string[] = []

function makeLocalRoot(files: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openlist-parity-"))
  for (const name of files) fs.writeFileSync(path.join(root, name), "x")
  tmpRoots.push(root)
  return root
}

const dbWith = (
  root: string,
  settings: Array<{ key: string; value: string }> = [],
) => ({
  settings,
  users: [
    {
      id: 1,
      username: "guest",
      password: "xxx",
      role: 1,
      permission: 0,
      base_path: "/",
      disabled: false,
    },
  ],
  storages: [
    {
      id: "s1",
      driver: "Local",
      mount_path: "/local",
      addition: JSON.stringify({ root_folder_path: root }),
      modified: "2026-01-01T00:00:00.000Z",
      disabled: false,
    },
  ],
  shares: [],
  metas: [],
})

const emptyDb = (settings: Array<{ key: string; value: string }> = []) => ({
  settings,
  users: [],
  storages: [],
  shares: [],
  metas: [],
})

const appOf = () => {
  const app = new Hono()
  app.route("/api/fs", fsRouter)
  app.route("/api/p", rawRouter)
  return app
}

// ---------------------------------------------------------------------------
// 1. 路徑編碼（Go utils.EncodePath(path, true)）
// ---------------------------------------------------------------------------

test("encodeDownloadPath 與 Go EncodePath(path, true) 的字符集合一致", () => {
  // 保留：字母數字、-_.~ 與子分隔符 $&+,:;=@，以及路徑分隔符 /
  assert.equal(
    encodeDownloadPath("/a-b_c.d~e/f$g&h+i,j:k;l=m@n.txt"),
    "/a-b_c.d~e/f$g&h+i,j:k;l=m@n.txt",
  )
  // 編碼：%、?、#、空格、非 ASCII（逐字節 %XX）
  assert.equal(encodeDownloadPath("/100%.txt"), "/100%25.txt")
  assert.equal(encodeDownloadPath("/a?b.txt"), "/a%3Fb.txt")
  assert.equal(encodeDownloadPath("/a#b.txt"), "/a%23b.txt")
  assert.equal(encodeDownloadPath("/a b.txt"), "/a%20b.txt")
  assert.equal(
    encodeDownloadPath("/儲存1/7z.exe"),
    "/%E5%AD%98%E5%82%A81/7z.exe",
  )
  // 缺少前導 / 時補上（與 Go 的 reqPath 一定是絕對路徑一致）
  assert.equal(encodeDownloadPath("a.txt"), "/a.txt")
})

test("fs/get：raw_url 編碼後，含 % / # / 中文 的文件名不再被截斷或 500", async () => {
  const env: any = {}
  // 注意：`?` 在 Windows 上無法作為文件名，其編碼行為由上一條單元用例覆蓋
  const names = ["100%.txt", "a#b.txt", "儲存1.exe"]
  const root = makeLocalRoot(names)
  await saveDb(dbWith(root, [{ key: "sign_all", value: "true" }]), env)
  const app = appOf()

  for (const name of names) {
    const res = await app.request("/api/fs/get", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: `/local/${name}` }),
    })
    const body: any = await res.json()
    assert.equal(body.code, 200, `${name}: ${JSON.stringify(body)}`)
    const rawUrl: string = body.data.raw_url
    assert.ok(
      rawUrl.startsWith("/api/p" + encodeDownloadPath(`/local/${name}`)),
      `${name}: raw_url not encoded -> ${rawUrl}`,
    )
    // 關鍵：這個 http 請求過去會拋 URIError（裸 %）或被 ? 截斷成另一個路徑
    const hit = await app.request(rawUrl, { method: "GET" })
    assert.notEqual(hit.status, 401, `${name}: raw_url rejected -> ${hit.status}`)
    assert.notEqual(hit.status, 500, `${name}: raw_url crashed -> ${hit.status}`)
  }
})

test("/p 對非法百分號轉義回 400（而不是 URIError 冒泡成 500）", async () => {
  const env: any = {}
  await saveDb(dbWith(makeLocalRoot(["a.txt"])), env)
  const res = await appOf().request("/api/p/local/100%.txt", { method: "GET" })
  assert.equal(res.status, 400)
})

// ---------------------------------------------------------------------------
// 2. link_expiration 單位（小時）與 0 = 永不過期
// ---------------------------------------------------------------------------

test("link_expiration 以小時計：24 → 有效期 86400 秒（與 Go *time.Hour 一致）", async () => {
  const env: any = {}
  await saveDb(emptyDb([{ key: "link_expiration", value: "24" }]), env)

  const policy = await getSignPolicy({ env })
  assert.equal(policy.enabled, true)
  assert.equal(policy.expiresIn, 24 * 3600)
  assert.equal(await getSignExpiresIn({ env }), 24 * 3600)

  const sign = await signDownloadPath({ env }, "/a.txt", 24 * 3600)
  const expires = parseInt(sign.slice(0, sign.lastIndexOf(".")), 10)
  const now = Math.floor(Date.now() / 1000)
  assert.ok(
    Math.abs(expires - (now + 86400)) <= 5,
    `expires should be ~now+86400s, got ${expires - now}s`,
  )
})

test("link_expiration=0 + sign_all：簽發永不過期簽名（expire=0，Go NotExpired）", async () => {
  const env: any = {}
  await saveDb(
    emptyDb([
      { key: "sign_all", value: "true" },
      { key: "link_expiration", value: "0" },
    ]),
    env,
  )

  const policy = await getSignPolicy({ env })
  assert.equal(policy.enabled, true)
  assert.equal(policy.expiresIn, 0, "0 = 永不過期")
  assert.equal(await getSignExpiresIn({ env }), 0)

  const sign = await signDownloadPath(
    { env },
    "/a.txt",
    await getSignExpiresIn({ env }),
  )
  assert.ok(sign.startsWith("0."), `expire 欄位應為 0，實際 ${sign.slice(0, 12)}`)
  assert.equal(await verifyDownloadSign({ env }, "/a.txt", sign), true)
})

test("負數有效期仍視為已過期（對齊 Go 傳負 duration 的行為）", async () => {
  const env: any = {}
  await saveDb(emptyDb(), env)
  const sign = await signDownloadPath({ env }, "/a.txt", -10)
  assert.equal(await verifyDownloadSign({ env }, "/a.txt", sign), false)
})

test("cleanup", () => {
  for (const root of tmpRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {}
  }
})
