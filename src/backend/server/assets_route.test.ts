import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { assetsRouter } from "./assets"

/**
 * 靜態資源路由的迴歸：CDN 重定向**僅能**匹配固定目錄前綴。
 *
 * 背景（實機復現）：進入文件預覽頁後刷新，地址形如 `<域名>/儲存2/xxx.exe`，
 * 會被原先的貪婪路由 `/:folder/:filepath*` 攔下，未配置 ASSET_URLS 時直接
 * 返回 404 `Static resource not found`，前端來不及走到 SPA 兜底。
 *
 * Go 的對應實現（server/static/static.go）僅對
 * `assets / images / streamer / static` 四個目錄做 CDN 重定向，其餘一律
 * 交給 `noRoute`（返回 index.html）。
 */

/** 模擬 index.ts 的掛載順序：assetsRouter 位於 SPA 兜底之前 */
const appWithSpaFallback = () => {
  const app = new Hono()
  app.route("/", assetsRouter)
  app.all("*", (c) => c.html("<!doctype html><title>index</title>"))
  return app
}

test("刷新文件預覽頁（<掛載點>/<文件>）必須落到 SPA 兜底，而不是 404", async () => {
  const app = appWithSpaFallback()
  for (const path of [
    "/%E5%AD%98%E5%82%A82/xxx.exe",
    "/儲存2/xxx.exe",
    "/儲存2/sub/dir/file.mp4",
  ]) {
    const res = await app.request(path, {
      method: "GET",
      headers: { Accept: "text/html,application/xhtml+xml" },
    })
    assert.equal(res.status, 200, `${path} -> ${res.status}`)
    const body = await res.text()
    assert.match(body, /<title>index<\/title>/, `${path} 未返回 SPA 殼`)
    assert.doesNotMatch(body, /Static resource not found/, `${path} 被 CDN 路由吞掉`)
  }
})

test("未配置 ASSET_URLS 時，/assets/* 放行給本地靜態資源（不返回 404 文案）", async () => {
  const res = await appWithSpaFallback().request("/assets/index-abc.js", {
    method: "GET",
  })
  // 單測裡沒有 ASSETS 綁定，因此會落到 SPA 兜底；關鍵是不能再返回那句 404
  assert.notEqual(res.status, 404)
  assert.doesNotMatch(await res.text(), /Static resource not found/)
})

test("配置 ASSET_URLS 時，僅四個靜態目錄 302 到 CDN，且 $version 被替換", async () => {
  const env = { ASSET_URLS: "https://cdn.example.com/dist" }
  const app = appWithSpaFallback()

  for (const folder of ["assets", "images", "streamer", "static"]) {
    const res = await app.request(`/${folder}/a/b.js`, { method: "GET" }, env)
    assert.equal(res.status, 302, `${folder} 未重定向`)
    assert.equal(
      res.headers.get("location"),
      `https://cdn.example.com/dist/${folder}/a/b.js`,
    )
  }

  // 非靜態目錄不受影響（仍是 SPA 殼）
  const spa = await app.request("/儲存2/xxx.exe", { method: "GET" }, env)
  assert.equal(spa.status, 200)
  assert.match(await spa.text(), /<title>index<\/title>/)
})

test("ASSET_URLS 含 $version 佔位符時不留佔位符（取不到版本則 latest）", async () => {
  const env = {
    ASSET_URLS: "https://cdn.example.com/openlist/$version/files/dist",
  }
  const res = await appWithSpaFallback().request(
    "/assets/app.js",
    { method: "GET" },
    env,
  )
  assert.equal(res.status, 302)
  const location = res.headers.get("location") || ""
  assert.doesNotMatch(location, /\$version/)
  assert.match(location, /\/assets\/app\.js$/)
})

test("logo / favicon 仍然重定向到官方 logo", async () => {
  const res = await appWithSpaFallback().request("/favicon.ico", { method: "GET" })
  assert.equal(res.status, 302)
  assert.equal(res.headers.get("location"), "https://res.oplist.org/logo/logo.svg")
})
