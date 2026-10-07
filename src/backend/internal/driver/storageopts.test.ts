import assert from "node:assert/strict"
import { test } from "node:test"
import {
  getProxyRange,
  getEnableSign,
  getDisableIndex,
  parseCustomCachePolicies,
  matchGlob,
  resolveCacheExpiration,
} from "./storageopts"
import { resolveProxyDecision, getDownProxyUrl } from "./proxy"

// ---- proxy_range ----

test("proxy_range: 顯式為 true/false 時以其為準", () => {
  assert.equal(getProxyRange({ proxy_range: true }), true)
  assert.equal(getProxyRange({ proxy_range: "true" }), true)
  assert.equal(getProxyRange({ proxy_range: false }), false)
  assert.equal(getProxyRange({ proxy_range: "false" }), false)
})

test("proxy_range: 未配置時默認透傳（對齊 Go 透明代理轉發客戶端頭）", () => {
  assert.equal(getProxyRange({}), true)
  // 顯式配置優先於默認值
  assert.equal(getProxyRange({ proxy_range: false }), false)
})

// ---- enable_sign / disable_index ----

test("enable_sign / disable_index: 解析字符串與布爾兩種形式", () => {
  assert.equal(getEnableSign({ enable_sign: true }), true)
  assert.equal(getEnableSign({ enable_sign: "true" }), true)
  assert.equal(getEnableSign({ enable_sign: "false" }), false)
  assert.equal(getEnableSign({}), false)

  assert.equal(getDisableIndex({ disable_index: true }), true)
  assert.equal(getDisableIndex({ disable_index: "true" }), true)
  assert.equal(getDisableIndex({}), false)
})

// ---- custom_cache_policies ----

test("custom_cache_policies: 支持 JSON 數組形式", () => {
  const policies = parseCustomCachePolicies({
    custom_cache_policies:
      '[{"path":"/photos/*","cache_expiration":1440},{"path":"/tmp/**","cache_expiration":0}]',
  })
  assert.equal(policies.length, 2)
  assert.equal(policies[0].path, "/photos/*")
  assert.equal(policies[0].cacheExpiration, 1440)
  assert.equal(policies[1].path, "/tmp/**")
  assert.equal(policies[1].cacheExpiration, 0)
})

test("custom_cache_policies: 支持 max_age 別名", () => {
  const policies = parseCustomCachePolicies({
    custom_cache_policies: [{ path: "/a/*", max_age: 60 }],
  })
  assert.equal(policies.length, 1)
  assert.equal(policies[0].cacheExpiration, 60)
})

test("custom_cache_policies: 支持 key-value 映射形式", () => {
  const policies = parseCustomCachePolicies({
    custom_cache_policies: { "/x/*": 5, "/y/*": 10 },
  })
  assert.equal(policies.length, 2)
  const byPath = Object.fromEntries(
    policies.map((p) => [p.path, p.cacheExpiration]),
  )
  assert.equal(byPath["/x/*"], 5)
  assert.equal(byPath["/y/*"], 10)
})

test("custom_cache_policies: 空值與非法輸入返回空數組而不拋錯", () => {
  assert.deepEqual(parseCustomCachePolicies({}), [])
  assert.deepEqual(parseCustomCachePolicies({ custom_cache_policies: "" }), [])
  assert.deepEqual(
    parseCustomCachePolicies({ custom_cache_policies: "not-json" }),
    [],
  )
})

// ---- glob 匹配 ----

test("matchGlob: 單個 * 不跨目錄分隔符", () => {
  assert.equal(matchGlob("/photos/*", "/photos/a.jpg"), true)
  assert.equal(matchGlob("/photos/*", "/photos/sub/a.jpg"), false)
})

test("matchGlob: ** 可跨目錄分隔符", () => {
  assert.equal(matchGlob("/photos/**", "/photos/sub/deep/a.jpg"), true)
  assert.equal(matchGlob("/**", "/any/thing"), true)
})

test("matchGlob: 精確匹配與 ? 通配", () => {
  assert.equal(matchGlob("/a/b.txt", "/a/b.txt"), true)
  assert.equal(matchGlob("/a/?.txt", "/a/b.txt"), true)
})

// ---- glob DoS 防護 ----

test("matchGlob: 超長模式被拒絕（長度上限）", () => {
  const huge = "/" + "a".repeat(5000)
  assert.equal(matchGlob(huge, "/a"), false)
})

test("matchGlob: 大量 ** 段仍能快速返回（不再依賴段數截斷）", () => {
  // 200 個 ** 段在語義上確實應匹配任意多級路徑；
  // 防護改由 DP 的 O(段數×段數) 複雜度和長度上限提供，
  // 這裡斷言結果正確且耗時可控。
  const pattern = "/" + "**/".repeat(200) + "z"
  const t0 = performance.now()
  const got = matchGlob(pattern, "/a/b/c/z")
  const elapsed = performance.now() - t0
  assert.equal(got, true)
  assert.ok(elapsed < 500, `耗時 ${elapsed.toFixed(1)}ms，疑似複雜度過高`)
})

test("matchGlob: 相鄰通配符摺疊後仍可正確匹配", () => {
  // 摺疊不應破壞語義：*** 等價於 **
  assert.equal(matchGlob("/a/**/b", "/a/x/y/b"), true)
  assert.equal(matchGlob("/a/*/b", "/a/x/b"), true)
  assert.equal(matchGlob("/a/*/b", "/a/x/y/b"), false)
})

test("matchGlob: 惡意回溯模式能在合理時間內返回（不掛起）", () => {
  // 關鍵迴歸：多個相鄰 .* 曾可能觸發災難性回溯。
  // 這裡斷言匹配失敗時的耗時可控，防止未來退化。
  const pattern = "/" + "**/".repeat(20) + "z"
  const target = "/" + "ab/".repeat(40) + "x"
  const t0 = performance.now()
  const result = matchGlob(pattern, target)
  const elapsed = performance.now() - t0
  assert.equal(result, false)
  assert.ok(
    elapsed < 1000,
    `glob 匹配耗時 ${elapsed.toFixed(1)}ms，疑似回溯失控`,
  )
})

test("matchGlob: 正常規則不受防護影響", () => {
  assert.equal(matchGlob("/photos/*", "/photos/a.jpg"), true)
  assert.equal(matchGlob("/photos/**", "/photos/a/b/c.jpg"), true)
  assert.equal(matchGlob("/data/**/*.log", "/data/a/b/c.log"), true)
})

// ---- 雙星 + 單星組合（雙回溯點回歸）----

test("matchGlob: 雙星後跟單星可正確回退", () => {
  // 關鍵迴歸：雙星先吞掉 /a/b，遇到單星不匹配時須退回雙星
  assert.equal(matchGlob("/data/**/*.log", "/data/a/b/c.log"), true)
  assert.equal(matchGlob("/data/**/*.log", "/data/c.log"), true)
  assert.equal(matchGlob("/x/**/*/y", "/x/a/b/c/y"), true)
  // 擴展名不匹配時必須為 false
  assert.equal(matchGlob("/data/**/*.log", "/data/a/b/c.txt"), false)
})

test("matchGlob: 單星不得跨目錄，雙星可以", () => {
  assert.equal(matchGlob("/a/*/b", "/a/x/b"), true)
  assert.equal(matchGlob("/a/*/b", "/a/x/y/b"), false)
  assert.equal(matchGlob("/a/**/b", "/a/x/y/b"), true)
  // 雙星可匹配 0 段
  assert.equal(matchGlob("/a/**/b", "/a/b"), true)
})

test("matchGlob: 僅由星號組成的段才跨級，混雜字符的段不跨級", () => {
  // `**b` 是段內通配（對齊 doublestar：只有整段為 ** 時才跨目錄）
  assert.equal(matchGlob("/a/**b", "/a/x/y/b"), false)
  assert.equal(matchGlob("/a/**b", "/a/xyb"), true)
  assert.equal(matchGlob("/a/*b", "/a/xyb"), true)
  assert.equal(matchGlob("/a/*b", "/a/x/yb"), false)
})

test("matchGlob: 通配符在開頭與結尾", () => {
  assert.equal(matchGlob("*.log", "a.log"), true)
  assert.equal(matchGlob("*.log", "a.txt"), false)
  assert.equal(matchGlob("/a/*", "/a/b"), true)
  assert.equal(matchGlob("/a/*", "/a/b/c"), false)
  assert.equal(matchGlob("/a/**", "/a/b/c"), true)
})

test("matchGlob: 目標已耗盡時模式剩餘必須全是星號", () => {
  assert.equal(matchGlob("/a/b*", "/a/b"), true)
  assert.equal(matchGlob("/a/b**", "/a/b"), true)
  assert.equal(matchGlob("/a/bc", "/a/b"), false)
  assert.equal(matchGlob("/a/b?d", "/a/b"), false)
})

test("matchGlob: 連續多個星號等價於雙星", () => {
  assert.equal(matchGlob("/a/***/b", "/a/x/y/b"), true)
  assert.equal(matchGlob("/a/*****/b", "/a/x/y/b"), true)
})

test("matchGlob: 空模式與空目標", () => {
  assert.equal(matchGlob("", "/a"), false)
  assert.equal(matchGlob("/a", ""), false)
})

// ---- 快取時長合成 ----

test("resolveCacheExpiration: 無自定義策略時使用儲存基礎值", () => {
  assert.equal(resolveCacheExpiration({ cache_expiration: 15 }, "/a/b.txt"), 15)
})

test("resolveCacheExpiration: 未配置時回退默認 30", () => {
  assert.equal(resolveCacheExpiration({}, "/a/b.txt"), 30)
})

test("resolveCacheExpiration: 命中規則時覆蓋基礎值，未命中用基礎值", () => {
  const storage = {
    cache_expiration: 30,
    custom_cache_policies: '[{"path":"/photos/*","cache_expiration":1440}]',
  }
  assert.equal(resolveCacheExpiration(storage, "/photos/a.jpg"), 1440)
  assert.equal(resolveCacheExpiration(storage, "/docs/a.txt"), 30)
})

test("resolveCacheExpiration: 規則值為 0 表示不快取", () => {
  const storage = {
    cache_expiration: 30,
    custom_cache_policies: '[{"path":"/tmp/*","cache_expiration":0}]',
  }
  assert.equal(resolveCacheExpiration(storage, "/tmp/x.bin"), 0)
})

test("resolveCacheExpiration: 多條規則命中時最後一條優先", () => {
  const storage = {
    custom_cache_policies:
      '[{"path":"/a/**","cache_expiration":10},{"path":"/a/b/*","cache_expiration":20}]',
  }
  assert.equal(resolveCacheExpiration(storage, "/a/b/c.txt"), 20)
})

test("resolveCacheExpiration: 非法或負數回退默認值", () => {
  assert.equal(resolveCacheExpiration({ cache_expiration: -5 }, "/a"), 30)
  assert.equal(resolveCacheExpiration({ cache_expiration: "abc" }, "/a"), 30)
})

// ---- 與代理決策協同 ----

test("proxy 決策: 默認驅動走 302", () => {
  const d = resolveProxyDecision({}, "onedrive", false)
  assert.equal(d.mode, "302_redirect")
  assert.equal(d.needsProxy, false)
})

test("proxy 決策: 開啟代理後 proxy_range 決定是否透傳 Range", () => {
  const storage = { webdav_policy: "native_proxy", proxy_range: true }
  const d = resolveProxyDecision(storage, "webdav", false)
  assert.equal(d.needsProxy, true)
  assert.equal(getProxyRange(storage), true)
})

test("down_proxy_url: 直接欄位與 addition 別名均可解析", () => {
  assert.equal(
    getDownProxyUrl({ down_proxy_url: "https://p.example.com/d?path=$path" }),
    "https://p.example.com/d?path=$path",
  )
  assert.equal(
    getDownProxyUrl({ addition: '{"down_proxy_url":"https://x/y"}' }),
    "https://x/y",
  )
  assert.equal(
    getDownProxyUrl({ addition: '{"proxy_url":"https://z/w"}' }),
    "https://z/w",
  )
  assert.equal(getDownProxyUrl({}), "")
})
