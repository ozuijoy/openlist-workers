import assert from "node:assert/strict"
import { test } from "node:test"
import { YandexDriver } from "./driver"

/**
 * 調用約定（src/backend/internal/op/storage.ts 的 removeItems/moveItems）：
 *
 *   const resolved = await resolvePath(`${dir}/${name}`)
 *   await driver.remove(virtualPath, resolved.physical, [name])
 *
 * physicalPath/srcPhys/dstPhys 是【目標項自身】的物理路徑（已含文件名），
 * 調用方恆傳單元素 names。driver 不得再把 name 拼到該路徑後面，否則
 * `?path=<item>/<name>` 指向不存在的對象 → DELETE 404 報錯，
 * move 的 from/path 源/目標錯位。
 *
 * 注意：路徑在 query 參數裡（不在 pathname），斷言必須讀 searchParams。
 */

type Call = { method: string; url: string }

/** 記錄請求，恆返回 2xx + application/json：
 *  401 會觸發 refreshToken() 聯網，content-type 決定 util 的解析分支 */
function mockYandex(calls: Call[]) {
  return async (input: any, init: any = {}) => {
    const url = String(typeof input === "string" ? input : input.url)
    calls.push({
      method: String(init.method || "GET").toUpperCase(),
      url,
    })
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
}

function withMock<T>(calls: Call[], fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = mockYandex(calls) as any
  return fn().finally(() => {
    globalThis.fetch = original
  })
}

function makeDriver() {
  // 測試不調用 init()，client 的 accessToken 為空；只要 mock 返回 2xx 就不會
  // 觸發 401 → refreshToken() 聯網。
  return new YandexDriver({
    refresh_token: "r",
    use_online_api: true,
  })
}

test("Yandex remove() 的 path query 為項自身路徑，不再拼一次 name", async () => {
  const calls: Call[] = []

  await withMock(calls, () =>
    makeDriver().remove("/d/a.txt", "/d/a.txt", ["a.txt"]),
  )

  const deletes = calls.filter((c) => c.method === "DELETE")
  assert.equal(
    deletes.length,
    1,
    `應恰好發出 1 次 DELETE 請求，實際 ${deletes.length}`,
  )
  const url = new URL(deletes[0].url)
  assert.equal(
    url.origin + url.pathname,
    "https://cloud-api.yandex.net/v1/disk/resources",
    `DELETE 應打到 /v1/disk/resources，實際 ${url.origin}${url.pathname}`,
  )
  const path = url.searchParams.get("path")
  assert.equal(
    path,
    "/d/a.txt",
    `path query 應為項自身路徑 /d/a.txt，實際 ${path}`,
  )
  assert.ok(
    !String(path).endsWith("/a.txt/a.txt"),
    "path query 不得出現二次拼接的 <item>/<name>",
  )
  assert.ok(
    calls.every((c) => !c.url.includes("api.oplist.org")),
    "不應觸發在線 renewapi 的 token 刷新請求",
  )
})

test("Yandex move() 的 from/path query 分別為源/目標項自身路徑", async () => {
  const calls: Call[] = []

  await withMock(calls, () =>
    makeDriver().move("/d", "/d/dst", ["a.txt"], "/d/a.txt", "/d/dst/a.txt"),
  )

  const moves = calls.filter((c) => c.method === "POST")
  assert.equal(
    moves.length,
    1,
    `應恰好發出 1 次 POST move 請求，實際 ${moves.length}`,
  )
  const url = new URL(moves[0].url)
  assert.equal(
    url.origin + url.pathname,
    "https://cloud-api.yandex.net/v1/disk/resources/move",
    `move 應打到 /v1/disk/resources/move，實際 ${url.origin}${url.pathname}`,
  )
  const from = url.searchParams.get("from")
  const path = url.searchParams.get("path")
  assert.equal(
    from,
    "/d/a.txt",
    `from query 應為源項自身路徑 /d/a.txt，實際 ${from}`,
  )
  assert.equal(
    path,
    "/d/dst/a.txt",
    `path query 應為目標項自身路徑 /d/dst/a.txt，實際 ${path}`,
  )
  assert.ok(
    !String(from).endsWith("/a.txt/a.txt"),
    "from query 不得出現二次拼接的 <item>/<name>",
  )
  assert.ok(
    !String(path).endsWith("/a.txt/a.txt"),
    "path query 不得出現二次拼接的 <item>/<name>",
  )
  assert.ok(
    calls.every((c) => !c.url.includes("api.oplist.org")),
    "不應觸發在線 renewapi 的 token 刷新請求",
  )
})
