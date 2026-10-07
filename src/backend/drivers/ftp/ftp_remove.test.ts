import assert from "node:assert/strict"
import { test } from "node:test"
import { FTPDriver } from "./driver"

/**
 * 調用約定（src/backend/internal/op/storage.ts 的 removeItems/moveItems）：
 *
 *   await driver.remove(virtualPath, resolved.physical, [name])
 *   await driver.move(srcDir, dstDir, [name], srcPhys, dstPhys)
 *
 * 即 physicalPath / srcPhys / dstPhys 都是【目標項自身】的物理路徑（已含文件名），
 * driver 不得再把 name 拼接到路徑後面，否則會指向 `<item>/<name>`，
 * removeRecursive/rename 打到不存在的路徑 → 靜默失敗。
 *
 * Node v24 下 mock.module 不可用（需實驗標誌），且不調 init()（否則真連 TCP）：
 * 用注入私有 client 的方式（同 dropbox/driver.test.ts 先例），替換 driver.client
 * 為 fake 對象，全程不建立網路連接。隻影響本用例新建的 driver 實例，不汙染全局。
 */

function makeDriverWithFakeClient(calls: string[]): FTPDriver {
  const driver = new FTPDriver({
    address: "127.0.0.1:21",
    username: "u",
    password: "p",
  })
  ;(driver as any).client = {
    removeRecursive: async (p: string) => {
      calls.push(`rm ${p}`)
    },
    rename: async (s: string, d: string) => {
      calls.push(`mv ${s} -> ${d}`)
    },
  }
  return driver
}

test("FTP remove() 刪除項自身路徑，不拼接 name", async () => {
  const calls: string[] = []
  const driver = makeDriverWithFakeClient(calls)

  await driver.remove("/d/a.txt", "/d/a.txt", ["a.txt"])

  assert.deepEqual(
    calls,
    ["rm /d/a.txt"],
    "removeRecursive 應收到項自身路徑（fake 必須被調用，否則注入未生效）",
  )
  assert.ok(
    !calls.some((c) => c.includes("a.txt/a.txt")),
    `路徑不得出現二次拼接的 a.txt/a.txt，實際：${calls.join(", ")}`,
  )
})

test("FTP move() 把源/目標項自身路徑傳給 rename", async () => {
  const calls: string[] = []
  const driver = makeDriverWithFakeClient(calls)

  await driver.move("/d", "/d/bak", ["a.txt"], "/d/a.txt", "/d/bak/a.txt")

  assert.deepEqual(
    calls,
    ["mv /d/a.txt -> /d/bak/a.txt"],
    "rename 的兩個參數必須是源/目標項自身路徑（fake 必須被調用，否則注入未生效）",
  )
})
