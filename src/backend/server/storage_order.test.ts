import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { listItems } from "../internal/op/storage"
import { saveDb } from "../internal/model/db"
import { adminRouter } from "./admin"

/**
 * 儲存「序號」（storage.order）必須真實生效 —— 對齊 Go：
 *
 * - 虛擬根目錄的掛載點順序：`op.getStorageVirtualFilesByPath`
 *     先按 `Order` 升序，`Order` 相同時按 `MountPath` 升序；
 * - 後台儲存列表：`internal/db.GetStorages`（`addStorageOrder` = `order, id`）。
 *
 * 此前 TS 兩處都直接沿用資料庫數組順序，後台改「序號」後排序完全不變。
 */

const storageRow = (
  id: number,
  mount: string,
  order: number,
  extra: Record<string, any> = {},
) => ({
  id,
  driver: "gen",
  mount_path: mount,
  addition: "{}",
  modified: "2026-01-01T00:00:00.000Z",
  disabled: false,
  order,
  ...extra,
})

const dbWith = (storages: any[], settings: any[] = []) => ({
  settings,
  users: [],
  storages,
  shares: [],
  metas: [],
})

test("根目錄掛載點按 storage.order 升序、同序號按 mount_path 升序", async () => {
  const env: any = {}
  await saveDb(
    dbWith([
      // 資料庫裡的順序刻意與 order 相反，確保測的是 order 而不是數組下標
      storageRow(11, "/c", 2),
      storageRow(12, "/a", 1),
      storageRow(13, "/b", 2),
    ]),
    env,
  )

  const { content } = await listItems("/", { env })
  assert.deepEqual(
    content.map((i) => i.name),
    ["a", "b", "c"],
  )
})

test("序號相同時按 mount_path 升序（不依賴 id / 插入順序）", async () => {
  const env: any = {}
  await saveDb(
    dbWith([
      storageRow(21, "/zzz", 0),
      storageRow(22, "/aaa", 0),
      storageRow(23, "/mmm", 0),
    ]),
    env,
  )

  const { content } = await listItems("/", { env })
  assert.deepEqual(
    content.map((i) => i.name),
    ["aaa", "mmm", "zzz"],
  )
})

test("被禁用的儲存不參與掛載點合併", async () => {
  const env: any = {}
  await saveDb(
    dbWith([
      storageRow(31, "/keep", 1),
      storageRow(32, "/gone", 2, { disabled: true }),
    ]),
    env,
  )

  const { content } = await listItems("/", { env })
  assert.deepEqual(
    content.map((i) => i.name),
    ["keep"],
  )
})

test("後台儲存列表按 order, id 升序返回（對齊 Go db.GetStorages）", async () => {
  const env: any = { }
  await saveDb(
    dbWith(
      [
        storageRow(42, "/b", 5),
        storageRow(41, "/a", 5),
        storageRow(43, "/c", 1),
      ],
      [{ key: "token", value: "admin-token" }],
    ),
    env,
  )

  const app = new Hono()
  app.route("/api/admin", adminRouter)
  const res = await app.request(
    "/api/admin/storage/list",
    { method: "GET", headers: { Authorization: "Bearer admin-token" } },
    env,
  )
  assert.equal(res.status, 200)
  const body: any = await res.json()
  assert.deepEqual(
    body.data.content.map((s: any) => s.mount_path),
    ["/c", "/a", "/b"],
  )
})
