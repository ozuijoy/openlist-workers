import assert from "node:assert/strict"
import { test } from "node:test"
import {
  canUseProxyEndpoint,
  driverMustProxy,
  driverMustProxyForStorage,
  driverPreferProxy,
  effectiveWebProxy,
  extensionOf,
  normalizeExtList,
  resolveProxyDecision,
} from "./proxy"

/**
 * 驅動代理能力表必須與 Go 各驅動的 meta.go 保持一致。
 *
 * Go: `Config.MustProxy() = OnlyProxy || NoLinkURL`、`Config.DefaultProxy() = PreferProxy`。
 * 這張表同時驅動三處行為，因此要鎖住它，避免再次出現「表單說強制代理、
 * 運行時卻走 302」這類兩處不一致的問題：
 *   1. 運行時下載模式（resolveProxyDecision）
 *   2. 原生代理的上限兜底能否降級為直鏈（isAuthBoundDownload）
 *   3. 後台表單欄位（admin.ts 的 buildProxyFields）
 */

test("MustProxy：只包含 Go 標了 OnlyProxy / NoLinkURL 的驅動", () => {
  const must = [
    "WeiYun",
    "SFTP",
    "FTP",
    "SMB",
    "Crypt",
    "Virtual",
    "Strm",
    "Mega_nz",
    "ProtonDrive",
    "Chunk",
    "GoogleDrive",
    "GooglePhoto",
    "QuarkOpen",
    "QuarkUC",
    "ChaoXing",
  ]
  for (const driver of must) {
    assert.equal(driverMustProxy(driver), true, `${driver} 應為 MustProxy`)
  }

  // Go 裡只有 PreferProxy 或完全沒有代理標記的驅動，不能當成 MustProxy
  const notMust = [
    "123Pan",
    "BaiduNetdisk",
    "123PanShare",
    "115Open",
    "189Cloud",
    "Terabox",
    "Onedrive",
    "AliyundriveOpen",
  ]
  for (const driver of notMust) {
    assert.equal(driverMustProxy(driver), false, `${driver} 不應為 MustProxy`)
  }
})

test("PreferProxy：與 Go 的 DefaultProxy() 一致", () => {
  for (const driver of [
    "WebDav",
    "BaiduNetdisk",
    "123Pan",
    "123PanShare",
    "123Open",
  ]) {
    assert.equal(driverPreferProxy(driver), true, `${driver} 應為 PreferProxy`)
  }
  for (const driver of ["Onedrive", "GoogleDrive", "S3", "Terabox"]) {
    assert.equal(
      driverPreferProxy(driver),
      false,
      `${driver} 不應為 PreferProxy`,
    )
  }
})

test("effectiveWebProxy：未配置時回退到驅動默認值，顯式值優先", () => {
  // PreferProxy 驅動：表單默認勾選（等價 Go op/driver.go 的默認 true）
  assert.equal(effectiveWebProxy({}, "webdav"), true)
  // 管理員顯式取消勾選時必須尊重（Go 的 ShouldProxy 只看該欄位）
  assert.equal(effectiveWebProxy({ web_proxy: false }, "webdav"), false)
  assert.equal(effectiveWebProxy({ web_proxy: "false" }, "webdav"), false)
  // 非 PreferProxy 驅動：默認不代理
  assert.equal(effectiveWebProxy({}, "onedrive"), false)
  assert.equal(effectiveWebProxy({ web_proxy: true }, "onedrive"), true)
})

test("resolveProxyDecision：MustProxy 優先，顯式 web_proxy=false 不被覆蓋", () => {
  // 1) 驅動強制代理
  assert.equal(
    resolveProxyDecision({ web_proxy: false }, "weiyun", false).source,
    "force",
  )
  // 2) PreferProxy 驅動默認代理，但顯式關閉後走直鏈（對齊 Go）
  assert.equal(resolveProxyDecision({}, "webdav", false).needsProxy, true)
  assert.equal(
    resolveProxyDecision({ web_proxy: false }, "webdav", false).needsProxy,
    false,
  )
  // 3) 普通驅動默認直鏈
  assert.equal(resolveProxyDecision({}, "onedrive", false).needsProxy, false)
  // 4) /p 前綴始終代理（對齊 Go 的 /p 路由）
  assert.equal(
    resolveProxyDecision({ web_proxy: false }, "onedrive", true).source,
    "proxy_path",
  )
  // 5) 儲存級 webdav_policy 生效
  assert.equal(
    resolveProxyDecision({ webdav_policy: "use_proxy_url" }, "onedrive", false)
      .mode,
    "use_proxy_url",
  )
})

// ---------------------------------------------------------------------------
// proxy_types / proxy_ignore_headers / text_types（對齊 Go ShouldProxy & canProxy）
// ---------------------------------------------------------------------------

test("extensionOf / normalizeExtList：與 Go utils.Ext 語義一致", () => {
  assert.equal(extensionOf("/a/b/File.MP4"), "mp4")
  assert.equal(extensionOf("/a/b/README"), "")
  // Go 的 path.Ext(".gitignore") 會給出隱藏文件後綴，text_types 默認值裡也有 gitignore
  assert.equal(extensionOf("/a/.gitignore"), "gitignore")
  assert.equal(extensionOf(""), "")

  assert.deepEqual(normalizeExtList("m3u8, .URL ,,md"), ["m3u8", "url", "md"])
  assert.deepEqual(normalizeExtList(["a", "b"]), ["a", "b"])
  assert.deepEqual(normalizeExtList(undefined), [])
})

test("resolveProxyDecision：proxy_types 命中的擴展名由服務端代理（Go ShouldProxy 第三條）", () => {
  const hit = resolveProxyDecision({ driver: "Onedrive" }, "onedrive", false, {
    filename: "/x/live.m3u8",
    proxyTypes: ["m3u8", "url"],
  })
  assert.equal(hit.mode, "native_proxy")
  assert.equal(hit.source, "proxy_types")

  // 未命中的擴展名仍走 302
  const miss = resolveProxyDecision({ driver: "Onedrive" }, "onedrive", false, {
    filename: "/x/movie.mp4",
    proxyTypes: ["m3u8", "url"],
  })
  assert.equal(miss.mode, "302_redirect")
})

test("driverMustProxyForStorage：bunny_storage 按 CDN 配置條件判定", () => {
  const withZoneNoCdn = {
    driver: "BunnyStorage",
    addition: JSON.stringify({
      storage_zone_name: "zone1",
      cdn_base_url: "",
    }),
  }
  const withCdn = {
    driver: "BunnyStorage",
    addition: JSON.stringify({
      storage_zone_name: "zone1",
      cdn_base_url: "https://cdn.example.com",
    }),
  }
  // 對齊 Go：StorageZoneName != "" && CDNBaseURL == "" → OnlyProxy + PreferProxy
  assert.equal(driverMustProxyForStorage(withZoneNoCdn), true)
  assert.equal(driverMustProxyForStorage(withCdn), false)
  // 其它驅動不受 addition 影響
  assert.equal(
    driverMustProxyForStorage({ driver: "Onedrive", addition: "{}" }),
    false,
  )
  // 本地驅動在 Go 裡是 OnlyProxy（TS 走本地文件分支，但 /p 判定需要算它允許代理）
  assert.equal(driverMustProxyForStorage({ driver: "local" }), true)
})

test("canUseProxyEndpoint：對齊 Go canProxy（/p 端點准入）", () => {
  const storage = { driver: "Onedrive", addition: "{}" }
  const gate = (over: any = {}) =>
    canUseProxyEndpoint({
      storage,
      driver: "Onedrive",
      filename: "/x/movie.mp4",
      proxyTypes: ["m3u8", "url"],
      textTypes: ["txt", "md", "srt", "lrc"],
      ...over,
    })

  // 未開啟代理 + 非文本擴展名 → 不允許（Go 會返回 403 proxy not allowed）
  assert.equal(gate(), false)
  // text_types：前端 Readme / 字幕 / 歌詞等文本預覽必須能走 /p
  assert.equal(gate({ filename: "/x/readme.md" }), true)
  assert.equal(gate({ filename: "/x/sub.srt" }), true)
  assert.equal(gate({ filename: "/x/lyric.lrc" }), true)
  // proxy_types
  assert.equal(gate({ filename: "/x/live.m3u8" }), true)
  // 儲存開啟了 web_proxy
  assert.equal(gate({ storage: { driver: "Onedrive", web_proxy: true } }), true)
  // 驅動 MustProxy
  assert.equal(gate({ storage: { driver: "WeiYun" }, driver: "WeiYun" }), true)
  // webdav_policy=use_proxy_url（Go canProxy 顯式包含 WebdavProxyURL）
  assert.equal(
    gate({ storage: { driver: "Onedrive", webdav_policy: "use_proxy_url" } }),
    true,
  )
  // 無擴展名（如目錄式路徑）不允許
  assert.equal(gate({ filename: "/x/noext" }), false)
})
