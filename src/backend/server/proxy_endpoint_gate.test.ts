import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { rawRouter } from "./raw"
import { saveDb } from "../internal/model/db"

/**
 * `/p` 公開代理端點的准入判定 —— 對齊 Go server/handles/down.go 的 canProxy()：
 * 未開啟代理、且擴展名也不在 proxy_types / text_types 裡時返回
 * 403 `proxy not allowed`（Go 只對 /p 與歸檔 /ap 做該檢查，/d、/sd 不做）。
 *
 * 這裡只覆蓋**拒絕**路徑：拒絕發生在取上游下載鏈接之前，因此不會訪問網路。
 * 「允許」路徑（web_proxy / MustProxy / text_types / proxy_types / use_proxy_url）
 * 由 internal/driver/proxy.test.ts 的 canUseProxyEndpoint 單測覆蓋。
 */

const dbWith = (storage: any, settings: any[] = []) => ({
  settings: [
    { key: "proxy_types", value: "m3u8,url" },
    { key: "text_types", value: "txt,md,srt,lrc" },
    ...settings,
  ],
  users: [
    {
      id: 1,
      username: "admin",
      password: "x",
      role: 2,
      permission: 0,
      base_path: "/",
      disabled: false,
    },
  ],
  storages: [
    {
      id: 1,
      mount_path: "/one",
      driver: "Onedrive",
      addition: "{}",
      status: "work",
      disabled: false,
      ...storage,
    },
  ],
  shares: [],
  metas: [],
})

const appOf = () => {
  const app = new Hono()
  app.route("/p", rawRouter)
  return app
}

test("/p：未開啟代理的儲存 + 非文本擴展名 → 403 proxy not allowed", async () => {
  const env: any = {}
  await saveDb(dbWith({}), env)
  const res = await appOf().request("/p/one/movie.mp4", { method: "GET" }, env)
  assert.equal(res.status, 403)
  assert.match(await res.text(), /proxy not allowed/)
})

test("/p：無擴展名的路徑同樣被拒絕", async () => {
  const env: any = {}
  await saveDb(dbWith({}), env)
  const res = await appOf().request("/p/one/binaryblob", { method: "GET" }, env)
  assert.equal(res.status, 403)
})

test("/p：關閉代理但屬於 text_types 的文本文件仍然放行（不再 403）", async () => {
  // 放行後進入下游邏輯（取鏈接），此處只斷言「沒有被准入檢查攔下」；
  // 使用不會產生網路請求的路徑：目錄式結尾會讓後續邏輯直接返回 4xx。
  const env: any = {}
  await saveDb(dbWith({ driver: "NotADriver" }), env)
  const res = await appOf().request("/p/one/readme.md", { method: "GET" }, env)
  assert.notEqual(res.status, 403)
})
