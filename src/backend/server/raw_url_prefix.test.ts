import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { getItem } from "../internal/op/storage"
import { saveDb } from "../internal/model/db"
import { canUseProxyEndpoint } from "../internal/driver/proxy"
import { rawRouter } from "./raw"

/**
 * #66 後續：`raw_url` 的端點前綴必須與儲存自身的代理配置匹配。
 *
 * `/p` 與 `/d` 不是等價的：
 *   - `/p` 會先跑 Go 的 `canProxy()`（`MustProxy || WebProxy || webdav_policy=
 *     use_proxy_url || proxy_types || text_types`），不通過直接
 *     `403 proxy not allowed`；
 *   - `/d` 不受該門禁限制（Go 的 `/d` 走 `ShouldProxy`）。
 *
 * 因此 raw_url 恆為 `/api/p` 時，凡是沒有開啟代理的儲存，僅要從預覽頁點「下載」
 * （或讓 `img/video` 去取 raw_url）就會 403；而文件列表右鍵下載走 `/d`，所以看起來
 * 「僅有預覽頁下載壞掉」。
 */

const storageRow = (driver: string, extra: Record<string, any> = {}) => ({
  id: "s1",
  driver,
  mount_path: "/np",
  addition: "{}",
  modified: "2026-01-01T00:00:00.000Z",
  disabled: false,
  ...extra,
})

const dbWith = (storages: any[], settings: any[] = []) => ({
  settings,
  users: [],
  storages,
  shares: [],
  metas: [],
})

const appOf = () => {
  const app = new Hono()
  app.route("/api/p", rawRouter)
  app.route("/api/d", rawRouter)
  return app
}

test("非代理儲存：raw_url 用 /api/d（/p 會被 canProxy 拒絕）", async () => {
  const env: any = {}
  await saveDb(dbWith([storageRow("gen")]), env)

  const { rawUrl } = await getItem("/np", { env })
  assert.equal(rawUrl, "/api/d/np")
})

test("web_proxy=true 的儲存：raw_url 用 /api/p", async () => {
  const env: any = {}
  await saveDb(dbWith([storageRow("gen", { web_proxy: true })]), env)

  const { rawUrl } = await getItem("/np", { env })
  assert.equal(rawUrl, "/api/p/np")
})

test("擴展名命中 proxy_types / text_types 時才允許 /p", () => {
  const storage = storageRow("gen")
  const check = (filename: string, proxyTypes: unknown, textTypes: unknown) =>
    canUseProxyEndpoint({
      storage,
      driver: "gen",
      filename,
      proxyTypes,
      textTypes,
    })

  assert.equal(check("/np/a.exe", [], []), false)
  assert.equal(check("/np/a.exe", ["exe"], []), true)
  assert.equal(check("/np/a.txt", [], ["txt"]), true)
})

test("HTTP 層面：/p 對非代理儲存回 403 proxy not allowed，/d 不受該門禁限制", async () => {
  const env: any = {}
  await saveDb(dbWith([storageRow("gen")]), env)
  const app = appOf()

  const viaProxy = await app.request("/api/p/np/a.exe", { method: "GET" })
  assert.equal(viaProxy.status, 403)
  assert.match(await viaProxy.text(), /proxy not allowed/)

  // 同一路徑走 /d：不觸發 canProxy 門禁（這裡會因驅動不存在而 404，但不能是 403）
  const viaDirect = await app.request("/api/d/np/a.exe", { method: "GET" })
  assert.notEqual(
    viaDirect.status,
    403,
    "/d 不應受 canProxy() 限制，否則非代理儲存的下載/預覽會全部 403",
  )
})
