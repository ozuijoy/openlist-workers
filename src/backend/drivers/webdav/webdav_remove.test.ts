import assert from "node:assert/strict"
import { test } from "node:test"
import { WebdavDriver } from "./driver"

/**
 * 調用約定（src/backend/internal/op/storage.ts 的 removeItems/moveItems）：
 *
 *   const resolved = await resolvePath(`${dir}/${name}`)
 *   await driver.remove(virtualPath, resolved.physical, [name])
 *
 * physicalPath/srcPhys/dstPhys 是【目標項自身】的物理路徑（已含文件名），
 * 調用方恆傳單元素 names。driver 不得再把 name 拼到該路徑後面，否則
 * DELETE 打到 `<item>/<name>`（WebDAV 對 404 視作成功 → 介面報成功但對象仍在），
 * MOVE 的請求源與 Destination 頭源/目標也會錯位。
 *
 * 狀態碼坑：DELETE 返回 204（實現接受 200/204/404）；MOVE 返回 201（絕不能 409，
 * 409 會觸發 mkdirAll 重試鏈，產生額外請求干擾斷言）。
 */

type Call = { method: string; url: string; headers: Headers }

/** 記錄請求；DELETE 回 204、MOVE 回 201，其餘回 200 */
function mockWebdav(calls: Call[]) {
  return async (input: any, init: any = {}) => {
    const url = String(typeof input === "string" ? input : input.url)
    const method = String(init.method || "GET").toUpperCase()
    calls.push({ method, url, headers: new Headers(init.headers || {}) })
    if (method === "DELETE") {
      return new Response(null, { status: 204 })
    }
    if (method === "MOVE") {
      return new Response(null, { status: 201 })
    }
    return new Response(null, { status: 200 })
  }
}

function withMock<T>(calls: Call[], fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = mockWebdav(calls) as any
  return fn().finally(() => {
    globalThis.fetch = original
  })
}

function makeDriver(rootFolderPath?: string) {
  // 構造不聯網，測試不調用 init()；root_folder_path 缺省為 "/"
  return new WebdavDriver({
    address: "https://dav.example.com",
    username: "u",
    password: "p",
    ...(rootFolderPath ? { root_folder_path: rootFolderPath } : {}),
  })
}

test("Webdav remove() DELETE 目標為項自身路徑，不再拼一次 name", async () => {
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
  const pathname = decodeURIComponent(new URL(deletes[0].url).pathname)
  assert.equal(
    pathname,
    "/d/a.txt",
    `DELETE 目標應為項自身路徑 /d/a.txt，實際 ${pathname}`,
  )
  assert.ok(
    !pathname.includes("a.txt/a.txt"),
    "DELETE 目標不得出現二次拼接的 <item>/<name>",
  )
})

test("Webdav move() 請求源與 Destination 頭分別為源/目標項自身路徑", async () => {
  const calls: Call[] = []

  await withMock(calls, () =>
    makeDriver().move("/d", "/d/dst", ["a.txt"], "/d/a.txt", "/d/dst/a.txt"),
  )

  const moves = calls.filter((c) => c.method === "MOVE")
  assert.equal(
    moves.length,
    1,
    `應恰好發出 1 次 MOVE 請求，實際 ${moves.length}`,
  )
  const pathname = decodeURIComponent(new URL(moves[0].url).pathname)
  assert.equal(
    pathname,
    "/d/a.txt",
    `MOVE 請求 URL 應為源項自身路徑 /d/a.txt，實際 ${pathname}`,
  )
  assert.ok(
    !pathname.includes("a.txt/a.txt"),
    "MOVE 請求 URL 不得出現二次拼接的 <item>/<name>",
  )
  // Headers 不區分大小寫，get("destination") 與寫入時的 Destination 等價
  const destination = moves[0].headers.get("destination")
  assert.ok(destination, "MOVE 必須攜帶 Destination 頭")
  const destPathname = decodeURIComponent(new URL(destination).pathname)
  assert.equal(
    destPathname,
    "/d/dst/a.txt",
    `Destination 應指向目標項自身路徑 /d/dst/a.txt，實際 ${destination}`,
  )
  assert.ok(
    !destPathname.includes("a.txt/a.txt"),
    "Destination 不得出現二次拼接的 <item>/<name>",
  )
  assert.equal(
    calls.filter((c) => c.method === "MKCOL").length,
    0,
    "MOVE 返回 201 不應觸發 mkdirAll 重試鏈",
  )
})

test("Webdav root_folder_path 前綴僅拼一次（remove 與 move）", async () => {
  const removeCalls: Call[] = []

  await withMock(removeCalls, () =>
    makeDriver("/root").remove("/d/a.txt", "/d/a.txt", ["a.txt"]),
  )
  const removeDeletes = removeCalls.filter((c) => c.method === "DELETE")
  assert.equal(
    removeDeletes.length,
    1,
    `應恰好發出 1 次 DELETE 請求，實際 ${removeDeletes.length}`,
  )
  const removePath = decodeURIComponent(new URL(removeDeletes[0].url).pathname)
  assert.equal(
    removePath,
    "/root/d/a.txt",
    `DELETE 目標應為 <root>/<項路徑> = /root/d/a.txt，實際 ${removePath}`,
  )
  assert.ok(!removePath.includes("/root/root/"), "root 前綴不得被拼兩次")
  assert.ok(
    !removePath.includes("a.txt/a.txt"),
    "DELETE 目標不得出現二次拼接的 <item>/<name>",
  )

  const moveCalls: Call[] = []

  await withMock(moveCalls, () =>
    makeDriver("/root").move(
      "/d",
      "/d/dst",
      ["a.txt"],
      "/d/a.txt",
      "/d/dst/a.txt",
    ),
  )
  const rootMoves = moveCalls.filter((c) => c.method === "MOVE")
  assert.equal(
    rootMoves.length,
    1,
    `應恰好發出 1 次 MOVE 請求，實際 ${rootMoves.length}`,
  )
  const srcPath = decodeURIComponent(new URL(rootMoves[0].url).pathname)
  assert.equal(
    srcPath,
    "/root/d/a.txt",
    `MOVE 請求 URL 應為 <root>/<源項路徑> = /root/d/a.txt，實際 ${srcPath}`,
  )
  const destination = rootMoves[0].headers.get("destination")
  assert.ok(destination, "MOVE 必須攜帶 Destination 頭")
  const destPath = decodeURIComponent(new URL(destination).pathname)
  assert.equal(
    destPath,
    "/root/d/dst/a.txt",
    `Destination 應為 <root>/<目標項路徑> = /root/d/dst/a.txt，實際 ${destPath}`,
  )
  assert.ok(
    !srcPath.includes("/root/root/") && !destPath.includes("/root/root/"),
    "root 前綴不得被拼兩次",
  )
})
