import assert from "node:assert/strict"
import { test } from "node:test"
import { DropboxDriver } from "./driver"

/**
 * 調用約定（src/backend/internal/op/storage.ts 的 removeItems/moveItems）：
 *
 *   const resolved = await resolvePath(`${dir}/${name}`)
 *   await driver.remove(virtualPath, resolved.physical, [name])
 *
 * 即 physicalPath/srcPhys/dstPhys 是【目標項自身】的物理路徑（已含文件名），
 * 調用方恆傳單元素 names。driver 不得再把 name 拼到該路徑後面，否則 body.path
 * 變成 `<item>/<name>`：delete_v2/move_v2 找不到該路徑 → 404 報錯，
 * 目標項既沒被刪除也沒被移動。
 */

type Call = { method: string; url: string; body: string }

/** 記錄請求，恆返回 200 + application/json（util.request 走 res.json() 分支） */
function mockDropbox(calls: Call[]) {
  return async (input: any, init: any = {}) => {
    const url = String(typeof input === "string" ? input : input.url)
    calls.push({
      method: String(init.method || "GET").toUpperCase(),
      url,
      body: typeof init.body === "string" ? init.body : "",
    })
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
}

function withMock<T>(calls: Call[], fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = mockDropbox(calls) as any
  return fn().finally(() => {
    globalThis.fetch = original
  })
}

function makeDriver() {
  // access_token 必填：util.request 發現無 token 會先聯網 refreshToken()，
  // 測試不調用 init()，也不允許出現 oauth2/token 請求。
  return new DropboxDriver({
    access_token: "tok",
    refresh_token: "r",
    client_id: "id",
    client_secret: "sec",
  })
}

test("Dropbox remove() 刪除項自身路徑，不再拼一次 name", async () => {
  const calls: Call[] = []

  await withMock(calls, () =>
    makeDriver().remove("/d/a.txt", "/d/a.txt", ["a.txt"]),
  )

  const deletes = calls.filter(
    (c) => c.url === "https://api.dropboxapi.com/2/files/delete_v2",
  )
  assert.equal(
    deletes.length,
    1,
    `應恰好發出 1 次 files/delete_v2 請求，實際 ${deletes.length}`,
  )
  const body = JSON.parse(deletes[0].body)
  assert.equal(
    body.path,
    "/d/a.txt",
    `delete 的 path 應為項自身路徑 /d/a.txt，實際 ${body.path}`,
  )
  assert.ok(
    !String(body.path).endsWith("/a.txt/a.txt"),
    "path 不得出現二次拼接的 <item>/<name>",
  )
  assert.ok(
    calls.every((c) => !c.url.includes("/oauth2/token")),
    "已帶 access_token，不應觸發 token 刷新請求",
  )
})

test("Dropbox move() 的 from_path/to_path 分別為源/目標項自身路徑", async () => {
  const calls: Call[] = []

  await withMock(calls, () =>
    makeDriver().move("/d", "/d/dst", ["a.txt"], "/d/a.txt", "/d/dst/a.txt"),
  )

  const moves = calls.filter(
    (c) => c.url === "https://api.dropboxapi.com/2/files/move_v2",
  )
  assert.equal(
    moves.length,
    1,
    `應恰好發出 1 次 files/move_v2 請求，實際 ${moves.length}`,
  )
  const body = JSON.parse(moves[0].body)
  assert.equal(
    body.from_path,
    "/d/a.txt",
    `from_path 應為源項自身路徑 /d/a.txt，實際 ${body.from_path}`,
  )
  assert.equal(
    body.to_path,
    "/d/dst/a.txt",
    `to_path 應為目標項自身路徑 /d/dst/a.txt，實際 ${body.to_path}`,
  )
  assert.ok(
    !String(body.from_path).endsWith("/a.txt/a.txt"),
    "from_path 不得出現二次拼接的 <item>/<name>",
  )
  assert.ok(
    !String(body.to_path).endsWith("/a.txt/a.txt"),
    "to_path 不得出現二次拼接的 <item>/<name>",
  )
  assert.ok(
    calls.every((c) => !c.url.includes("/oauth2/token")),
    "已帶 access_token，不應觸發 token 刷新請求",
  )
})
