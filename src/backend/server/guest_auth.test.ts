import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { getUserFromContext } from "./middlewares"
import { authRouter, hashPasswordSHA256 } from "./auth"
import { fsRouter } from "./fs"
import { publicRouter } from "./public"
import { rawRouter } from "./raw"
import { saveDb } from "../internal/model/db"

test("Security: getUserFromContext returns null when guest is deleted or disabled and no token is provided", async () => {
  // Setup DB with only admin (guest deleted)
  const env: any = {}
  const adminHash = await hashPasswordSHA256("admin123")
  const dbOnlyAdmin = {
    settings: [],
    users: [
      {
        id: 1,
        username: "admin",
        password: adminHash,
        role: 2,
        permission: 0,
        base_path: "/",
        disabled: false,
      },
    ],
    storages: [],
    shares: [],
  }
  await saveDb(dbOnlyAdmin, env)

  const dummyContextNoToken: any = {
    req: {
      header: (name: string) => undefined,
      query: (name: string) => undefined,
    },
    env,
  }

  const user = await getUserFromContext(dummyContextNoToken)
  assert.equal(user, null, "User should be null when guest account is deleted")

  // Setup DB with guest disabled
  const dbGuestDisabled = {
    settings: [],
    users: [
      {
        id: 1,
        username: "admin",
        password: adminHash,
        role: 2,
        permission: 0,
        base_path: "/",
        disabled: false,
      },
      {
        id: 2,
        username: "guest",
        password: "",
        role: 1,
        permission: 0,
        base_path: "/",
        disabled: true,
      },
    ],
    storages: [],
    shares: [],
  }
  await saveDb(dbGuestDisabled, env)

  const userDisabled = await getUserFromContext(dummyContextNoToken)
  assert.equal(
    userDisabled,
    null,
    "User should be null when guest account is disabled",
  )
})

test("Security: /api/me returns 401 when unauthenticated and guest is deleted or disabled", async () => {
  const env: any = {}
  const adminHash = await hashPasswordSHA256("admin123")
  await saveDb(
    {
      settings: [],
      users: [
        {
          id: 1,
          username: "admin",
          password: adminHash,
          role: 2,
          permission: 0,
          base_path: "/",
          disabled: false,
        },
      ],
      storages: [],
      shares: [],
    },
    env,
  )

  const app = new Hono()
  app.route("/api/me", authRouter)

  const res = await app.request("/api/me/me", {
    method: "GET",
  })
  assert.equal(res.status, 401, "Expected HTTP 401 for anonymous /api/me")
  const json: any = await res.json()
  assert.equal(json.code, 401)
})

test("Security: /api/public/settings returns allow_guest 'false' when guest is deleted or disabled", async () => {
  const env: any = {}
  await saveDb(
    {
      settings: [],
      users: [
        {
          id: 1,
          username: "admin",
          password: "xxx",
          role: 2,
          permission: 0,
          base_path: "/",
          disabled: false,
        },
      ],
      storages: [],
      shares: [],
    },
    env,
  )

  const app = new Hono()
  app.route("/api/public", publicRouter)

  const res = await app.request("/api/public/settings", {
    method: "GET",
  })
  assert.equal(res.status, 200)
  const json: any = await res.json()
  assert.equal(
    json.data.allow_guest,
    "false",
    "allow_guest must be false when guest user is deleted",
  )
})

test("Security: /api/fs/list returns 401 when unauthenticated and guest is deleted or disabled", async () => {
  const env: any = {}
  await saveDb(
    {
      settings: [],
      users: [
        {
          id: 1,
          username: "admin",
          password: "xxx",
          role: 2,
          permission: 0,
          base_path: "/",
          disabled: false,
        },
      ],
      storages: [],
      shares: [],
    },
    env,
  )

  const app = new Hono()
  app.route("/api/fs", fsRouter)

  const res = await app.request("/api/fs/list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "/" }),
  })
  assert.equal(res.status, 401, "Expected HTTP 401 for anonymous /api/fs/list")
  const json: any = await res.json()
  assert.equal(json.code, 401)
})

test("/raw/* is a public download endpoint when no sign is required (parity with Go)", async () => {
  const env: any = {}
  await saveDb(
    {
      // sign_all 關閉、link_expiration 未配置、無 metas → needSign() == false
      settings: [],
      users: [
        {
          id: 1,
          username: "admin",
          password: "xxx",
          role: 2,
          permission: 0,
          base_path: "/",
          disabled: false,
        },
      ],
      storages: [],
      shares: [],
    },
    env,
  )

  const app = new Hono()
  app.route("/raw", rawRouter)

  const res = await app.request("/raw/some/file.txt", {
    method: "GET",
  })

  // 對齊 Go server/router.go：/d/*path 與 /p/*path 僅掛了
  // PathParse + Down(sign.Verify) + downloadLimiter，沒有 Auth 中間件。
  // 因此在「無需簽名」的默認配置下，匿名請求不應被 401 攔截；
  // 由於測試庫中沒有該儲存，預期是路徑解析失敗（4xx/5xx，非 401）。
  //
  // 此前這裡斷言 401，編碼了與 Go 相反的行為：guest 存在時靠 guest 兜底
  // 掩蓋，guest 一禁用就導致列目錄/播放視頻全部 401。
  assert.notEqual(
    res.status,
    401,
    "Anonymous /raw/* must not be rejected with 401 when no sign is required",
  )
})

test("/raw/* returns 401 without sign when sign_all is enabled (parity with Go needSign)", async () => {
  const env: any = {}
  await saveDb(
    {
      settings: [{ key: "sign_all", value: "true" }],
      users: [
        {
          id: 1,
          username: "admin",
          password: "xxx",
          role: 2,
          permission: 0,
          base_path: "/",
          disabled: false,
        },
      ],
      storages: [],
      shares: [],
    },
    env,
  )

  const app = new Hono()
  app.route("/raw", rawRouter)

  const res = await app.request("/raw/some/file.txt", { method: "GET" })
  assert.equal(res.status, 401, "sign_all enabled must require a valid sign")
})
