import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { Hono } from "hono"
import { fsRouter } from "./fs"
import { rawRouter } from "./raw"
import { saveDb } from "../internal/model/db"
import { verifyDownloadSign } from "../pkg/sign"

/**
 * Issue #66 迴歸測試：[BUG] sign verify failed（下載 401，預覽正常）。
 *
 * 現象（issue 原文）：
 *   GET https://xxx/api/p/儲存1/7z2602-x64.exe → HTTP/2 401
 *   「下載文件出現 sign verify failed，不下載文件直接預覽是正常的」
 *
 * 根因：/fs/get 返回的 raw_url 形如 `/api/p/<path>`，指向的正是需要驗籤的
 * /p 端點，但**從來沒帶 ?sign=**；而前端把 raw_url 直接當下載地址用
 *   - 預覽頁的下載按鈕：<a href={objStore.raw_url}>（previews/download.tsx）
 *   - 圖片/視頻預覽：<img src={objStore.raw_url}> / <video src={...}>
 * 不會再自己拼簽名（僅有文件列表裡的 /d、/p 鏈接才會用 fs/list 返回的 sign）。
 *
 * 於是 sign_all / 儲存級 enable_sign / 密碼 meta 覆蓋時：
 *   - .exe 這類「預覽頁僅是元信息 + 下載按鈕」的文件，頁面能正常打開，
 *     一點下載就 401 —— 正是 issue 描述的現象；
 * 而 Go 版 server/handles/fsread.go FsGet 會顯式補上：
 *   if isEncrypt(meta, reqPath) || setting.GetBool(conf.SignAll) {
 *       query = "?sign=" + sign.Sign(reqPath)
 *   }
 */

const tmpRoots: string[] = []

/** 建一個臨時目錄並放入一個真實文件，掛成 Local 儲存的根。 */
function makeLocalRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openlist-rawurl-sign-"))
  fs.writeFileSync(path.join(root, "a.exe"), "MZ")
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

const appOf = () => {
  const app = new Hono()
  app.route("/api/fs", fsRouter)
  app.route("/api/p", rawRouter)
  return app
}

const signOf = (rawUrl: string) =>
  new URL(rawUrl, "http://localhost").searchParams.get("sign") || ""

test("fs/get: raw_url 自帶簽名，且該簽名能通過 /p 驗籤（Issue #66）", async () => {
  const env: any = {}
  const root = makeLocalRoot()
  await saveDb(dbWith(root, [{ key: "sign_all", value: "true" }]), env)

  const app = appOf()
  const res = await app.request("/api/fs/get", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "/local/a.exe" }),
  })
  const body: any = await res.json()
  assert.equal(body.code, 200, `fs/get failed: ${JSON.stringify(body)}`)

  const rawUrl: string = body.data.raw_url
  assert.ok(
    rawUrl.startsWith("/api/p/local/a.exe"),
    `raw_url should stay a proxy url, got ${rawUrl}`,
  )
  // 缺這一條就是 bug 本體：前端直接跳 raw_url，伺服器卻沒拿到簽名
  assert.ok(
    /[?&]sign=/.test(rawUrl),
    `raw_url must carry the download sign, got ${rawUrl}`,
  )
  // 客戶端用的 sign 欄位與 raw_url 裡的必須一致（前端另一處用它拼 /d 鏈接）
  assert.equal(signOf(rawUrl), body.data.sign)
  assert.equal(await verifyDownloadSign(env, "/local/a.exe", body.data.sign), true)

  // 端到端：瀏覽器直接打開 raw_url 不能再 401（issue 裡就是這一步）
  const hit = await app.request(rawUrl, { method: "GET" })
  assert.notEqual(
    hit.status,
    401,
    "raw_url returned by /fs/get must be accepted by /p (was 401 before the fix)",
  )
})

test("fs/get: 不需要簽名時不追加 sign（保持公開直鏈語義）", async () => {
  const env: any = {}
  const root = makeLocalRoot()
  await saveDb(dbWith(root), env)

  const res = await appOf().request("/api/fs/get", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "/local/a.exe" }),
  })
  const body: any = await res.json()
  assert.equal(body.code, 200)
  assert.equal(body.data.sign, "")
  assert.equal(
    body.data.raw_url,
    "/api/p/local/a.exe",
    "public path keeps a bare proxy url",
  )
})

test("/p 冪等：raw_url 中的簽名被篡改即 401（對照，證明斷言有效）", async () => {
  const env: any = {}
  const root = makeLocalRoot()
  await saveDb(dbWith(root, [{ key: "sign_all", value: "true" }]), env)

  const app = appOf()
  const res = await app.request("/api/fs/get", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "/local/a.exe" }),
  })
  const body: any = await res.json()
  const sign: string = body.data.sign
  const tampered = sign.slice(0, -1) + (sign.endsWith("a") ? "b" : "a")

  const hit = await app.request(
    `/api/p/local/a.exe?sign=${encodeURIComponent(tampered)}`,
    { method: "GET" },
  )
  assert.equal(hit.status, 401)
})

test("cleanup", () => {
  for (const root of tmpRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {}
  }
})
