import assert from "node:assert/strict"
import { test } from "node:test"
import { SFTPDriver } from "./driver"

/**
 * 調用約定（src/backend/internal/op/storage.ts 的 removeItems/moveItems）：
 *
 *   await driver.remove(virtualPath, resolved.physical, [name])
 *   await driver.move(srcDir, dstDir, [name], srcPhys, dstPhys)
 *
 * 即 physicalPath / srcPhys / dstPhys 都是【目標項自身】的物理路徑（已含文件名），
 * driver 不得再把 name 拼接到路徑後面，否則會指向 `<item>/<name>`，
 * lstat 查不到 → removeRecursive 靜默返回，介面報成功但文件仍在。
 *
 * Node v24 下 mock.module 不可用（需實驗標誌），且不調 init()（避免真連 SSH）：
 * 注入點是 SFTPClientWrapper.getSFTP() 首行的 sftpClient 快取（見 sftp/util.ts），
 * 把 fake sftp 對象掛上去，removeRecursive/rename 走的回調式方法全部命中 fake，不觸網。
 * 隻影響本用例新建的 driver 實例，不汙染全局。
 */

function makeDriverWithFakeSFTP(fake: any): SFTPDriver {
  const driver = new SFTPDriver({
    address: "127.0.0.1:22",
    username: "root",
    password: "x",
  })
  ;(driver as any).client["sftpClient"] = fake
  return driver
}

test("SFTP remove() 對項自身路徑調用 lstat/unlink，不拼接 name", async () => {
  const calls: string[] = []
  const driver = makeDriverWithFakeSFTP({
    lstat: (p: string, cb: any) => {
      calls.push(`lstat ${p}`)
      cb(null, { isDirectory: () => false })
    },
    readdir: (p: string, cb: any) => {
      calls.push(`readdir ${p}`)
      cb(null, [])
    },
    unlink: (p: string, cb: any) => {
      calls.push(`unlink ${p}`)
      cb(null)
    },
    rmdir: (p: string, cb: any) => {
      calls.push(`rmdir ${p}`)
      cb(null)
    },
  })

  await driver.remove("/d/a.txt", "/d/a.txt", ["a.txt"])

  assert.deepEqual(
    calls,
    ["lstat /d/a.txt", "unlink /d/a.txt"],
    "remove 應直接作用於項自身路徑（fake 必須被調用，否則注入未生效）",
  )
  assert.ok(
    !calls.some((c) => c.includes("a.txt/a.txt")),
    `路徑不得出現二次拼接的 a.txt/a.txt，實際：${calls.join(", ")}`,
  )
})

test("SFTP move() 把源/目標項自身路徑傳給 rename", async () => {
  const calls: string[] = []
  const driver = makeDriverWithFakeSFTP({
    rename: (a: string, b: string, cb: any) => {
      calls.push(`rename ${a} -> ${b}`)
      cb(null)
    },
  })

  await driver.move("/d", "/d/bak", ["a.txt"], "/d/a.txt", "/d/bak/a.txt")

  assert.deepEqual(
    calls,
    ["rename /d/a.txt -> /d/bak/a.txt"],
    "rename 的兩個參數必須是源/目標項自身路徑（fake 必須被調用，否則注入未生效）",
  )
})
