import assert from "node:assert/strict"
import { test } from "node:test"
import { isDbShell } from "./db"

/**
 * 迴歸測試：寫前守衛的「空殼判定」。
 *
 * 背景（必須長期守護的約束）：
 *   讀取持久化儲存失敗時，loadDb() 會回退到默認（空）庫。歷史上
 *   ensureDefaultSettings() 會隱式 saveDb()，把這個空殼寫回儲存，導致真實配置
 *   被覆蓋、系統反覆回到「未初始化」——用戶看到的就是「資料庫被清空」。
 *
 *   saveDb() 現在依據 isDbShell() 判定是否為空殼，並拒絕在「不可信」狀態下寫入。
 *   因此 isDbShell() 的語義必須穩定：既不能把有資料的庫誤判為空殼（會阻斷正常寫入），
 *   也不能把空殼誤判為有資料（會讓守衛失效）。
 */

const FULL_DB = {
  settings: [{ key: "site_title", value: "My Cloud Drive" }],
  users: [
    { id: 1, username: "admin", role: 2, password: "hashed" },
    { id: 2, username: "guest", role: 1, password: "" },
  ],
  storages: [{ id: 1, mount_path: "/onedrive", driver: "onedrive" }],
  shares: [],
  metas: [],
  plugins: [],
}

test("isDbShell: 含儲存掛載的庫不是空殼", () => {
  assert.equal(isDbShell(FULL_DB), false)
})

test("isDbShell: 僅有管理員佔位用戶（未設密碼）的庫仍是空殼", () => {
  // defaultDb 自帶 admin/guest 佔位用戶且密碼為空，不能被誤判為「有資料的真實庫」。
  assert.equal(
    isDbShell({
      settings: [],
      users: [
        { id: 1, username: "admin", role: 2, password: "" },
        { id: 2, username: "guest", role: 1, password: "" },
      ],
      storages: [],
    }),
    true,
  )
})

test("isDbShell: 已設置密碼的用戶說明庫已初始化，不是空殼", () => {
  assert.equal(
    isDbShell({
      settings: [],
      users: [{ id: 1, username: "admin", role: 2, password: "hashed" }],
      storages: [],
    }),
    false,
  )
})

test("isDbShell: 僅有分享/元資料/插件的庫不是空殼", () => {
  assert.equal(isDbShell({ shares: [{ id: 1 }] }), false)
  assert.equal(isDbShell({ metas: [{ id: 1 }] }), false)
  assert.equal(isDbShell({ plugins: [{ id: 1 }] }), false)
})

test("isDbShell: 默認空庫（defaultDb 克隆）被判定為空殼", () => {
  // 與 loadDb() 的兜底分支形狀一致：各實體均為空數組。
  const shell = {
    settings: [{ key: "site_title", value: "OpenList" }],
    users: [],
    storages: [],
    shares: [],
    metas: [],
    plugins: [],
  }
  assert.equal(isDbShell(shell), true)
})

test("isDbShell: 空數組/純空對象的極端輸入視為空殼", () => {
  assert.equal(isDbShell({ settings: [], users: [], storages: [] }), true)
  assert.equal(isDbShell({}), true)
})

test("isDbShell: 非對象輸入視為空殼（防禦性）", () => {
  assert.equal(isDbShell(null), true)
  assert.equal(isDbShell(undefined), true)
  assert.equal(isDbShell("db"), true)
  assert.equal(isDbShell(123), true)
})

test("isDbShell: 已修改過設置（非默認值）的庫不算空殼", () => {
  // 用戶只改過設置、尚未添加任何掛載時，也不應被誤判為空殼而阻斷保存。
  const settingsOnly = {
    settings: [{ key: "site_title", value: "用戶自定義站點標題" }],
    users: [],
    storages: [],
    shares: [],
    metas: [],
    plugins: [],
  }
  assert.equal(isDbShell(settingsOnly), false)
})
