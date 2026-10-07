import assert from "node:assert/strict"
import { test } from "node:test"
import { Onedrive } from "./driver"

/**
 * 調用約定（src/backend/internal/op/storage.ts 的 removeItems/moveItems）：
 *
 *   await driver.remove(virtualPath, resolved.physical, [name])
 *   await driver.move(srcDir, dstDir, [name], srcPhys, dstPhys)
 *
 * 即 physicalPath / srcPhys / dstPhys 都是【目標項自身】的物理路徑（已含文件名），
 * driver 不得再把 name 拼接到路徑後面，否則會指向 `<item>/<name>`：
 * DELETE 404 → 靜默失敗，對象仍然存在。
 *
 * 構造 `new Onedrive({})` 不聯網，不調 init()（fixture 沒有 refresh_token）；
 * 401 會觸發 refreshToken 真實聯網，所以 mock fetch 一律返回 2xx。
 */

type Call = { method: string; url: string; body?: string }

/** 按 (method, url) 分派的 Graph API mock，記錄所有請求以便斷言目標路徑 */
function mockGraph(calls: Call[]) {
  return async (input: any, init: any = {}) => {
    const url = new URL(String(typeof input === "string" ? input : input.url))
    const method = String(init.method || "GET").toUpperCase()
    calls.push({
      method,
      url: url.toString(),
      body: typeof init.body === "string" ? init.body : undefined,
    })

    // DELETE → 204 無 body；GET → 目標父目錄解析；PATCH → 更新項
    if (method === "DELETE") return new Response(null, { status: 204 })
    const json = JSON.stringify(
      method === "GET"
        ? { id: "parent-id", parentReference: { driveId: "d1" } }
        : {},
    )
    return new Response(json, {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
}

function withMock<T>(calls: Call[], fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = mockGraph(calls) as any
  return fn().finally(() => {
    globalThis.fetch = original
  })
}

test("OneDrive remove() 刪除目標項自身路徑，不拼接 name", async () => {
  const calls: Call[] = []

  await withMock(calls, () =>
    new Onedrive({}).remove("/d/a.txt", "/d/a.txt", ["a.txt"]),
  )

  const deletes = calls.filter((c) => c.method === "DELETE")
  assert.equal(
    deletes.length,
    1,
    `應恰好發出 1 次 DELETE，實際請求：${calls.map((c) => c.method).join(", ") || "(無)"}`,
  )
  assert.equal(
    deletes[0].url,
    "https://graph.microsoft.com/v1.0/me/drive/root:/d/a.txt:",
    "DELETE 必須指向項自身路徑（結尾裸冒號），即 physicalPath 本身",
  )
  const pathname = decodeURIComponent(new URL(deletes[0].url).pathname)
  assert.ok(
    !pathname.includes("a.txt/a.txt"),
    `路徑不得出現二次拼接的 a.txt/a.txt，實際：${pathname}`,
  )
})

test("OneDrive move() 先 GET 目標父目錄，再 PATCH 源項自身路徑", async () => {
  const calls: Call[] = []

  await withMock(calls, () =>
    new Onedrive({}).move(
      "/d",
      "/d/bak",
      ["a.txt"],
      "/d/a.txt",
      "/d/bak/a.txt",
    ),
  )

  const getIdx = calls.findIndex((c) => c.method === "GET")
  const patchIdx = calls.findIndex((c) => c.method === "PATCH")
  assert.ok(
    getIdx >= 0 && patchIdx >= 0,
    `move 應先 GET 目標父目錄再 PATCH 源項，實際請求：${calls.map((c) => c.method).join(", ") || "(無)"}`,
  )
  assert.ok(
    getIdx < patchIdx,
    "GET（解析目標父目錄）必須先於 PATCH（更新源項）",
  )

  const getPathname = decodeURIComponent(new URL(calls[getIdx].url).pathname)
  assert.equal(
    getPathname,
    "/v1.0/me/drive/root:/d/bak:",
    "GET 應指向 dstPhys 去掉末段後的目標父目錄",
  )

  const patchPathname = decodeURIComponent(
    new URL(calls[patchIdx].url).pathname,
  )
  assert.equal(
    patchPathname,
    "/v1.0/me/drive/root:/d/a.txt:",
    "PATCH 必須指向源項自身路徑（srcPhys），即結尾裸冒號",
  )
  assert.ok(
    !patchPathname.includes("a.txt/a.txt"),
    `PATCH 路徑不得出現二次拼接的 a.txt/a.txt，實際：${patchPathname}`,
  )

  const body = JSON.parse(calls[patchIdx].body || "{}")
  assert.equal(
    body.name,
    "a.txt",
    `PATCH body 的 name 應取 dstPhys 末段，實際：${body.name}`,
  )
  assert.equal(
    body.parentReference?.id,
    "parent-id",
    "PATCH body 應攜帶 GET 解析出的目標父目錄 id",
  )
})
