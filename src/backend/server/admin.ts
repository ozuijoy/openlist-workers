import { Hono } from "hono"
import {
  getDb,
  saveDb,
  defaultDb,
  getKvStatus,
  getStoreStatus,
} from "../internal/model/db"
import { getDriver } from "../internal/op/storage"
import { search } from "../internal/op/search"
import { checkAdminAuth } from "../pkg/utils"
import { safeErrorMessage } from "../pkg/errs"
import { validateHide } from "../pkg/meta"
import {
  PROXY_RANGE_DRIVERS,
  driverMustProxy,
  driverPreferProxy,
  normalizeDriverName,
} from "../internal/driver/proxy"

export const adminRouter = new Hono()

adminRouter.use("*", async (c, next) => {
  // 統一走 checkAdminAuth：靜態 API token（settings.token）與 JWT 管理員
  // （role===2 且 DB 中存在未禁用用戶）都視為管理員。
  const isAdmin = await checkAdminAuth(c)
  if (!isAdmin) {
    return c.json({ code: 401, message: "Unauthorized", data: null })
  }
  await next()
})

// 生成密碼學安全的隨機 token（替代 Math.random）
function generateSecureToken(length = 32): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  const bytes = new Uint8Array(length)
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.getRandomValues === "function"
  ) {
    crypto.getRandomValues(bytes)
  } else {
    // 極端兜底（幾乎不會走到）：混入時間戳降低可預測性
    for (let i = 0; i < length; i++) {
      bytes[i] = ((Math.random() * 256) | 0) ^ (Date.now() & 0xff)
    }
  }
  let res = ""
  for (let i = 0; i < length; i++) {
    res += chars.charAt(bytes[i] % chars.length)
  }
  return res
}

adminRouter.get("/storage/list", async (c) => {
  const db = await getDb(c.env)
  // 排序對齊 Go internal/db.GetStorages（addStorageOrder = `order, id`）：
  // 後台儲存列表按「序號」升序、同序號按 id 升序，此前是按數組原始順序返回。
  const content = [...(db.storages || [])].sort((a: any, b: any) => {
    const orderA = Number(a.order) || 0
    const orderB = Number(b.order) || 0
    if (orderA !== orderB) return orderA - orderB
    return (Number(a.id) || 0) - (Number(b.id) || 0)
  })
  return c.json({
    code: 200,
    message: "success",
    data: { content, total: content.length },
  })
})

adminRouter.post("/storage/load_all", async (c) => {
  const db = await getDb(c.env)
  const results: any[] = []
  let loaded = 0
  let failed = 0

  for (const storage of db.storages || []) {
    if (storage.disabled) continue
    try {
      await getDriver(storage.driver, storage)
      loaded++
      results.push({
        id: storage.id,
        mount_path: storage.mount_path,
        driver: storage.driver,
        status: "ok",
      })
    } catch (e: any) {
      failed++
      results.push({
        id: storage.id,
        mount_path: storage.mount_path,
        driver: storage.driver,
        status: "failed",
        error: e?.message || String(e),
      })
    }
  }

  return c.json({
    code: 200,
    message: "success",
    data: { loaded, failed, results },
  })
})

adminRouter.get("/storage/get", async (c) => {
  const id = parseInt(c.req.query("id") || "0", 10)
  const db = await getDb(c.env)
  const storage = db.storages.find((s: any) => s.id === id)
  if (!storage) {
    return c.json({ code: 404, message: "storage not found", data: null })
  }
  return c.json({
    code: 200,
    message: "success",
    data: storage,
  })
})

export const normalizeDriver = (driverName: string): string => {
  const norm = (driverName || "").toLowerCase().replace(/[^a-z0-9]/g, "")
  if (!norm) return ""
  const available = Object.keys(driverConfigs)
  const matched = available.find(
    (d) =>
      d.toLowerCase() === norm ||
      d.toLowerCase().replace(/[^a-z0-9]/g, "") === norm,
  )
  if (matched) return matched
  // Common OpenList aliases
  if (norm.startsWith("115")) return "115Open"
  if (norm.startsWith("123")) return "123Pan"
  if (norm.includes("aliyun")) return "AliyundriveOpen"
  if (norm.startsWith("baidu")) return "BaiduNetdisk"
  if (
    norm.startsWith("189") ||
    norm.includes("cloud189") ||
    norm.includes("ctyun")
  )
    return "Cloud189"
  if (norm === "onedriveapp") return "OnedriveAPP"
  if (norm.startsWith("onedrive")) return "Onedrive"
  if (norm.startsWith("google") || norm.includes("gdrive")) return "GoogleDrive"
  if (
    (norm.includes("thunder") || norm.includes("xunlei")) &&
    norm.includes("expert")
  )
    return "ThunderExpert"
  if (norm.includes("thunder") || norm.includes("xunlei")) return "Thunder"
  if (norm === "webdav" || norm === "webdavdriver") return "WebDav"
  if (norm === "wopan" || norm.includes("unicom") || norm.includes("woyun"))
    return "WoPan"
  if (norm === "quark" || norm === "quarkuc" || norm === "uc") return "Quark"
  if (
    [
      "s3",
      "doge",
      "dogecloud",
      "minio",
      "ceph",
      "aws",
      "r2",
      "b2",
      "cos",
      "oss",
      "kodo",
    ].includes(norm)
  )
    return "S3"
  if (norm.startsWith("github")) return "Github"
  if (norm === "local") return "Local"
  if (norm.includes("pikpak")) return "PikPak"
  if (norm.includes("seafile")) return "Seafile"
  if (norm.includes("yandex")) return "YandexDisk"
  if (norm.includes("terabox") || norm.includes("dubox")) return "Terabox"
  if (norm.includes("mediatrack") || norm.includes("fenmiao"))
    return "MediaTrack"
  if (norm.includes("alias")) return "Alias"
  return driverName || ""
}

const ensureStorageAdditionDeviceId = (
  driverName: string,
  additionInput: any,
): string => {
  let additionStr = ""
  if (typeof additionInput === "object" && additionInput !== null) {
    try {
      additionStr = JSON.stringify(additionInput)
    } catch {
      additionStr = "{}"
    }
  } else {
    additionStr = String(additionInput || "{}")
  }
  const norm = (driverName || "").toLowerCase()
  if (norm.includes("thunder") || norm.includes("xunlei")) {
    try {
      const addition = JSON.parse(additionStr || "{}")
      if (
        !addition.device_id ||
        typeof addition.device_id !== "string" ||
        addition.device_id.trim().length !== 32
      ) {
        const rand32 =
          typeof crypto !== "undefined" &&
          typeof crypto.randomUUID === "function"
            ? crypto.randomUUID().replace(/-/g, "")
            : Math.random().toString(16).substring(2).padEnd(16, "0") +
              Math.random().toString(16).substring(2).padEnd(16, "0")
        addition.device_id = rand32.slice(0, 32)
        return JSON.stringify(addition)
      }
    } catch {}
  }
  return additionStr
}

adminRouter.post("/storage/create", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const db = await getDb(c.env)

  if (
    !body.driver ||
    typeof body.driver !== "string" ||
    body.driver.trim() === "" ||
    body.driver === "undefined" ||
    body.driver === "null"
  ) {
    return c.json(
      {
        code: 400,
        message: "Storage driver is required",
        data: null,
      },
      400,
    )
  }

  // mount_path 為空時用驅動配置的 default_mount_path 兜底，
  // 避免空路徑被規範化成 "/" 而與根掛載衝突
  let rawMount = body.mount_path
  if (!rawMount || String(rawMount).trim() === "") {
    const fallbackMount =
      driverConfigs[body.driver as string]?.default_mount_path
    if (fallbackMount) {
      rawMount = fallbackMount
    }
  }
  const mountPath =
    "/" +
    String(rawMount || "")
      .split("/")
      .filter(Boolean)
      .join("/")
  if (
    db.storages.some(
      (s: any) =>
        !s.disabled &&
        "/" + (s.mount_path || "").split("/").filter(Boolean).join("/") ===
          mountPath,
    )
  ) {
    return c.json({
      code: 400,
      message: `mount path already exists: ${mountPath}`,
      data: null,
    })
  }

  const normalizedDriver = normalizeDriver(body.driver)
  const newAddition = ensureStorageAdditionDeviceId(
    normalizedDriver,
    body.addition || "{}",
  )

  const newStorage = {
    ...body,
    driver: normalizedDriver,
    addition: newAddition,
    mount_path: mountPath,
    id: db.storages.length
      ? Math.max(...db.storages.map((s: any) => s.id)) + 1
      : 1,
    status: "work",
    modified: new Date().toISOString(),
  }

  // 先保存配置到 KV（防止網盤連接超時導致配置丟失）
  db.storages.push(newStorage)
  try {
    await saveDb(db, c.env)
  } catch (saveErr: any) {
    // KV 寫入失敗：回滾記憶體狀態，返回明確錯誤
    db.storages.pop()
    return c.json({
      code: 500,
      message: `Failed to save storage config: ${saveErr.message || String(saveErr)}`,
      data: null,
    })
  }

  // 再嘗試連接遠程網盤（不重複 init，getDriver 內部已經 init 過）
  if (!newStorage.disabled) {
    try {
      await getDriver(newStorage.driver, newStorage)
      newStorage.status = "work"
    } catch (e: any) {
      newStorage.status = e.message || String(e)
      // If driver is completely unsupported, disable storage to avoid crashing path resolution
      if (String(e.message || e).includes("unsupported driver")) {
        newStorage.disabled = true
      }
      // 更新狀態並重新保存
      try {
        await saveDb(db, c.env)
      } catch (saveErr: any) {
        console.error(
          "[admin/storage/create] Failed to update storage status:",
          saveErr,
        )
        // 狀態更新失敗不影響主流程，繼續返回
      }
      return c.json({
        code: 500,
        message: e.message || String(e),
        data: newStorage,
      })
    }
    // 連接成功，更新狀態
    try {
      await saveDb(db, c.env)
    } catch (saveErr: any) {
      console.error(
        "[admin/storage/create] Failed to update storage status after connection:",
        saveErr,
      )
      // 已經連接成功，狀態更新失敗不影響用戶，繼續返回成功
    }
  }

  return c.json({ code: 200, message: "success", data: newStorage })
})

adminRouter.post("/storage/update", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const db = await getDb(c.env)

  // 與 create 保持一致：空路徑用 default_mount_path 兜底
  let rawMount = body.mount_path
  if (!rawMount || String(rawMount).trim() === "") {
    const fallbackMount =
      driverConfigs[body.driver as string]?.default_mount_path
    if (fallbackMount) {
      rawMount = fallbackMount
    }
  }
  const mountPath =
    String(rawMount || "").trim() !== ""
      ? "/" +
        String(rawMount || "")
          .split("/")
          .filter(Boolean)
          .join("/")
      : undefined

  if (mountPath) {
    if (
      db.storages.some(
        (s: any) =>
          s.id !== body.id &&
          !s.disabled &&
          "/" + (s.mount_path || "").split("/").filter(Boolean).join("/") ===
            mountPath,
      )
    ) {
      return c.json({
        code: 400,
        message: `mount path already exists: ${mountPath}`,
        data: null,
      })
    }
  }

  const idx = db.storages.findIndex((s: any) => s.id === body.id)
  if (idx !== -1) {
    const rawDriver = body.driver || db.storages[idx].driver
    const normalizedDriver = normalizeDriver(rawDriver)
    const updatedAddition = ensureStorageAdditionDeviceId(
      normalizedDriver,
      body.addition !== undefined
        ? body.addition
        : db.storages[idx].addition || "{}",
    )

    const updatedStorage = {
      ...db.storages[idx],
      ...body,
      driver: normalizedDriver,
      addition: updatedAddition,
      mount_path: mountPath || db.storages[idx].mount_path,
      modified: new Date().toISOString(),
    }
    if (!updatedStorage.disabled) {
      try {
        // getDriver creates and initializes a cache miss. Calling init again
        // refreshes rotating credentials twice and persists the whole config
        // twice before the final update below.
        await getDriver(updatedStorage.driver, updatedStorage, {
          deferTokenPersistence: true,
        })
        updatedStorage.status = "work"
      } catch (e: any) {
        updatedStorage.status = e.message || String(e)
        if (String(e.message || e).includes("unsupported driver")) {
          updatedStorage.disabled = true
        }
        db.storages[idx] = updatedStorage
        await saveDb(db, c.env)
        return c.json({
          code: 500,
          message: e.message || String(e),
          data: { id: updatedStorage.id },
        })
      }
    }
    db.storages[idx] = updatedStorage
    await saveDb(db, c.env)
  }
  return c.json({ code: 200, message: "success", data: null })
})

adminRouter.post("/storage/delete", async (c) => {
  const id = parseInt(c.req.query("id") || "0", 10)
  const db = await getDb(c.env)
  db.storages = db.storages.filter((s: any) => s.id !== id)
  await saveDb(db, c.env)
  return c.json({ code: 200, message: "success", data: null })
})

adminRouter.post("/storage/enable", async (c) => {
  const id = parseInt(c.req.query("id") || "0", 10)
  const db = await getDb(c.env)
  const s = db.storages.find((s: any) => s.id === id)
  if (s) {
    s.disabled = false
    s.modified = new Date().toISOString()
    await saveDb(db, c.env)
    // 非同步初始化驅動（不阻塞響應）：啟用多個雲盤時立即返回，
    // 初始化完成後更新狀態；失敗時把錯誤寫入 status，下次訪問或
    // 重新加載時會再次嘗試。
    ;(async () => {
      try {
        await getDriver(s.driver, s)
        const db2 = await getDb(c.env)
        const st = db2.storages.find((x: any) => x.id === id)
        if (st && !st.disabled) {
          st.status = "work"
          st.modified = new Date().toISOString()
          await saveDb(db2, c.env)
        }
      } catch (e: any) {
        const db3 = await getDb(c.env)
        const st = db3.storages.find((x: any) => x.id === id)
        if (st && !st.disabled) {
          st.status = e.message || String(e)
          await saveDb(db3, c.env)
        }
      }
    })()
  }
  return c.json({ code: 200, message: "success", data: null })
})

adminRouter.post("/storage/disable", async (c) => {
  const id = parseInt(c.req.query("id") || "0", 10)
  const db = await getDb(c.env)
  const s = db.storages.find((s: any) => s.id === id)
  if (s) {
    s.disabled = true
    await saveDb(db, c.env)
  }
  return c.json({ code: 200, message: "success", data: null })
})

adminRouter.get("/driver/names", (c) => {
  return c.json({
    code: 200,
    message: "success",
    data: [
      "AliyundriveOpen",
      "GoogleDrive",
      "Onedrive",
      "OnedriveAPP",
      "Quark",
      "123Pan",
      "BaiduNetdisk",
      "115Open",
      "GitHub API",
      "Thunder",
      "ThunderExpert",
      "189Cloud",
      "WoPan",
      "Lanzou",
      "WebDav",
      "S3",
      "Doge",
      "PikPak",
      "Seafile",
      "YandexDisk",
      "Terabox",
      "MediaTrack",
      "Alias",
      "Dropbox",
      "WPS",
      "139Yun",
      "Mega_nz",
      "115Share",
      "123PanShare",
      "AliyundriveShare",
      "OnedriveSharelink",
      "PikPakShare",
      "SMB",
      "Crypt",
      "Virtual",
      "AListV3",
      "UrlTree",
      "Strm",
      "AzureBlob",
      "USS",
      "Alidoc",
      "Emby",
      "BunnyStorage",
      "CloudflareImgbed",
      "GuangYaPan",
      "AutoIndex",
      "ProtonDrive",
    ],
  })
})

const BASE_FIELDS = [
  {
    name: "mount_path",
    type: "string",
    default: "",
    required: true,
  },
  {
    name: "order",
    type: "number",
    default: "0",
    required: false,
  },
  {
    name: "remark",
    type: "string",
    default: "",
    required: false,
  },
  {
    name: "cache_expiration",
    type: "number",
    default: "30",
    required: false,
    help: "目錄內容快取時長（分鐘）",
  },
]

/**
 * 路徑級快取覆蓋（對齊 Go model.Storage.CustomCachePolicies）。
 * 支持 JSON 數組：[{"path":"/photos/*","cache_expiration":1440}]
 * 或映射形式：{"/photos/*": 1440}
 */
const CUSTOM_CACHE_POLICIES_FIELD = {
  name: "custom_cache_policies",
  type: "text",
  default: "",
  required: false,
  help: '按路徑覆蓋快取時長，JSON 格式，如 [{"path":"/photos/*","cache_expiration":1440}]',
}

/** 儲存級簽名開關（對齊 Go common.IsStorageSignEnabled） */
const ENABLE_SIGN_FIELD = {
  name: "enable_sign",
  type: "bool",
  default: "false",
  required: true,
  help: "Enable signature validation for this storage",
}

/** 禁止目錄列表（對齊 Go model.Storage.DisableIndex） */
const DISABLE_INDEX_FIELD = {
  name: "disable_index",
  type: "bool",
  default: "false",
  required: false,
  help: "Disable directory listing for this storage",
}

/**
 * proxy_range（對齊 Go op/driver.go）：僅對聲明瞭 ProxyRangeOption 的驅動開放。
 *
 * 默認 true：透傳客戶端 Range 是默認行為（Go 的透明代理本就轉發客戶端請求頭，
 * 見 internal/net/serve.go 的 ProcessHeader），該欄位只在需要顯式關閉時使用。
 */
function buildProxyRangeField() {
  return {
    name: "proxy_range",
    type: "bool",
    default: "true",
    required: false,
    help: "Need to enable proxy",
  }
}

const WEB_PROXY_FIELD = {
  name: "web_proxy",
  type: "bool",
  default: "false",
  required: false,
}

const WEBDAV_POLICY_FIELD = {
  name: "webdav_policy",
  type: "select",
  options: "302_redirect,use_proxy_url,native_proxy",
  default: "302_redirect",
  required: false,
}

/**
 * 按 Go internal/op/driver.go 的規則構造代理相關表單項。
 *
 * 驅動能力（MustProxy / PreferProxy / ProxyRangeOption）**全部**由
 * internal/driver/proxy.ts 派生——那裡是驅動能力表的唯一真相（對齊
 * Go drivers 各驅動的 meta.go）。admin.ts 不再維護第二份 only_proxy/prefer 清單，
 * 避免兩處各自演化後與運行時決策不一致。
 *
 *   - MustProxy()   ：無 web_proxy / down_proxy_url，策略僅 use_proxy_url | native_proxy
 *   - DefaultProxy()：web_proxy 默認 true、策略默認 native_proxy（PreferProxy 驅動）
 *   - 其餘          ：web_proxy 默認 false、策略默認 302_redirect
 */
function buildProxyFields(driverKey = "") {
  const normKey = normalizeDriverName(driverKey)
  const rangeFields = PROXY_RANGE_DRIVERS.has(normKey)
    ? [buildProxyRangeField()]
    : []

  if (driverMustProxy(normKey)) {
    return [
      ...rangeFields,
      {
        ...WEBDAV_POLICY_FIELD,
        options: "use_proxy_url,native_proxy",
        default: "native_proxy",
      },
    ]
  }

  const preferProxy = driverPreferProxy(normKey)
  return [
    ...rangeFields,
    preferProxy
      ? { ...WEB_PROXY_FIELD, default: "true" }
      : { ...WEB_PROXY_FIELD },
    preferProxy
      ? { ...WEBDAV_POLICY_FIELD, default: "native_proxy" }
      : { ...WEBDAV_POLICY_FIELD },
  ]
}

const SEED_POLICY_FIELD = {
  name: "seed_policy",
  type: "select",
  options: "inherit,on,off",
  default: "inherit",
  required: true,
  help: "Override automatic transfer-seed generation for this storage",
}

/** 對齊 Go：down_proxy_url 對所有非 MustProxy 驅動開放；MustProxy 驅動不需要 */
const DOWN_PROXY_URL_FIELD = {
  name: "down_proxy_url",
  type: "string",
  default: "",
  required: false,
  help: "自定義下載代理地址（支持 $path 佔位符；留空則用本服務代理）",
}

const DISABLE_PROXY_SIGN_FIELD = {
  name: "disable_proxy_sign",
  type: "bool",
  default: "false",
  required: false,
  help: "Disable sign for Download proxy URL",
}

const COMMON_FIELDS = [
  ...BASE_FIELDS,
  CUSTOM_CACHE_POLICIES_FIELD,
  ENABLE_SIGN_FIELD,
  DISABLE_INDEX_FIELD,
  ...buildProxyFields(),
  DOWN_PROXY_URL_FIELD,
  DISABLE_PROXY_SIGN_FIELD,
  SEED_POLICY_FIELD,
]

const driverConfigs: Record<string, any> = {
  AliyundriveOpen: {
    name: "AliyundriveOpen",
    default_mount_path: "/aliyundrive",
    common: COMMON_FIELDS,
    additional: [
      {
        name: "refresh_token",
        type: "text",
        default: "",
        required: true,
        help: "true",
      },
      {
        name: "drive_type",
        type: "select",
        options: "resource,backup,default",
        default: "resource",
        required: true,
      },
      { name: "drive_id", type: "string", default: "", required: false },
      {
        name: "root_folder_id",
        type: "string",
        default: "root",
        required: true,
      },
      {
        name: "order_by",
        type: "select",
        options: "updated_at,name,size,created_at",
        default: "updated_at",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "DESC,ASC",
        default: "DESC",
        required: false,
      },
      {
        name: "api_url_address",
        type: "string",
        default: "https://api.oplist.org/alicloud/renewapi",
        required: false,
        help: "true",
      },
      {
        name: "alipan_type",
        type: "select",
        options: "alipanQR,alipanTV",
        default: "alipanQR",
        required: false,
      },
      { name: "client_id", type: "string", default: "", required: false },
      { name: "client_secret", type: "string", default: "", required: false },
      {
        name: "remove_way",
        type: "select",
        options: "trash,delete",
        default: "trash",
        required: false,
      },
    ],
    config: {
      name: "AliyundriveOpen",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "root",
    },
  },
  Onedrive: {
    name: "Onedrive",
    default_mount_path: "/onedrive",
    // 對齊 Go drivers/onedrive/meta.go：無 MustProxy/PreferProxy，
    // webdav_policy 默認 302_redirect（OneDrive 默認走直鏈）。
    common: [
      ...BASE_FIELDS,
      CUSTOM_CACHE_POLICIES_FIELD,
      ENABLE_SIGN_FIELD,
      DISABLE_INDEX_FIELD,
      ...buildProxyFields("Onedrive"),
      DOWN_PROXY_URL_FIELD,
      DISABLE_PROXY_SIGN_FIELD,
    ],
    additional: [
      {
        name: "root_folder_path",
        type: "string",
        default: "/",
        required: true,
      },
      {
        name: "region",
        type: "select",
        options: "global,cn,us,de",
        default: "global",
        required: true,
      },
      {
        name: "is_sharepoint",
        type: "bool",
        default: "false",
        required: false,
      },
      {
        name: "use_online_api",
        type: "bool",
        default: "true",
        required: false,
      },
      {
        name: "api_url_address",
        type: "string",
        default: "https://api.oplist.org/onedrive/renewapi",
        required: false,
      },
      { name: "client_id", type: "string", default: "", required: false },
      { name: "client_secret", type: "string", default: "", required: false },
      {
        name: "redirect_uri",
        type: "string",
        default: "https://api.oplist.org/onedrive/callback",
        required: true,
      },
      { name: "refresh_token", type: "string", default: "", required: true },
      { name: "site_id", type: "string", default: "", required: false },
      { name: "chunk_size", type: "number", default: "5", required: false },
      {
        name: "custom_host",
        type: "string",
        default: "",
        required: false,
        help: "true",
      },
      {
        name: "disable_disk_usage",
        type: "bool",
        default: "false",
        required: false,
        help: "true",
      },
      {
        name: "enable_direct_upload",
        type: "bool",
        default: "false",
        required: false,
        help: "true",
      },
      {
        name: "order_by",
        type: "select",
        options: "filename,modified_time,size",
        default: "filename",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "asc,desc",
        default: "asc",
        required: false,
      },
    ],
    config: {
      name: "Onedrive",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "/",
    },
  },
  OnedriveAPP: {
    name: "OnedriveAPP",
    default_mount_path: "/onedrive_app",
    // 同 Onedrive：默認 302_redirect
    common: [
      ...BASE_FIELDS,
      CUSTOM_CACHE_POLICIES_FIELD,
      ENABLE_SIGN_FIELD,
      DISABLE_INDEX_FIELD,
      ...buildProxyFields("OnedriveAPP"),
      DOWN_PROXY_URL_FIELD,
      DISABLE_PROXY_SIGN_FIELD,
    ],
    additional: [
      {
        name: "root_folder_path",
        type: "string",
        default: "/",
        required: true,
      },
      {
        name: "region",
        type: "select",
        options: "global,cn,us,de",
        default: "global",
        required: true,
      },
      { name: "client_id", type: "string", default: "", required: true },
      { name: "client_secret", type: "string", default: "", required: true },
      { name: "tenant_id", type: "string", default: "", required: true },
      { name: "email", type: "string", default: "", required: true },
      { name: "chunk_size", type: "number", default: "5", required: false },
      {
        name: "custom_host",
        type: "string",
        default: "",
        required: false,
        help: "true",
      },
      {
        name: "disable_disk_usage",
        type: "bool",
        default: "false",
        required: false,
        help: "true",
      },
      {
        name: "enable_direct_upload",
        type: "bool",
        default: "false",
        required: false,
        help: "true",
      },
      {
        name: "order_by",
        type: "select",
        options: "filename,modified_time,size",
        default: "filename",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "asc,desc",
        default: "asc",
        required: false,
      },
    ],
    config: {
      name: "OnedriveAPP",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "/",
    },
  },
  GoogleDrive: {
    name: "GoogleDrive",
    default_mount_path: "/google-drive",
    common: [
      ...BASE_FIELDS,
      CUSTOM_CACHE_POLICIES_FIELD,
      ENABLE_SIGN_FIELD,
      DISABLE_INDEX_FIELD,
      ...buildProxyFields("GoogleDrive"),
      DISABLE_PROXY_SIGN_FIELD,
      SEED_POLICY_FIELD,
    ],
    additional: [
      {
        name: "refresh_token",
        type: "text",
        default: "",
        required: true,
        help: "true",
      },
      {
        name: "root_folder_id",
        type: "string",
        default: "root",
        required: false,
      },
      {
        name: "order_by",
        type: "select",
        options: "folder,name,modifiedTime desc",
        default: "folder,name,modifiedTime desc",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "asc,desc",
        default: "asc",
        required: false,
      },
      {
        name: "api_url_address",
        type: "string",
        default: "https://api.alist.nn.ci/googledrive/token",
        required: false,
        help: "true",
      },
      {
        name: "use_online_api",
        type: "bool",
        default: "true",
        required: false,
      },
      { name: "client_id", type: "string", default: "", required: false },
      { name: "client_secret", type: "string", default: "", required: false },
      { name: "chunk_size", type: "number", default: "5", required: false },
    ],
    config: {
      name: "GoogleDrive",
      local_sort: true,
      only_local: false,
      only_proxy: true,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "root",
    },
  },
  Quark: {
    name: "Quark",
    default_mount_path: "/quark",
    common: COMMON_FIELDS,
    additional: [
      {
        name: "variant",
        type: "select",
        options: "Quark,UC",
        default: "Quark",
        required: true,
      },
      {
        name: "cookie",
        type: "text",
        default: "",
        required: true,
        help: "true",
      },
      {
        name: "root_folder_id",
        type: "string",
        default: "0",
        required: true,
      },
      {
        name: "order_by",
        type: "select",
        options: "none,file_type,file_name,updated_at",
        default: "none",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "asc,desc",
        default: "asc",
        required: false,
      },
      {
        name: "use_transcoding_address",
        type: "bool",
        default: "false",
        required: false,
      },
      {
        name: "only_list_video_file",
        type: "bool",
        default: "false",
        required: false,
      },
    ],
    config: {
      name: "Quark",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "0",
    },
  },
  "123Pan": {
    name: "123Pan",
    default_mount_path: "/123",
    // 對齊 Go drivers/123/meta.go：只有 PreferProxy（無 OnlyProxy）
    common: [
      ...BASE_FIELDS,
      CUSTOM_CACHE_POLICIES_FIELD,
      ENABLE_SIGN_FIELD,
      DISABLE_INDEX_FIELD,
      ...buildProxyFields("123Pan"),
      DISABLE_PROXY_SIGN_FIELD,
      SEED_POLICY_FIELD,
    ],
    additional: [
      {
        name: "username",
        type: "string",
        default: "",
        required: true,
      },
      {
        name: "password",
        type: "string",
        default: "",
        required: true,
      },
      {
        name: "access_token",
        type: "string",
        default: "",
        required: false,
        help: "登入令牌（可選，自動持久化，無需手動填寫）。僅需填寫上方 123 網盤手機號和密碼，登入後自動獲取並保存，跳過重複登入可避免境外 IP 觸發風控。",
      },
      {
        name: "cookie",
        type: "text",
        default: "",
        required: false,
        help: "瀏覽器 Cookie（可選）。在 123 網盤網頁登入後，從開發者工具複製請求頭中的 Cookie 整串粘貼於此（含 sso-token），或從 Authorization: Bearer <token> 中複製 token/Bearer 值。解析出的 JWT 會作為 Bearer 令牌使用，效果等同訪問令牌，適合賬號密碼登入被風控攔截的環境。",
      },
      {
        name: "root_id",
        type: "string",
        default: "0",
        required: false,
      },
      {
        name: "upload_thread",
        type: "number",
        default: "3",
        required: false,
        help: "the threads of upload",
      },
      {
        name: "platform",
        type: "string",
        default: "web",
        required: false,
        help: "the platform header value, sent with API requests",
      },
      {
        name: "order_by",
        type: "select",
        options: "file_id,file_name,size,created_at,updated_at",
        default: "file_id",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "asc,desc",
        default: "desc",
        required: false,
      },
    ],
    config: {
      name: "123Pan",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "0",
    },
  },
  BaiduNetdisk: {
    name: "BaiduNetdisk",
    default_mount_path: "/baidu",
    // 對齊 Go drivers/baidu_netdisk/meta.go：只有 PreferProxy（無 OnlyProxy）
    common: [
      ...BASE_FIELDS,
      CUSTOM_CACHE_POLICIES_FIELD,
      ENABLE_SIGN_FIELD,
      DISABLE_INDEX_FIELD,
      ...buildProxyFields("BaiduNetdisk"),
      DISABLE_PROXY_SIGN_FIELD,
      SEED_POLICY_FIELD,
    ],
    additional: [
      {
        name: "refresh_token",
        type: "text",
        default: "",
        required: true,
        help: "true",
      },
      {
        name: "access_token",
        type: "string",
        default: "",
        required: true,
        help: "訪問令牌（必填）。通過 https://api.oplist.org/ 獲取。若令牌失效，掛載時會自動根據 refresh_token 通過在線 API 換新並持久化。",
      },
      {
        name: "use_online_api",
        type: "bool",
        default: "true",
        required: false,
        help: "使用在線 API 刷新 token（無需 ClientID/ClientSecret）",
      },
      {
        name: "api_url_address",
        type: "string",
        default: "https://api.oplist.org/baiduyun/renewapi",
        required: false,
      },
      {
        name: "client_id",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "client_secret",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "download_api",
        type: "select",
        options: "official,crack,crack_video",
        default: "official",
        required: false,
      },
      {
        name: "custom_crack_ua",
        type: "string",
        default: "netdisk",
        required: true,
      },
      {
        name: "order_by",
        type: "select",
        options: "name,time,size",
        default: "name",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "asc,desc",
        default: "asc",
        required: false,
      },
      {
        name: "only_list_video_file",
        type: "bool",
        default: "false",
        required: false,
      },
      {
        name: "upload_thread",
        type: "string",
        default: "3",
        required: false,
        help: "1<=thread<=32",
      },
      {
        name: "upload_timeout",
        type: "number",
        default: "60",
        required: false,
        help: "per-slice upload timeout in seconds",
      },
      {
        name: "custom_upload_part_size",
        type: "number",
        default: "0",
        required: false,
        help: "0 for auto",
      },
      {
        name: "use_dynamic_upload_api",
        type: "bool",
        default: "true",
        required: false,
        help: "dynamically get upload api domain, when enabled, the 'Upload API' setting will be used as a fallback if failed to get",
      },
      {
        name: "upload_api",
        type: "string",
        default: "https://d.pcs.baidu.com",
        required: false,
      },
      {
        name: "low_bandwith_upload_mode",
        type: "bool",
        default: "false",
        required: false,
      },
    ],
    config: {
      name: "BaiduNetdisk",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "/",
    },
  },
  "115Open": {
    name: "115Open",
    default_mount_path: "/115",
    // 對齊 Go drivers/115_open/meta.go：OnlyProxy（無 302 選項）
    common: [
      ...BASE_FIELDS,
      CUSTOM_CACHE_POLICIES_FIELD,
      ENABLE_SIGN_FIELD,
      DISABLE_INDEX_FIELD,
      ...buildProxyFields("115Open"),
      DISABLE_PROXY_SIGN_FIELD,
      SEED_POLICY_FIELD,
    ],
    additional: [
      {
        name: "access_token",
        type: "string",
        default: "",
        required: true,
        help: "訪問令牌（必填）。通過 115 開放平台獲取；失效時自動用 refresh_token 刷新並持久化。",
      },
      {
        name: "refresh_token",
        type: "string",
        default: "",
        required: true,
        help: "刷新令牌（必填）。通過 115 開放平台獲取；access_token 失效時自動刷新。",
      },
      {
        name: "root_id",
        type: "string",
        default: "0",
        required: false,
        help: "根文件夾 ID，默認 0（根目錄）",
      },
      {
        name: "order_by",
        type: "select",
        options: "file_name,file_size,user_utime,file_type",
        default: "file_name",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "asc,desc",
        default: "asc",
        required: false,
      },
      {
        name: "page_size",
        type: "number",
        default: "200",
        required: false,
        help: "list api per page size (1~1150)",
      },
      {
        name: "limit_rate",
        type: "float",
        default: "1",
        required: false,
        help: "limit all api request rate ([limit]r/1s)，0 表示不限速",
      },
    ],
    config: {
      name: "115Open",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "0",
    },
  },
  "GitHub API": {
    name: "GitHub API",
    default_mount_path: "/github",
    common: COMMON_FIELDS,
    additional: [
      {
        name: "root_folder_path",
        type: "string",
        default: "/",
        required: true,
      },
      { name: "token", type: "string", default: "", required: true },
      { name: "owner", type: "string", default: "", required: true },
      { name: "repo", type: "string", default: "", required: true },
      {
        name: "ref",
        type: "string",
        default: "",
        required: false,
        help: "A branch, a tag or a commit SHA, default branch by default.",
      },
      {
        name: "gh_proxy",
        type: "string",
        default: "",
        required: false,
        help: "GitHub proxy, e.g. https://ghproxy.net/raw.githubusercontent.com",
      },
      { name: "committer_name", type: "string", default: "", required: false },
      {
        name: "committer_email",
        type: "string",
        default: "",
        required: false,
      },
      { name: "author_name", type: "string", default: "", required: false },
      { name: "author_email", type: "string", default: "", required: false },
      {
        name: "mkdir_commit_message",
        type: "text",
        default: "{{.UserName}} mkdir {{.ObjPath}}",
        required: false,
      },
      {
        name: "delete_commit_message",
        type: "text",
        default: "{{.UserName}} remove {{.ObjPath}}",
        required: false,
      },
      {
        name: "put_commit_message",
        type: "text",
        default: "{{.UserName}} upload {{.ObjPath}}",
        required: false,
      },
      {
        name: "rename_commit_message",
        type: "text",
        default: "{{.UserName}} rename {{.ObjPath}} to {{.TargetName}}",
        required: false,
      },
      {
        name: "copy_commit_message",
        type: "text",
        default: "{{.UserName}} copy {{.ObjPath}} to {{.TargetPath}}",
        required: false,
      },
      {
        name: "move_commit_message",
        type: "text",
        default: "{{.UserName}} move {{.ObjPath}} to {{.TargetPath}}",
        required: false,
      },
      {
        name: "order_by",
        type: "select",
        options: "name,size,modified",
        default: "name",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "asc,desc",
        default: "asc",
        required: false,
      },
    ],
    config: {
      name: "GitHub API",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "/",
    },
  },
  Thunder: {
    name: "Thunder",
    default_mount_path: "/thunder",
    common: COMMON_FIELDS,
    additional: [
      { name: "root_folder_id", type: "string", default: "", required: false },
      { name: "username", type: "string", default: "", required: true },
      { name: "password", type: "string", default: "", required: true },
      { name: "captcha_token", type: "string", default: "", required: false },
      {
        name: "credit_key",
        type: "string",
        default: "",
        required: false,
        help: "credit key, used for login",
      },
      {
        name: "device_id",
        type: "string",
        default: "",
        required: false,
        help: "32 hex characters",
      },
      {
        name: "space",
        type: "string",
        default: "",
        required: false,
        help: "device id for remote device",
      },
      {
        name: "order_by",
        type: "select",
        options: "name,size,modified",
        default: "name",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "asc,desc",
        default: "asc",
        required: false,
      },
    ],
    config: {
      name: "Thunder",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "",
    },
  },
  ThunderExpert: {
    name: "ThunderExpert",
    default_mount_path: "/thunderexpert",
    common: COMMON_FIELDS,
    additional: [
      { name: "root_folder_id", type: "string", default: "", required: false },
      {
        name: "login_type",
        type: "select",
        options: "user,refresh_token",
        default: "user",
        required: true,
      },
      {
        name: "sign_type",
        type: "select",
        options: "algorithms,captcha_sign",
        default: "algorithms",
        required: true,
      },
      {
        name: "username",
        type: "string",
        default: "",
        required: false,
        help: "login type is user, this is required",
      },
      {
        name: "password",
        type: "string",
        default: "",
        required: false,
        help: "login type is user, this is required",
      },
      {
        name: "refresh_token",
        type: "string",
        default: "",
        required: false,
        help: "login type is refresh_token, this is required",
      },
      {
        name: "algorithms",
        type: "string",
        default:
          "9uJNVj/wLmdwKrJaVj/omlQ,Oz64Lp0GigmChHMf/6TNfxx7O9PyopcczMsnf,Eb+L7Ce+Ej48u,jKY0,ASr0zCl6v8W4aidjPK5KHd1Lq3t+vBFf41dqv5+fnOd,wQlozdg6r1qxh0eRmt3QgNXOvSZO6q/GXK,gmirk+ciAvIgA/cxUUCema47jr/YToixTT+Q6O,5IiCoM9B1/788ntB,P07JH0h6qoM6TSUAK2aL9T5s2QBVeY9JWvalf,+oK0AN",
        required: false,
      },
      { name: "captcha_sign", type: "string", default: "", required: false },
      { name: "timestamp", type: "string", default: "", required: false },
      { name: "captcha_token", type: "string", default: "", required: false },
      {
        name: "credit_key",
        type: "string",
        default: "",
        required: false,
        help: "credit key, used for login",
      },
      { name: "device_id", type: "string", default: "", required: false },
      {
        name: "client_id",
        type: "string",
        default: "",
        required: true,
        help: "迅雷開放平台 OAuth client_id（必填）。",
      },
      {
        name: "client_secret",
        type: "string",
        default: "",
        required: true,
        help: "迅雷開放平台 OAuth client_secret（必填）。",
      },
      {
        name: "client_version",
        type: "string",
        default: "8.31.0.9726",
        required: true,
      },
      {
        name: "package_name",
        type: "string",
        default: "com.xunlei.downloadprovider",
        required: true,
      },
      {
        name: "user_agent",
        type: "string",
        default:
          "ANDROID-com.xunlei.downloadprovider/8.31.0.9726 netWorkType/5G appid/40 deviceName/Xiaomi_M2004j7ac deviceModel/M2004J7AC OSVersion/12 protocolVersion/301 platformVersion/10 sdkVersion/512000 Oauth2Client/0.9 (Linux 4_14_186-perf-gddfs8vbb238b) (JAVA 0)",
        required: true,
      },
      {
        name: "download_user_agent",
        type: "string",
        default:
          "Dalvik/2.1.0 (Linux; U; Android 12; M2004J7AC Build/SP1A.210812.016)",
        required: true,
      },
      {
        name: "use_video_url",
        type: "bool",
        default: "false",
        required: false,
      },
      {
        name: "space",
        type: "string",
        default: "",
        required: false,
        help: "device id for remote device",
      },
      {
        name: "order_by",
        type: "select",
        options: "name,size,modified",
        default: "name",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "asc,desc",
        default: "asc",
        required: false,
      },
    ],
    config: {
      name: "ThunderExpert",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "",
    },
  },
  "189Cloud": {
    name: "189Cloud",
    default_mount_path: "/189",
    // 對齊 Go drivers/189/meta.go：OnlyProxy
    common: [
      ...BASE_FIELDS,
      CUSTOM_CACHE_POLICIES_FIELD,
      ENABLE_SIGN_FIELD,
      DISABLE_INDEX_FIELD,
      ...buildProxyFields("189Cloud"),
      DISABLE_PROXY_SIGN_FIELD,
      SEED_POLICY_FIELD,
    ],
    additional: [
      {
        name: "username",
        type: "string",
        default: "",
        required: true,
        help: "the phone number used to log in",
      },
      {
        name: "password",
        type: "string",
        default: "",
        required: true,
        help: "password for login",
      },
      {
        name: "cookie",
        type: "text",
        default: "",
        required: false,
        help: "Fill in the cookie if need captcha (若遇滑塊驗證碼或設備鎖，可在瀏覽器登入後複製 Cookie 填入)",
      },
      {
        name: "root_folder_id",
        type: "string",
        default: "-11",
        required: false,
        help: "根文件夾ID，默認為 -11（個人雲根目錄）",
      },
      {
        name: "order_by",
        type: "select",
        options: "lastOpTime,filename,fileSize",
        default: "lastOpTime",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "desc,asc",
        default: "desc",
        required: false,
      },
    ],
    config: {
      name: "189Cloud",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "-11",
    },
  },
  Lanzou: {
    name: "Lanzou",
    default_mount_path: "/lanzou",
    common: COMMON_FIELDS,
    additional: [
      {
        name: "type",
        type: "select",
        options: "cookie,account,url",
        default: "cookie",
        required: true,
      },
      {
        name: "account",
        type: "string",
        default: "",
        required: false,
        help: "賬號（手機號/UID），僅 account 模式需填寫",
      },
      {
        name: "password",
        type: "string",
        default: "",
        required: false,
        help: "密碼，僅 account 模式需填寫",
      },
      {
        name: "cookie",
        type: "text",
        default: "",
        required: false,
        help: "登入 Cookie（含 ylogin, phpdisk_info 等），cookie 模式需填寫；有效期約 15 天",
      },
      {
        name: "root_folder_id",
        type: "string",
        default: "-1",
        required: false,
        help: "根文件夾 ID / 分享 ID（個人盤默認 -1，分享鏈接填分享 ID 如 b00xxxx）",
      },
      {
        name: "share_password",
        type: "string",
        default: "",
        required: false,
        help: "提取碼 / 訪問密碼（無密碼留空）",
      },
      {
        name: "baseUrl",
        type: "string",
        default: "https://pc.woozooo.com",
        required: false,
        help: "基本 API 域名",
      },
      {
        name: "shareUrl",
        type: "string",
        default: "https://pan.lanzoui.com",
        required: false,
        help: "分享頁面解析域名",
      },
      {
        name: "user_agent",
        type: "string",
        default:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/142.0.0.0 OpenList/42",
        required: true,
        help: "發送給藍奏雲 API 與直鏈解析時攜帶的客戶端 User-Agent",
      },
      {
        name: "repair_file_info",
        type: "bool",
        default: "false",
        required: false,
        help: "通過 HEAD 請求修正文件精確大小與修改時間（WebDAV 推薦開啟）",
      },
      {
        name: "order_by",
        type: "select",
        options: "name,size,time",
        default: "name",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "asc,desc",
        default: "asc",
        required: false,
      },
    ],
    config: {
      name: "Lanzou",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "-1",
    },
  },
  WebDav: {
    name: "WebDav",
    default_mount_path: "/webdav",
    // 對齊 Go drivers/webdav/meta.go 的 PreferProxy: true：
    // web_proxy 默認 true、webdav_policy 默認 native_proxy。
    common: [
      ...BASE_FIELDS,
      CUSTOM_CACHE_POLICIES_FIELD,
      ENABLE_SIGN_FIELD,
      DISABLE_INDEX_FIELD,
      ...buildProxyFields("WebDav"),
      DOWN_PROXY_URL_FIELD,
      DISABLE_PROXY_SIGN_FIELD,
      SEED_POLICY_FIELD,
    ],
    additional: [
      {
        name: "vendor",
        type: "select",
        options: "other,sharepoint",
        default: "other",
        required: true,
      },
      {
        name: "address",
        type: "string",
        default: "",
        required: true,
      },
      {
        name: "username",
        type: "string",
        default: "",
        required: true,
      },
      {
        name: "password",
        type: "string",
        default: "",
        required: true,
      },
      {
        name: "root_folder_path",
        type: "string",
        default: "/",
        required: false,
      },
      {
        name: "tls_insecure_skip_verify",
        type: "bool",
        default: "false",
        required: false,
      },
      {
        name: "order_by",
        type: "select",
        options: "name,size,modified",
        default: "name",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "asc,desc",
        default: "asc",
        required: false,
      },
    ],
    config: {
      name: "WebDav",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "/",
    },
  },
  WoPan: {
    name: "WoPan",
    default_mount_path: "/wopan",
    common: COMMON_FIELDS,
    additional: [
      {
        name: "root_folder_id",
        type: "string",
        default: "0",
        required: false,
      },
      {
        name: "refresh_token",
        type: "text",
        default: "",
        required: true,
      },
      {
        name: "family_id",
        type: "string",
        default: "",
        required: false,
        help: "true",
      },
      {
        name: "sort_rule",
        type: "select",
        options: "name_asc,name_desc,time_asc,time_desc,size_asc,size_desc",
        default: "name_asc",
        required: false,
      },
      {
        name: "access_token",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "order_by",
        type: "select",
        options: "name,size,modified",
        default: "name",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "asc,desc",
        default: "asc",
        required: false,
      },
    ],
    config: {
      name: "WoPan",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "0",
      no_overwrite_upload: true,
    },
  },
  S3: {
    name: "S3",
    default_mount_path: "/s3",
    common: COMMON_FIELDS,
    additional: [
      {
        name: "root_folder_path",
        type: "string",
        default: "/",
        required: false,
      },
      {
        name: "bucket",
        type: "string",
        default: "",
        required: true,
      },
      {
        name: "endpoint",
        type: "string",
        default: "",
        required: true,
      },
      {
        name: "region",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "access_key_id",
        type: "string",
        default: "",
        required: true,
      },
      {
        name: "secret_access_key",
        type: "string",
        default: "",
        required: true,
      },
      {
        name: "session_token",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "custom_host",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "enable_custom_host_presign",
        type: "bool",
        default: "false",
        required: false,
      },
      {
        name: "sign_url_expire",
        type: "number",
        default: "4",
        required: false,
      },
      {
        name: "placeholder",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "force_path_style",
        type: "bool",
        default: "false",
        required: false,
      },
      {
        name: "list_object_version",
        type: "select",
        options: "v1,v2",
        default: "v1",
        required: false,
      },
      {
        name: "remove_bucket",
        type: "bool",
        default: "false",
        required: false,
        help: "true",
      },
      {
        name: "add_filename_to_disposition",
        type: "bool",
        default: "false",
        required: false,
        help: "true",
      },
      {
        name: "enable_direct_upload",
        type: "bool",
        default: "false",
        required: false,
      },
      {
        name: "direct_upload_host",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "user_agent",
        type: "string",
        default: "",
        required: false,
        help: "true",
      },
      {
        name: "order_by",
        type: "select",
        options: "name,size,modified",
        default: "name",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "asc,desc",
        default: "asc",
        required: false,
      },
    ],
    config: {
      name: "S3",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "/",
      check_status: true,
    },
  },
  Doge: {
    name: "Doge",
    default_mount_path: "/doge",
    common: COMMON_FIELDS,
    additional: [
      {
        name: "root_folder_path",
        type: "string",
        default: "/",
        required: false,
      },
      {
        name: "bucket",
        type: "string",
        default: "",
        required: true,
      },
      {
        name: "endpoint",
        type: "string",
        default: "",
        required: true,
      },
      {
        name: "region",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "access_key_id",
        type: "string",
        default: "",
        required: true,
      },
      {
        name: "secret_access_key",
        type: "string",
        default: "",
        required: true,
      },
      {
        name: "session_token",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "custom_host",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "enable_custom_host_presign",
        type: "bool",
        default: "false",
        required: false,
      },
      {
        name: "sign_url_expire",
        type: "number",
        default: "4",
        required: false,
      },
      {
        name: "placeholder",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "force_path_style",
        type: "bool",
        default: "false",
        required: false,
      },
      {
        name: "list_object_version",
        type: "select",
        options: "v1,v2",
        default: "v1",
        required: false,
      },
      {
        name: "remove_bucket",
        type: "bool",
        default: "false",
        required: false,
        help: "true",
      },
      {
        name: "add_filename_to_disposition",
        type: "bool",
        default: "false",
        required: false,
        help: "true",
      },
      {
        name: "enable_direct_upload",
        type: "bool",
        default: "false",
        required: false,
      },
      {
        name: "direct_upload_host",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "user_agent",
        type: "string",
        default: "",
        required: false,
        help: "true",
      },
      {
        name: "order_by",
        type: "select",
        options: "name,size,modified",
        default: "name",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "asc,desc",
        default: "asc",
        required: false,
      },
    ],
    config: {
      name: "Doge",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "/",
      check_status: true,
    },
  },
  WeiYun: {
    name: "WeiYun",
    default_mount_path: "/weiyun",
    // 對齊 Go drivers/weiyun/meta.go：OnlyProxy
    common: [
      ...BASE_FIELDS,
      CUSTOM_CACHE_POLICIES_FIELD,
      ENABLE_SIGN_FIELD,
      DISABLE_INDEX_FIELD,
      ...buildProxyFields("WeiYun"),
      DISABLE_PROXY_SIGN_FIELD,
      SEED_POLICY_FIELD,
    ],
    additional: [
      {
        name: "root_folder_id",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "cookies",
        type: "text",
        default: "",
        required: true,
      },
      {
        name: "order_by",
        type: "select",
        options: "name,size,updated_at",
        default: "name",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "asc,desc",
        default: "asc",
        required: false,
      },
      {
        name: "upload_thread",
        type: "string",
        default: "4",
        required: false,
        help: "4<=thread<=32",
      },
    ],
    config: {
      name: "WeiYun",
      local_sort: false,
      only_local: false,
      only_proxy: true,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "",
      check_status: true,
    },
  },
  SFTP: {
    name: "SFTP",
    default_mount_path: "/sftp",
    // 對齊 Go drivers/sftp/meta.go：OnlyProxy + NoLinkURL（無直鏈可 302）
    common: [
      ...BASE_FIELDS,
      CUSTOM_CACHE_POLICIES_FIELD,
      ENABLE_SIGN_FIELD,
      DISABLE_INDEX_FIELD,
      ...buildProxyFields("SFTP"),
      DISABLE_PROXY_SIGN_FIELD,
      SEED_POLICY_FIELD,
    ],
    additional: [
      {
        name: "address",
        type: "string",
        default: "",
        required: true,
        help: "SSH host:port (e.g. 127.0.0.1:22)",
      },
      {
        name: "username",
        type: "string",
        default: "",
        required: true,
      },
      {
        name: "password",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "private_key",
        type: "text",
        default: "",
        required: false,
      },
      {
        name: "passphrase",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "root_folder_path",
        type: "string",
        default: "/",
        required: false,
      },
      {
        name: "ignore_symlink_error",
        type: "bool",
        default: "false",
        required: false,
        help: "Ignore symlink error",
      },
    ],
    config: {
      name: "SFTP",
      local_sort: true,
      only_local: false,
      only_proxy: true,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "/",
      check_status: true,
      no_link_url: true,
    },
  },
  FTP: {
    name: "FTP",
    default_mount_path: "/ftp",
    // 對齊 Go drivers/ftp/meta.go：OnlyProxy + NoLinkURL
    common: [
      ...BASE_FIELDS,
      CUSTOM_CACHE_POLICIES_FIELD,
      ENABLE_SIGN_FIELD,
      DISABLE_INDEX_FIELD,
      ...buildProxyFields("FTP"),
      DISABLE_PROXY_SIGN_FIELD,
      SEED_POLICY_FIELD,
    ],
    additional: [
      {
        name: "address",
        type: "string",
        default: "",
        required: true,
        help: "FTP host:port (e.g. 127.0.0.1:21)",
      },
      {
        name: "username",
        type: "string",
        default: "",
        required: true,
      },
      {
        name: "password",
        type: "string",
        default: "",
        required: true,
      },
      {
        name: "encoding",
        type: "string",
        default: "utf-8",
        required: true,
        help: "Character encoding, e.g. utf-8, gbk, gb2312",
      },
      {
        name: "cwd_list",
        type: "bool",
        default: "false",
        required: false,
        help: "Enter directory before listing",
      },
      {
        name: "root_folder_path",
        type: "string",
        default: "/",
        required: false,
      },
    ],
    config: {
      name: "FTP",
      local_sort: true,
      only_local: false,
      only_proxy: true,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "/",
      check_status: true,
      no_link_url: true,
    },
  },
  PikPak: {
    name: "PikPak",
    default_mount_path: "/pikpak",
    common: COMMON_FIELDS,
    additional: [
      {
        name: "root_folder_id",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "username",
        type: "string",
        default: "",
        required: true,
      },
      {
        name: "password",
        type: "string",
        default: "",
        required: true,
      },
      {
        name: "platform",
        type: "select",
        options: "web,android,pc",
        default: "web",
        required: true,
      },
      {
        name: "refresh_token",
        type: "text",
        default: "",
        required: false,
      },
      {
        name: "captcha_token",
        type: "text",
        default: "",
        required: false,
      },
      {
        name: "device_id",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "disable_media_link",
        type: "bool",
        default: "true",
        required: false,
      },
      {
        name: "order_by",
        type: "select",
        options: "name,size,modified",
        default: "name",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "asc,desc",
        default: "asc",
        required: false,
      },
    ],
    config: {
      name: "PikPak",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "",
    },
  },
  Seafile: {
    name: "Seafile",
    default_mount_path: "/seafile",
    common: COMMON_FIELDS,
    additional: [
      {
        name: "address",
        type: "string",
        default: "",
        required: true,
      },
      {
        name: "username",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "password",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "token",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "repo_id",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "repo_pwd",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "root_folder_path",
        type: "string",
        default: "/",
        required: false,
      },
      {
        name: "order_by",
        type: "select",
        options: "name,size,modified",
        default: "name",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "asc,desc",
        default: "asc",
        required: false,
      },
    ],
    config: {
      name: "Seafile",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "/",
    },
  },
  YandexDisk: {
    name: "YandexDisk",
    default_mount_path: "/yandex",
    common: COMMON_FIELDS,
    additional: [
      {
        name: "refresh_token",
        type: "text",
        default: "",
        required: true,
      },
      {
        name: "root_folder_path",
        type: "string",
        default: "/",
        required: false,
      },
      {
        name: "use_online_api",
        type: "bool",
        default: "true",
        required: false,
      },
      {
        name: "api_url_address",
        type: "string",
        default: "https://api.oplist.org/yandexui/renewapi",
        required: false,
      },
      {
        name: "client_id",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "client_secret",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "order_by",
        type: "select",
        options: "name,path,created,modified,size",
        default: "name",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "asc,desc",
        default: "asc",
        required: false,
      },
    ],
    config: {
      name: "YandexDisk",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "/",
    },
  },
  Terabox: {
    name: "Terabox",
    default_mount_path: "/terabox",
    // 對齊 Go drivers/terabox/meta.go：OnlyProxy
    common: [
      ...BASE_FIELDS,
      CUSTOM_CACHE_POLICIES_FIELD,
      ENABLE_SIGN_FIELD,
      DISABLE_INDEX_FIELD,
      ...buildProxyFields("Terabox"),
      DISABLE_PROXY_SIGN_FIELD,
      SEED_POLICY_FIELD,
    ],
    additional: [
      {
        name: "cookie",
        type: "text",
        default: "",
        required: true,
      },
      {
        name: "download_api",
        type: "select",
        options: "official,crack",
        default: "official",
        required: false,
      },
      {
        name: "root_folder_path",
        type: "string",
        default: "/",
        required: false,
      },
      {
        name: "order_by",
        type: "select",
        options: "name,time,size",
        default: "name",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "asc,desc",
        default: "asc",
        required: false,
      },
    ],
    config: {
      name: "Terabox",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "/",
    },
  },
  MediaTrack: {
    name: "MediaTrack",
    default_mount_path: "/mediatrack",
    common: COMMON_FIELDS,
    additional: [
      {
        name: "access_token",
        type: "text",
        default: "",
        required: true,
      },
      {
        name: "project_id",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "root_folder_id",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "order_by",
        type: "select",
        options: "updated_at,title,size",
        default: "title",
        required: false,
      },
      {
        name: "order_desc",
        type: "bool",
        default: "false",
        required: false,
      },
    ],
    config: {
      name: "MediaTrack",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "",
    },
  },
  Alias: {
    name: "Alias",
    default_mount_path: "/alias",
    // 對齊 Go drivers/alias/meta.go：ProxyRangeOption
    common: [
      ...BASE_FIELDS,
      CUSTOM_CACHE_POLICIES_FIELD,
      ENABLE_SIGN_FIELD,
      DISABLE_INDEX_FIELD,
      ...buildProxyFields("Alias"),
      DOWN_PROXY_URL_FIELD,
      DISABLE_PROXY_SIGN_FIELD,
      SEED_POLICY_FIELD,
    ],
    additional: [
      {
        name: "paths",
        type: "text",
        default: "",
        required: true,
        help: "Newline-separated list of paths, e.g. /local or sub:/target",
      },
      {
        name: "read_conflict_policy",
        type: "select",
        options: "first,random,all",
        default: "first",
        required: false,
      },
      {
        name: "write_conflict_policy",
        type: "select",
        options:
          "disabled,first,deterministic,deterministic_or_all,all,all_strict",
        default: "disabled",
        required: false,
      },
      {
        name: "put_conflict_policy",
        type: "select",
        options:
          "disabled,first,deterministic,deterministic_or_all,all,all_strict,random,quota,quota_strict",
        default: "disabled",
        required: false,
      },
      {
        name: "order_by",
        type: "select",
        options: "name,size,modified",
        default: "name",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "asc,desc",
        default: "asc",
        required: false,
      },
    ],
    config: {
      name: "Alias",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: true,
      no_upload: false,
      need_ms: false,
      default_root: "/",
    },
  },
  Dropbox: {
    name: "Dropbox",
    default_mount_path: "/dropbox",
    common: COMMON_FIELDS,
    additional: [
      {
        name: "root_folder_path",
        type: "string",
        default: "/",
        required: false,
      },
      {
        name: "use_online_api",
        type: "bool",
        default: "false",
        required: false,
      },
      {
        name: "api_url_address",
        type: "string",
        default: "https://api.oplist.org/dropboxs/renewapi",
        required: false,
      },
      {
        name: "client_id",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "client_secret",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "refresh_token",
        type: "text",
        default: "",
        required: true,
      },
      {
        name: "root_namespace_id",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "order_by",
        type: "select",
        options: "name,size,modified",
        default: "name",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "asc,desc",
        default: "asc",
        required: false,
      },
    ],
    config: {
      name: "Dropbox",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "/",
    },
  },
  WPS: {
    name: "WPS",
    default_mount_path: "/wps",
    common: COMMON_FIELDS,
    additional: [
      {
        name: "root_folder_path",
        type: "string",
        default: "/",
        required: false,
      },
      {
        name: "cookie",
        type: "text",
        default: "",
        required: true,
      },
      {
        name: "mode",
        type: "select",
        options: "Personal,Business",
        default: "Personal",
        required: false,
      },
      {
        name: "custom_ua",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "order_by",
        type: "select",
        options: "name,size,modified",
        default: "name",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "asc,desc",
        default: "asc",
        required: false,
      },
    ],
    config: {
      name: "WPS",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "/",
    },
  },
  "139Yun": {
    name: "139Yun",
    default_mount_path: "/139",
    // 對齊 Go drivers/139/meta.go：ProxyRangeOption 且實例默認 ProxyRange = true
    common: [
      ...BASE_FIELDS,
      CUSTOM_CACHE_POLICIES_FIELD,
      ENABLE_SIGN_FIELD,
      DISABLE_INDEX_FIELD,
      ...buildProxyFields("139Yun"),
      DOWN_PROXY_URL_FIELD,
      DISABLE_PROXY_SIGN_FIELD,
      SEED_POLICY_FIELD,
    ],
    additional: [
      {
        name: "authorization",
        type: "text",
        default: "",
        required: true,
      },
      {
        name: "root_folder_id",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "type",
        type: "select",
        options: "personal_new,family,group,personal,share",
        default: "personal_new",
        required: false,
      },
      {
        name: "link_id",
        type: "text",
        default: "",
        required: false,
      },
      {
        name: "cloud_id",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "order_by",
        type: "select",
        options: "name,size,modified",
        default: "name",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "asc,desc",
        default: "asc",
        required: false,
      },
    ],
    config: {
      name: "139Yun",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "",
    },
  },
  Mega_nz: {
    name: "Mega_nz",
    default_mount_path: "/mega",
    // 對齊 Go drivers/mega/meta.go：OnlyProxy + NoLinkURL
    common: [
      ...BASE_FIELDS,
      CUSTOM_CACHE_POLICIES_FIELD,
      ENABLE_SIGN_FIELD,
      DISABLE_INDEX_FIELD,
      ...buildProxyFields("Mega_nz"),
      DISABLE_PROXY_SIGN_FIELD,
      SEED_POLICY_FIELD,
    ],
    additional: [
      {
        name: "email",
        type: "string",
        default: "",
        required: true,
      },
      {
        name: "password",
        type: "string",
        default: "",
        required: true,
      },
      {
        name: "two_fa_code",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "two_fa_secret",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "move_to_trash",
        type: "bool",
        default: "true",
        required: false,
      },
      {
        name: "order_by",
        type: "select",
        options: "name,size,modified",
        default: "name",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "asc,desc",
        default: "asc",
        required: false,
      },
    ],
    config: {
      name: "Mega_nz",
      local_sort: true,
      only_local: false,
      only_proxy: true,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "/",
    },
  },
  "115Share": {
    name: "115Share",
    default_mount_path: "/115_share",
    common: COMMON_FIELDS,
    additional: [
      {
        name: "share_code",
        type: "text",
        default: "",
        required: true,
      },
      {
        name: "receive_code",
        type: "text",
        default: "",
        required: true,
      },
      {
        name: "cookie",
        type: "text",
        default: "",
        required: false,
      },
      {
        name: "root_folder_id",
        type: "string",
        default: "0",
        required: false,
      },
      {
        name: "page_size",
        type: "number",
        default: "1000",
        required: false,
      },
      {
        name: "order_by",
        type: "select",
        options: "name,size,modified",
        default: "name",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "asc,desc",
        default: "asc",
        required: false,
      },
    ],
    config: {
      name: "115Share",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: true,
      need_ms: false,
      default_root: "0",
    },
  },
  "123PanShare": {
    name: "123PanShare",
    default_mount_path: "/123_share",
    // 對齊 Go drivers/123_share/meta.go：OnlyProxy + PreferProxy
    common: [
      ...BASE_FIELDS,
      CUSTOM_CACHE_POLICIES_FIELD,
      ENABLE_SIGN_FIELD,
      DISABLE_INDEX_FIELD,
      ...buildProxyFields("123PanShare"),
      DISABLE_PROXY_SIGN_FIELD,
      SEED_POLICY_FIELD,
    ],
    additional: [
      {
        name: "sharekey",
        type: "string",
        default: "",
        required: true,
      },
      {
        name: "sharepassword",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "accesstoken",
        type: "text",
        default: "",
        required: false,
      },
      {
        name: "root_folder_id",
        type: "string",
        default: "0",
        required: false,
      },
      {
        name: "order_by",
        type: "select",
        options: "name,size,modified",
        default: "name",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "asc,desc",
        default: "asc",
        required: false,
      },
    ],
    config: {
      name: "123PanShare",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: true,
      need_ms: false,
      default_root: "0",
    },
  },
  AliyundriveShare: {
    name: "AliyundriveShare",
    default_mount_path: "/aliyun_share",
    common: COMMON_FIELDS,
    additional: [
      {
        name: "share_id",
        type: "string",
        default: "",
        required: true,
      },
      {
        name: "share_pwd",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "root_folder_id",
        type: "string",
        default: "root",
        required: false,
      },
      {
        name: "order_by",
        type: "select",
        options: "name,size,updated_at,created_at",
        default: "name",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "ASC,DESC",
        default: "ASC",
        required: false,
      },
    ],
    config: {
      name: "AliyundriveShare",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: true,
      need_ms: false,
      default_root: "root",
    },
  },
  OnedriveSharelink: {
    name: "OnedriveSharelink",
    default_mount_path: "/onedrive_share",
    common: COMMON_FIELDS,
    additional: [
      {
        name: "url",
        type: "string",
        default: "",
        required: true,
      },
      {
        name: "password",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "order_by",
        type: "select",
        options: "name,size,modified",
        default: "name",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "asc,desc",
        default: "asc",
        required: false,
      },
    ],
    config: {
      name: "OnedriveSharelink",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: true,
      need_ms: false,
      default_root: "/",
    },
  },
  PikPakShare: {
    name: "PikPakShare",
    default_mount_path: "/pikpak_share",
    common: COMMON_FIELDS,
    additional: [
      {
        name: "share_id",
        type: "string",
        default: "",
        required: true,
      },
      {
        name: "share_pwd",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "platform",
        type: "select",
        options: "android,web,pc",
        default: "web",
        required: false,
      },
      {
        name: "root_folder_id",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "order_by",
        type: "select",
        options: "name,size,modified",
        default: "name",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "asc,desc",
        default: "asc",
        required: false,
      },
    ],
    config: {
      name: "PikPakShare",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: true,
      need_ms: false,
      default_root: "",
    },
  },
  SMB: {
    name: "SMB",
    default_mount_path: "/smb",
    // 對齊 Go drivers/smb/meta.go：OnlyProxy + NoLinkURL
    common: [
      ...BASE_FIELDS,
      CUSTOM_CACHE_POLICIES_FIELD,
      ENABLE_SIGN_FIELD,
      DISABLE_INDEX_FIELD,
      ...buildProxyFields("SMB"),
      DISABLE_PROXY_SIGN_FIELD,
      SEED_POLICY_FIELD,
    ],
    additional: [
      {
        name: "address",
        type: "string",
        default: "",
        required: true,
      },
      {
        name: "share_name",
        type: "string",
        default: "",
        required: true,
      },
      {
        name: "username",
        type: "string",
        default: "",
        required: true,
      },
      {
        name: "password",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "port",
        type: "number",
        default: "445",
        required: false,
      },
      {
        name: "root_folder_path",
        type: "string",
        default: "/",
        required: false,
      },
      {
        name: "order_by",
        type: "select",
        options: "name,size,modified",
        default: "name",
        required: false,
      },
      {
        name: "order_direction",
        type: "select",
        options: "asc,desc",
        default: "asc",
        required: false,
      },
    ],
    config: {
      name: "SMB",
      local_sort: true,
      only_local: false,
      only_proxy: true,
      no_cache: true,
      no_upload: false,
      need_ms: false,
      default_root: "/",
    },
  },
  Crypt: {
    name: "Crypt",
    default_mount_path: "/crypt",
    // 對齊 Go drivers/crypt/meta.go：OnlyProxy + NoLinkURL
    common: [
      ...BASE_FIELDS,
      CUSTOM_CACHE_POLICIES_FIELD,
      ENABLE_SIGN_FIELD,
      DISABLE_INDEX_FIELD,
      ...buildProxyFields("Crypt"),
      DISABLE_PROXY_SIGN_FIELD,
      SEED_POLICY_FIELD,
    ],
    additional: [
      {
        name: "remote_path",
        type: "string",
        default: "",
        required: true,
        help: "加密資料實際儲存的位置（另一個已掛載儲存的路徑，如 /aliyundrive/enc）",
      },
      {
        name: "password",
        type: "string",
        default: "",
        required: true,
        help: "主密碼（用於派生加密密鑰）",
      },
      {
        name: "salt",
        type: "string",
        default: "",
        required: false,
        help: "鹽（第二密碼）。可選但推薦，提高密鑰強度",
      },
      {
        name: "filename_encryption",
        type: "select",
        options: "off,standard,obfuscate",
        default: "off",
        required: true,
        help: "文件名加密方式。當前僅支持 off（文件名不加密，僅內容加密）",
      },
      {
        name: "directory_name_encryption",
        type: "select",
        options: "false,true",
        default: "false",
        required: true,
      },
      {
        name: "encrypted_suffix",
        type: "string",
        default: ".bin",
        required: true,
        help: "加密文件的後綴（高級選項）",
      },
      {
        name: "filename_encoding",
        type: "select",
        options: "base64,base32,base32768",
        default: "base64",
        required: true,
      },
      { name: "thumbnail", type: "bool", default: "false", required: false },
      { name: "show_hidden", type: "bool", default: "true", required: false },
    ],
    config: {
      name: "Crypt",
      local_sort: true,
      only_local: false,
      only_proxy: true,
      no_cache: true,
      no_upload: false,
      need_ms: false,
      default_root: "/",
      no_link_url: true,
      check_status: true,
    },
  },
  Virtual: {
    name: "Virtual",
    default_mount_path: "/virtual",
    // 對齊 Go drivers/virtual/meta.go：OnlyProxy + NoLinkURL
    common: [
      ...BASE_FIELDS,
      CUSTOM_CACHE_POLICIES_FIELD,
      ENABLE_SIGN_FIELD,
      DISABLE_INDEX_FIELD,
      ...buildProxyFields("Virtual"),
      DISABLE_PROXY_SIGN_FIELD,
      SEED_POLICY_FIELD,
    ],
    additional: [
      {
        name: "num_file",
        type: "number",
        default: "30",
        required: true,
        help: "每個目錄下生成的佔位文件數量",
      },
      {
        name: "num_folder",
        type: "number",
        default: "30",
        required: true,
        help: "每個目錄下生成的佔位目錄數量",
      },
      {
        name: "max_file_size",
        type: "number",
        default: "1073741824",
        required: true,
        help: "佔位文件最大字節數",
      },
      {
        name: "min_file_size",
        type: "number",
        default: "1048576",
        required: true,
        help: "佔位文件最小字節數",
      },
    ],
    config: {
      name: "Virtual",
      local_sort: true,
      only_local: false,
      only_proxy: true,
      no_cache: false,
      no_upload: false,
      need_ms: true,
      default_root: "/",
      no_link_url: true,
    },
  },
  AListV3: {
    name: "AListV3",
    default_mount_path: "/alist",
    // 對齊 Go drivers/alist_v3/meta.go：ProxyRangeOption
    common: [
      ...BASE_FIELDS,
      CUSTOM_CACHE_POLICIES_FIELD,
      ENABLE_SIGN_FIELD,
      DISABLE_INDEX_FIELD,
      ...buildProxyFields("AListV3"),
      DOWN_PROXY_URL_FIELD,
      DISABLE_PROXY_SIGN_FIELD,
      SEED_POLICY_FIELD,
    ],
    additional: [
      {
        name: "url",
        type: "string",
        default: "",
        required: true,
        help: "另一個 OpenList / AList 實例的地址，如 https://example.com",
      },
      { name: "meta_password", type: "string", default: "", required: false },
      { name: "username", type: "string", default: "", required: false },
      { name: "password", type: "string", default: "", required: false },
      {
        name: "token",
        type: "string",
        default: "",
        required: false,
        help: "訪問令牌（可選，自動持久化，無需手動填寫）",
      },
      {
        name: "pass_ip_to_upsteam",
        type: "bool",
        default: "true",
        required: false,
      },
      {
        name: "pass_ua_to_upsteam",
        type: "bool",
        default: "true",
        required: false,
      },
      {
        name: "forward_archive_requests",
        type: "bool",
        default: "true",
        required: false,
      },
    ],
    config: {
      name: "AListV3",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "/",
    },
  },
  UrlTree: {
    name: "UrlTree",
    default_mount_path: "/url_tree",
    common: COMMON_FIELDS,
    additional: [
      {
        name: "url_structure",
        type: "text",
        default: "",
        required: true,
        help: "URL 樹結構文本，每行縮進 2 空格表示一級。目錄行以 : 結尾，文件行格式 [FileName:][FileSize:][Modified:]Url",
      },
      {
        name: "head_size",
        type: "bool",
        default: "false",
        required: false,
        help: "用 HEAD 請求獲取文件大小（可能失敗）",
      },
      {
        name: "writable",
        type: "bool",
        default: "false",
        required: false,
        help: "允許增刪改文件樹（會持久化回 url_structure）",
      },
    ],
    config: {
      name: "UrlTree",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: true,
      no_upload: false,
      need_ms: false,
      default_root: "/",
      check_status: true,
    },
  },
  Strm: {
    name: "Strm",
    default_mount_path: "/strm",
    // 對齊 Go drivers/strm/meta.go：OnlyProxy + NoLinkURL
    common: [
      ...BASE_FIELDS,
      CUSTOM_CACHE_POLICIES_FIELD,
      ENABLE_SIGN_FIELD,
      DISABLE_INDEX_FIELD,
      ...buildProxyFields("Strm"),
      DISABLE_PROXY_SIGN_FIELD,
      SEED_POLICY_FIELD,
    ],
    additional: [
      {
        name: "paths",
        type: "text",
        default: "",
        required: true,
        help: "路徑映射，每行一個：虛擬名:底層路徑（如 movies:/aliyundrive/movies），或直接底層路徑",
      },
      {
        name: "siteUrl",
        type: "text",
        default: "",
        required: false,
        help: "strm 文件內容的 URL 前綴（留空則用相對路徑）",
      },
      {
        name: "PathPrefix",
        type: "text",
        default: "/d",
        required: false,
        help: "下載路徑前綴",
      },
      {
        name: "downloadFileTypes",
        type: "text",
        default: "ass,srt,vtt,sub,strm",
        required: false,
        help: "需原樣下載的文件擴展名（通常為字幕）",
      },
      {
        name: "filterFileTypes",
        type: "text",
        default:
          "mp4,mkv,flv,avi,wmv,ts,rmvb,webm,mp3,flac,aac,wav,ogg,m4a,wma,alac",
        required: false,
        help: "支持生成 strm 的文件擴展名（視頻/音頻）",
      },
      { name: "encodePath", type: "bool", default: "true", required: false },
      { name: "withoutUrl", type: "bool", default: "false", required: false },
      { name: "withSign", type: "bool", default: "false", required: false },
    ],
    config: {
      name: "Strm",
      local_sort: true,
      only_local: false,
      only_proxy: true,
      no_cache: true,
      no_upload: true,
      need_ms: false,
      default_root: "/",
      no_link_url: true,
    },
  },
  AzureBlob: {
    name: "AzureBlob",
    default_mount_path: "/azure",
    common: COMMON_FIELDS,
    additional: [
      {
        name: "endpoint",
        type: "string",
        default: "",
        required: true,
        help: "Azure 儲存端點，如 https://accountname.blob.core.windows.net/",
      },
      {
        name: "access_key",
        type: "string",
        default: "",
        required: true,
        help: "Azure 儲存訪問密鑰（Base64）",
      },
      {
        name: "container_name",
        type: "string",
        default: "",
        required: true,
        help: "容器名稱",
      },
      {
        name: "sign_url_expire",
        type: "number",
        default: "4",
        required: false,
        help: "SAS URL 有效期（小時）",
      },
    ],
    config: {
      name: "AzureBlob",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "/",
      check_status: true,
    },
  },
  USS: {
    name: "USS",
    default_mount_path: "/uss",
    common: COMMON_FIELDS,
    additional: [
      { name: "bucket", type: "string", default: "", required: true },
      {
        name: "endpoint",
        type: "string",
        default: "",
        required: true,
        help: "下載域名（可含協議頭）",
      },
      { name: "operator_name", type: "string", default: "", required: true },
      {
        name: "operator_password",
        type: "string",
        default: "",
        required: true,
      },
      {
        name: "anti_theft_chain_token",
        type: "string",
        default: "",
        required: false,
        help: "防盜鏈 Token（留空則用操作員密碼）",
      },
      {
        name: "sign_url_expire",
        type: "number",
        default: "4",
        required: false,
        help: "鏈接有效期（小時）",
      },
    ],
    config: {
      name: "USS",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "/",
    },
  },
  Alidoc: {
    name: "Alidoc",
    default_mount_path: "/alidoc",
    common: COMMON_FIELDS,
    additional: [
      {
        name: "cookie",
        type: "text",
        default: "",
        required: true,
        help: "釘釘文件網頁 Cookie",
      },
      {
        name: "root_folder_id",
        type: "string",
        default: "",
        required: true,
        help: "根目錄 dentryUuid",
      },
    ],
    config: {
      name: "Alidoc",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: true,
      need_ms: false,
      default_root: "",
    },
  },
  Emby: {
    name: "Emby",
    default_mount_path: "/emby",
    common: COMMON_FIELDS,
    additional: [
      {
        name: "url",
        type: "string",
        default: "",
        required: true,
        help: "Emby 伺服器地址，如 http://localhost:8096",
      },
      { name: "api_key", type: "string", default: "", required: false },
      { name: "user_id", type: "string", default: "", required: false },
      { name: "username", type: "string", default: "", required: false },
      { name: "password", type: "string", default: "", required: false },
      {
        name: "link_method",
        type: "select",
        options: "stream,download",
        default: "stream",
        required: false,
      },
      {
        name: "root_folder_id",
        type: "string",
        default: "1",
        required: false,
        help: "根目錄 ID，默認 1",
      },
    ],
    config: {
      name: "Emby",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: true,
      need_ms: false,
      default_root: "1",
    },
  },
  BunnyStorage: {
    name: "BunnyStorage",
    default_mount_path: "/bunny",
    common: COMMON_FIELDS,
    additional: [
      {
        name: "storage_zone_name",
        type: "string",
        default: "",
        required: true,
      },
      { name: "access_key", type: "string", default: "", required: true },
      {
        name: "endpoint",
        type: "string",
        default: "storage.bunnycdn.com",
        required: false,
      },
      { name: "cdn_base_url", type: "string", default: "", required: false },
      { name: "cdn_token_key", type: "string", default: "", required: false },
      {
        name: "cdn_token_method",
        type: "select",
        options: "sha256,hmac_sha256",
        default: "sha256",
        required: false,
      },
      {
        name: "cdn_token_include_ip",
        type: "bool",
        default: "false",
        required: false,
      },
      {
        name: "sign_url_expire",
        type: "number",
        default: "4",
        required: false,
        help: "鏈接有效期（小時）",
      },
      {
        name: "placeholder",
        type: "string",
        default: ".openlist",
        required: false,
      },
      {
        name: "root_folder_path",
        type: "string",
        default: "/",
        required: true,
      },
    ],
    config: {
      name: "BunnyStorage",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "/",
    },
  },
  CloudflareImgbed: {
    name: "CloudflareImgbed",
    default_mount_path: "/cfimgbed",
    common: COMMON_FIELDS,
    additional: [
      {
        name: "address",
        type: "string",
        default: "",
        required: true,
        help: "圖床服務地址",
      },
      { name: "token", type: "string", default: "", required: true },
      {
        name: "small_channel_name",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "large_channel_name",
        type: "string",
        default: "",
        required: false,
      },
      {
        name: "large_channel_type",
        type: "string",
        default: "",
        required: false,
      },
      { name: "upload_thread", type: "number", default: "3", required: false },
      {
        name: "root_folder_path",
        type: "string",
        default: "/",
        required: true,
      },
    ],
    config: {
      name: "CloudflareImgbed",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "/",
    },
  },
  GuangYaPan: {
    name: "GuangYaPan",
    default_mount_path: "/guangyapan",
    common: COMMON_FIELDS,
    additional: [
      { name: "client_id", type: "string", default: "", required: true },
      { name: "device_id", type: "string", default: "", required: false },
      { name: "device_sign", type: "string", default: "", required: false },
      { name: "access_token", type: "text", default: "", required: false },
      { name: "refresh_token", type: "text", default: "", required: false },
      {
        name: "phone_number",
        type: "string",
        default: "",
        required: false,
        help: "手機號（登入用，+86 格式）",
      },
      { name: "verify_code", type: "string", default: "", required: false },
      { name: "page_size", type: "number", default: "100", required: false },
      { name: "order_by", type: "number", default: "3", required: false },
      { name: "sort_type", type: "number", default: "1", required: false },
      {
        name: "root_folder_path",
        type: "string",
        default: "/",
        required: true,
      },
    ],
    config: {
      name: "GuangYaPan",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: false,
      need_ms: false,
      default_root: "/",
    },
  },
  AutoIndex: {
    name: "AutoIndex",
    default_mount_path: "/autoindex",
    common: COMMON_FIELDS,
    additional: [
      {
        name: "url",
        type: "string",
        default: "",
        required: true,
        help: "AutoIndex 目錄頁 URL",
      },
      {
        name: "item_xpath",
        type: "string",
        default: "//pre/a",
        required: true,
      },
      { name: "name_xpath", type: "string", default: "@href", required: true },
      {
        name: "modified_xpath",
        type: "string",
        default: "string(following-sibling::text()[2])",
        required: false,
      },
      {
        name: "size_xpath",
        type: "string",
        default: "string(following-sibling::text()[1])",
        required: false,
      },
      {
        name: "ignore_file_names",
        type: "text",
        default: ".\n..\nParent Directory\nUp",
        required: false,
      },
      {
        name: "modified_time_format",
        type: "string",
        default: "02-Jan-2006 15:04",
        required: false,
      },
    ],
    config: {
      name: "AutoIndex",
      local_sort: true,
      only_local: false,
      only_proxy: false,
      no_cache: false,
      no_upload: true,
      need_ms: false,
      default_root: "",
    },
  },
  ProtonDrive: {
    name: "ProtonDrive",
    default_mount_path: "/proton",
    // 對齊 Go drivers/proton_drive/meta.go：OnlyProxy + NoLinkURL
    common: [
      ...BASE_FIELDS,
      CUSTOM_CACHE_POLICIES_FIELD,
      ENABLE_SIGN_FIELD,
      DISABLE_INDEX_FIELD,
      ...buildProxyFields("ProtonDrive"),
      DISABLE_PROXY_SIGN_FIELD,
      SEED_POLICY_FIELD,
    ],
    additional: [
      {
        name: "email",
        type: "string",
        default: "",
        required: true,
        help: "Proton 賬號郵箱",
      },
      {
        name: "password",
        type: "string",
        default: "",
        required: true,
        help: "Proton 賬號密碼",
      },
      {
        name: "two_fa_code",
        type: "string",
        default: "",
        required: false,
        help: "兩步驗證碼（如已啟用 2FA）",
      },
      {
        name: "root_folder_id",
        type: "string",
        default: "root",
        required: false,
        help: "根文件夾 LinkID，默認 root 表示主共享根目錄",
      },
      {
        name: "chunk_size",
        type: "number",
        default: "4",
        required: false,
        help: "分塊大小（MB）",
      },
      {
        name: "use_reusable_login",
        type: "bool",
        default: "true",
        required: false,
      },
    ],
    config: {
      name: "ProtonDrive",
      local_sort: true,
      only_local: false,
      only_proxy: true,
      no_cache: false,
      no_upload: true,
      need_ms: false,
      default_root: "root",
    },
  },
}

adminRouter.get("/driver/list", (c) => {
  return c.json({
    code: 200,
    message: "success",
    data: driverConfigs,
  })
})

adminRouter.get("/driver/info", (c) => {
  const driverName = c.req.query("driver") || ""
  const info = driverConfigs[driverName] || driverConfigs["AliyundriveOpen"]
  return c.json({
    code: 200,
    message: "success",
    data: info,
  })
})

adminRouter.get("/setting/list", async (c) => {
  const db = await getDb(c.env)
  const groupQuery = c.req.query("group")
  const groupsQuery = c.req.query("groups")

  let settings = db.settings || []

  if (groupQuery !== undefined) {
    const groupNum = parseInt(groupQuery, 10)
    settings = settings.filter((s: any) => s.group === groupNum)
  } else if (groupsQuery !== undefined) {
    const groupNums = groupsQuery.split(",").map((g: string) => parseInt(g, 10))
    settings = settings.filter((s: any) => groupNums.includes(s.group))
  }

  return c.json({ code: 200, message: "success", data: settings })
})

adminRouter.post("/setting/save", async (c) => {
  const body = await c.req.json().catch(() => [])
  if (!Array.isArray(body)) {
    return c.json({ code: 400, message: "body must be an array", data: null })
  }
  const db = await getDb(c.env)
  if (!db.settings) {
    db.settings = []
  }
  for (const item of body) {
    // 僅接受已知欄位與基本類型，防止類型混淆 / 原型汙染 / 嵌套對象注入
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    const key = item.key
    if (typeof key !== "string" || key.length === 0 || key.length > 128)
      continue

    let value = item.value
    if (value !== null && typeof value === "object") {
      value = JSON.stringify(value)
    }

    const idx = db.settings.findIndex((s: any) => s.key === key)
    if (idx !== -1) {
      db.settings[idx].value = value
      if (typeof item.group === "number") {
        db.settings[idx].group = item.group
      }
    } else {
      db.settings.push({
        key,
        value,
        type: typeof item.type === "string" ? item.type : "string",
        help: typeof item.help === "string" ? item.help : "",
        group: typeof item.group === "number" ? item.group : 0,
        flag: typeof item.flag === "number" ? item.flag : 0,
      })
    }
  }

  // Deduplicate any duplicates by key
  const seenKeys = new Set<string>()
  db.settings = db.settings.filter((s: any) => {
    if (!s.key) return false
    if (seenKeys.has(s.key)) return false
    seenKeys.add(s.key)
    return true
  })

  await saveDb(db, c.env)
  return c.json({ code: 200, message: "success", data: null })
})

adminRouter.post("/setting/default", async (c) => {
  const groupQuery = c.req.query("group")
  if (groupQuery === undefined) {
    return c.json({ code: 400, message: "group is required", data: null })
  }
  const groupNum = parseInt(groupQuery, 10)
  const db = await getDb(c.env)

  db.settings = (db.settings || []).filter((s: any) => s.group !== groupNum)
  const groupDefaults = defaultDb.settings.filter(
    (s: any) => s.group === groupNum,
  )
  const groupKeys = new Set(groupDefaults.map((s: any) => s.key))
  db.settings = db.settings.filter((s: any) => !groupKeys.has(s.key))
  db.settings.push(...JSON.parse(JSON.stringify(groupDefaults)))

  await saveDb(db, c.env)
  return c.json({ code: 200, message: "success", data: groupDefaults })
})

adminRouter.post("/setting/delete", async (c) => {
  const key = c.req.query("key")
  if (!key) {
    return c.json({ code: 400, message: "key is required", data: null })
  }
  const db = await getDb(c.env)
  db.settings = (db.settings || []).filter((s: any) => s.key !== key)
  await saveDb(db, c.env)
  return c.json({ code: 200, message: "success", data: null })
})

const updateSettingValue = async (
  env: any,
  pairs: Record<string, string | undefined>,
  group = 14,
) => {
  const db = await getDb(env)
  if (!db.settings) {
    db.settings = []
  }
  for (const [k, v] of Object.entries(pairs)) {
    if (v === undefined) continue
    const idx = db.settings.findIndex((s: any) => s.key === k)
    if (idx !== -1) {
      db.settings[idx].value = v
    } else {
      db.settings.push({
        key: k,
        value: v,
        type: "string",
        help: k,
        group,
        flag: 0,
      })
    }
  }
  await saveDb(db, env)
}

adminRouter.post("/setting/set_115", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  await updateSettingValue(c.env, { "115_temp_dir": body.temp_dir || "" })
  return c.json({ code: 200, message: "success", data: "success" })
})

adminRouter.post("/setting/set_115_open", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  await updateSettingValue(c.env, { "115_open_temp_dir": body.temp_dir || "" })
  return c.json({ code: 200, message: "success", data: "success" })
})

adminRouter.post("/setting/set_123_pan", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  await updateSettingValue(c.env, {
    "123_pan_temp_dir": body.temp_dir || "",
    "123_temp_dir": body.temp_dir || "",
  })
  return c.json({ code: 200, message: "success", data: "success" })
})

adminRouter.post("/setting/set_123_open", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  await updateSettingValue(c.env, {
    "123_open_temp_dir": body.temp_dir || "",
    "123_open_callback_url": body.callback_url || "",
  })
  return c.json({ code: 200, message: "success", data: "success" })
})

adminRouter.post("/setting/set_pikpak", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  await updateSettingValue(c.env, { pikpak_temp_dir: body.temp_dir || "" })
  return c.json({ code: 200, message: "success", data: "success" })
})

adminRouter.post("/setting/set_thunder", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  await updateSettingValue(c.env, { thunder_temp_dir: body.temp_dir || "" })
  return c.json({ code: 200, message: "success", data: "success" })
})

adminRouter.post("/setting/set_thunder_browser", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  await updateSettingValue(c.env, {
    thunder_browser_temp_dir: body.temp_dir || "",
  })
  return c.json({ code: 200, message: "success", data: "success" })
})

adminRouter.post("/setting/set_thunderx", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  await updateSettingValue(c.env, { thunderx_temp_dir: body.temp_dir || "" })
  return c.json({ code: 200, message: "success", data: "success" })
})

adminRouter.post("/setting/reset_token", async (c) => {
  const newToken = generateSecureToken(32)
  await updateSettingValue(c.env, { token: newToken })
  // `token` 設置是鏈接/下載簽名密鑰（對應 Go 的 sign.Instance()），
  // 變更後舊的下載鏈接簽名立即失效——與 Go ResetToken 行為一致。
  //
  // 注意：JWT 密鑰來自 env.JWT_SECRET / 持久化的 openlist_jwt_secret，與這裡的
  // `token` 設置無關，所以清 JWT 快取**不會**讓已簽發的 JWT 失效；這裡調用只是
  // 讓進程內快取與最新的 env/持久化值保持一致。
  const { resetJwtSecretCache } = await import("./middlewares")
  resetJwtSecretCache()
  return c.json({ code: 200, message: "success", data: newToken })
})

adminRouter.get("/meta/list", async (c) => {
  const db = await getDb(c.env)
  const metas = db.metas || []
  return c.json({
    code: 200,
    message: "success",
    data: { content: metas, total: metas.length },
  })
})

adminRouter.get("/meta/get", async (c) => {
  const id = parseInt(c.req.query("id") || "0", 10)
  const db = await getDb(c.env)
  const meta = (db.metas || []).find((m: any) => m.id === id)
  if (!meta) {
    return c.json({ code: 404, message: "meta not found", data: null })
  }
  return c.json({ code: 200, message: "success", data: meta })
})

adminRouter.post("/meta/create", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const db = await getDb(c.env)
  if (!db.metas) db.metas = []

  const path =
    "/" +
    String(body.path || "")
      .split("/")
      .filter(Boolean)
      .join("/")
  if (!path || path === "/") {
    return c.json({ code: 400, message: "path is required", data: null })
  }
  if (db.metas.some((m: any) => m.path === path)) {
    return c.json({ code: 400, message: "meta already exists", data: null })
  }

  // 校驗 hide 正則合法性（對齊 Go handles/meta.go:71-80 validHide）
  const hide = String(body.hide || "")
  if (hide) {
    const invalidLine = validateHide(hide)
    if (invalidLine) {
      return c.json(
        {
          code: 400,
          message: `invalid hide regex: ${invalidLine}`,
          data: null,
        },
        400,
      )
    }
  }

  const newMeta = {
    id: db.metas.length ? Math.max(...db.metas.map((m: any) => m.id)) + 1 : 1,
    path,
    password: body.password || "",
    read_users: body.read_users || [],
    read_users_sub: !!body.read_users_sub,
    write_users: body.write_users || [],
    write_users_sub: !!body.write_users_sub,
    p_sub: !!body.p_sub,
    write: !!body.write,
    w_sub: !!body.w_sub,
    hide,
    h_sub: !!body.h_sub,
    readme: body.readme || "",
    r_sub: !!body.r_sub,
    header: body.header || "",
    header_sub: !!body.header_sub,
  }
  db.metas.push(newMeta)
  await saveDb(db, c.env)
  return c.json({ code: 200, message: "success", data: newMeta })
})

adminRouter.post("/meta/update", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const db = await getDb(c.env)
  if (!db.metas) db.metas = []

  const idx = db.metas.findIndex((m: any) => m.id === body.id)
  if (idx === -1) {
    return c.json({ code: 404, message: "meta not found", data: null })
  }

  const path =
    body.path !== undefined
      ? "/" + String(body.path).split("/").filter(Boolean).join("/")
      : db.metas[idx].path
  if (path && db.metas.some((m: any) => m.path === path && m.id !== body.id)) {
    return c.json({ code: 400, message: "meta already exists", data: null })
  }

  // 校驗 hide 正則合法性（對齊 Go handles/meta.go:71-80 validHide）
  const hide = body.hide !== undefined ? String(body.hide) : db.metas[idx].hide
  if (hide) {
    const invalidLine = validateHide(hide)
    if (invalidLine) {
      return c.json(
        {
          code: 400,
          message: `invalid hide regex: ${invalidLine}`,
          data: null,
        },
        400,
      )
    }
  }

  db.metas[idx] = {
    ...db.metas[idx],
    ...(path ? { path } : {}),
    password:
      body.password !== undefined ? body.password : db.metas[idx].password,
    read_users:
      body.read_users !== undefined
        ? body.read_users
        : db.metas[idx].read_users,
    read_users_sub:
      body.read_users_sub !== undefined
        ? !!body.read_users_sub
        : db.metas[idx].read_users_sub,
    write_users:
      body.write_users !== undefined
        ? body.write_users
        : db.metas[idx].write_users,
    write_users_sub:
      body.write_users_sub !== undefined
        ? !!body.write_users_sub
        : db.metas[idx].write_users_sub,
    p_sub: body.p_sub !== undefined ? !!body.p_sub : db.metas[idx].p_sub,
    write: body.write !== undefined ? !!body.write : db.metas[idx].write,
    w_sub: body.w_sub !== undefined ? !!body.w_sub : db.metas[idx].w_sub,
    hide: body.hide !== undefined ? body.hide : db.metas[idx].hide,
    h_sub: body.h_sub !== undefined ? !!body.h_sub : db.metas[idx].h_sub,
    readme: body.readme !== undefined ? body.readme : db.metas[idx].readme,
    r_sub: body.r_sub !== undefined ? !!body.r_sub : db.metas[idx].r_sub,
    header: body.header !== undefined ? body.header : db.metas[idx].header,
    header_sub:
      body.header_sub !== undefined
        ? !!body.header_sub
        : db.metas[idx].header_sub,
  }
  await saveDb(db, c.env)
  return c.json({ code: 200, message: "success", data: null })
})

adminRouter.post("/meta/delete", async (c) => {
  const id = parseInt(c.req.query("id") || "0", 10)
  const db = await getDb(c.env)
  if (!db.metas) db.metas = []
  db.metas = db.metas.filter((m: any) => m.id !== id)
  await saveDb(db, c.env)
  return c.json({ code: 200, message: "success", data: null })
})

import { userRouter } from "./user"
adminRouter.route("/user", userRouter)

adminRouter.get("/kv/status", async (c) => {
  const [statusData, storeStatus] = await Promise.all([
    getKvStatus(c.env),
    getStoreStatus(c.env),
  ])
  return c.json({
    code: 200,
    message: "success",
    data: { ...statusData, store: storeStatus },
  })
})

// --- Search Index / Scan ---
// Serverless 環境無常駐後台任務，索引構建為「請求內同步遍歷 + KV 快取」。
// 對大型儲存可能耗時較長（受 Worker CPU 時限約束），但中小型部署可用；
// 前端仍可實時搜索（search 函數遞歸遍歷），索引快取僅用於加速與進度展示。

function indexProgress(db: any) {
  const idx = db.search_index || {}
  return {
    obj_count: idx.total ?? 0,
    is_done: idx.is_done !== false,
    last_done_time: idx.updated_at || null,
    error: idx.error || "",
  }
}

// POST /api/admin/index/build — 全量重建索引（同步遍歷 /）
adminRouter.post("/index/build", async (c) => {
  try {
    const db = await getDb(c.env)
    const res = await search(
      { parent: "/", keywords: "", max_depth: 20, max_results: 2000 },
      c.env,
    )
    db.search_index = {
      items: res.content,
      total: res.total,
      is_done: true,
      updated_at: new Date().toISOString(),
      error: "",
    }
    await saveDb(db, c.env)
    return c.json({
      code: 200,
      message: "success",
      data: indexProgress(db),
    })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})

// POST /api/admin/index/update — 更新指定路徑索引
adminRouter.post("/index/update", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const paths: string[] = Array.isArray(body.paths) ? body.paths : ["/"]
    const maxDepth = Math.min(20, Math.max(0, Number(body.max_depth) || 20))
    const db = await getDb(c.env)
    const prev = db.search_index?.items || []
    // 移除舊索引中屬於這些路徑的條目，再重建
    const keep = prev.filter(
      (it: any) => !paths.some((p: string) => (it.parent || "/").startsWith(p)),
    )
    const res = await search(
      { parent: "/", keywords: "", max_depth: maxDepth, max_results: 2000 },
      c.env,
    )
    db.search_index = {
      items: [...keep, ...res.content],
      total: keep.length + res.total,
      is_done: true,
      updated_at: new Date().toISOString(),
      error: "",
    }
    await saveDb(db, c.env)
    return c.json({
      code: 200,
      message: "success",
      data: indexProgress(db),
    })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})

// POST /api/admin/index/stop — 無後台任務，直接標記完成
adminRouter.post("/index/stop", async (c) => {
  const db = await getDb(c.env)
  if (db.search_index) db.search_index.is_done = true
  await saveDb(db, c.env)
  return c.json({ code: 200, message: "success", data: indexProgress(db) })
})

// POST /api/admin/index/clear — 清空索引
adminRouter.post("/index/clear", async (c) => {
  const db = await getDb(c.env)
  db.search_index = {
    items: [],
    total: 0,
    is_done: true,
    updated_at: new Date().toISOString(),
    error: "",
  }
  await saveDb(db, c.env)
  return c.json({ code: 200, message: "success", data: indexProgress(db) })
})

// GET /api/admin/index/progress — 索引進度
adminRouter.get("/index/progress", async (c) => {
  const db = await getDb(c.env)
  return c.json({
    code: 200,
    message: "success",
    data: indexProgress(db),
  })
})

// POST /api/admin/scan/start — 手動掃描（同步遍歷 /）
adminRouter.post("/scan/start", async (c) => {
  try {
    const db = await getDb(c.env)
    const res = await search(
      { parent: "/", keywords: "", max_depth: 20, max_results: 2000 },
      c.env,
    )
    db.scan_result = {
      items: res.content,
      total: res.total,
      is_done: true,
      updated_at: new Date().toISOString(),
      error: "",
    }
    await saveDb(db, c.env)
    return c.json({
      code: 200,
      message: "success",
      data: {
        obj_count: res.total,
        is_done: true,
        last_done_time: db.scan_result.updated_at,
        error: "",
      },
    })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})

// POST /api/admin/scan/stop — 無後台任務，標記完成
adminRouter.post("/scan/stop", async (c) => {
  return c.json({
    code: 200,
    message: "success",
    data: { obj_count: 0, is_done: true, last_done_time: null, error: "" },
  })
})

// GET /api/admin/scan/progress — 掃描進度
adminRouter.get("/scan/progress", async (c) => {
  const db = await getDb(c.env)
  const scan = db.scan_result || {}
  return c.json({
    code: 200,
    message: "success",
    data: {
      obj_count: scan.total ?? 0,
      is_done: scan.is_done !== false,
      last_done_time: scan.updated_at || null,
      error: scan.error || "",
    },
  })
})

// --- Plugin Management API ---
adminRouter.get("/plugin/list", async (c) => {
  const db = await getDb(c.env)
  if (!db.plugins) db.plugins = []
  return c.json({
    code: 200,
    message: "success",
    data: {
      content: db.plugins,
      total: db.plugins.length,
    },
  })
})

adminRouter.get("/plugin/get", async (c) => {
  const id = c.req.query("id")
  if (!id) {
    return c.json({ code: 400, message: "id is required", data: null })
  }
  const db = await getDb(c.env)
  if (!db.plugins) db.plugins = []
  const plugin = db.plugins.find((p: any) => p.id === id)
  if (!plugin) {
    return c.json({ code: 404, message: "Plugin not found", data: null })
  }
  return c.json({ code: 200, message: "success", data: plugin })
})

adminRouter.post("/plugin/install", async (c) => {
  try {
    const body = await c.req.json()
    let pluginData = body

    // Support install by manifest URL
    if (body.manifest_url && typeof body.manifest_url === "string") {
      try {
        const resp = await fetch(body.manifest_url)
        if (!resp.ok) {
          return c.json({
            code: 400,
            message: `Failed to fetch plugin manifest from URL: HTTP ${resp.status}`,
            data: null,
          })
        }
        const fetchedManifest = await resp.json()
        pluginData = { ...fetchedManifest, ...body }
      } catch (err: any) {
        return c.json({
          code: 400,
          message: `Network error fetching plugin manifest: ${safeErrorMessage(err, "unexpected network error")}`,
          data: null,
        })
      }
    }

    if (!pluginData.id || !pluginData.name) {
      return c.json({
        code: 400,
        message: "Plugin id and name are required",
        data: null,
      })
    }

    const db = await getDb(c.env)
    if (!db.plugins) db.plugins = []

    const existingIndex = db.plugins.findIndex(
      (p: any) => p.id === pluginData.id,
    )
    const now = new Date().toISOString()
    const newPlugin = {
      id: pluginData.id,
      name: pluginData.name,
      version: pluginData.version || "1.0.0",
      description: pluginData.description || "",
      author: pluginData.author || "Unknown",
      homepage: pluginData.homepage || "",
      repository: pluginData.repository || "",
      icon: pluginData.icon || "",
      type: pluginData.type || "ui",
      enabled:
        pluginData.enabled !== undefined ? Boolean(pluginData.enabled) : true,
      high_privilege: Boolean(pluginData.high_privilege),
      permissions: Array.isArray(pluginData.permissions)
        ? pluginData.permissions
        : [],
      entry_url: pluginData.entry_url || "",
      script_content: pluginData.script_content || "",
      style_content: pluginData.style_content || "",
      config_schema: pluginData.config_schema || [],
      config_values:
        pluginData.config_values || pluginData.default_config || {},
      target_hooks: pluginData.target_hooks || ["global"],
      is_builtin: Boolean(pluginData.is_builtin),
      tags: pluginData.tags || [],
      created_at:
        existingIndex >= 0 ? db.plugins[existingIndex].created_at : now,
      updated_at: now,
    }

    if (existingIndex >= 0) {
      db.plugins[existingIndex] = newPlugin
    } else {
      db.plugins.push(newPlugin)
    }

    await saveDb(db, c.env)
    return c.json({
      code: 200,
      message: "Plugin installed successfully",
      data: newPlugin,
    })
  } catch (err: any) {
    return c.json({
      code: 500,
      message: err.message || "Failed to install plugin",
      data: null,
    })
  }
})

adminRouter.post("/plugin/update", async (c) => {
  try {
    const body = await c.req.json()
    if (!body.id) {
      return c.json({ code: 400, message: "Plugin id is required", data: null })
    }

    const db = await getDb(c.env)
    if (!db.plugins) db.plugins = []

    const index = db.plugins.findIndex((p: any) => p.id === body.id)
    if (index === -1) {
      return c.json({ code: 404, message: "Plugin not found", data: null })
    }

    const current = db.plugins[index]
    const updated = {
      ...current,
      ...body,
      id: current.id, // prevent ID mutation
      updated_at: new Date().toISOString(),
    }

    db.plugins[index] = updated
    await saveDb(db, c.env)

    return c.json({
      code: 200,
      message: "Plugin updated successfully",
      data: updated,
    })
  } catch (err: any) {
    return c.json({
      code: 500,
      message: err.message || "Failed to update plugin",
      data: null,
    })
  }
})

adminRouter.post("/plugin/toggle", async (c) => {
  try {
    const body = await c.req.json()
    if (!body.id) {
      return c.json({ code: 400, message: "Plugin id is required", data: null })
    }

    const db = await getDb(c.env)
    if (!db.plugins) db.plugins = []

    const index = db.plugins.findIndex((p: any) => p.id === body.id)
    if (index === -1) {
      return c.json({ code: 404, message: "Plugin not found", data: null })
    }

    const targetEnabled =
      body.enabled !== undefined
        ? Boolean(body.enabled)
        : !db.plugins[index].enabled

    db.plugins[index].enabled = targetEnabled
    db.plugins[index].updated_at = new Date().toISOString()
    await saveDb(db, c.env)

    return c.json({
      code: 200,
      message: targetEnabled ? "Plugin enabled" : "Plugin disabled",
      data: { id: body.id, enabled: targetEnabled },
    })
  } catch (err: any) {
    return c.json({
      code: 500,
      message: err.message || "Failed to toggle plugin",
      data: null,
    })
  }
})

adminRouter.post("/plugin/delete", async (c) => {
  try {
    const queryId = c.req.query("id")
    let id = queryId
    if (!id) {
      try {
        const body = await c.req.json()
        id = body.id
      } catch {}
    }

    if (!id) {
      return c.json({ code: 400, message: "Plugin id is required", data: null })
    }

    const db = await getDb(c.env)
    if (!db.plugins) db.plugins = []

    const initialLen = db.plugins.length
    db.plugins = db.plugins.filter((p: any) => p.id !== id)

    if (db.plugins.length === initialLen) {
      return c.json({ code: 404, message: "Plugin not found", data: null })
    }

    await saveDb(db, c.env)
    return c.json({
      code: 200,
      message: "Plugin deleted successfully",
      data: null,
    })
  } catch (err: any) {
    return c.json({
      code: 500,
      message: err.message || "Failed to delete plugin",
      data: null,
    })
  }
})

adminRouter.post("/plugin/batch_save", async (c) => {
  try {
    const body = await c.req.json()
    const plugins = Array.isArray(body) ? body : body.plugins
    if (!Array.isArray(plugins)) {
      return c.json({
        code: 400,
        message: "plugins array is required",
        data: null,
      })
    }

    const db = await getDb(c.env)
    db.plugins = plugins
    await saveDb(db, c.env)

    return c.json({
      code: 200,
      message: "Plugins saved successfully",
      data: { count: plugins.length },
    })
  } catch (err: any) {
    return c.json({
      code: 500,
      message: err.message || "Failed to batch save plugins",
      data: null,
    })
  }
})

// ---- Message（與 Go internal/message/http.go 對齊）----
// 進程內消息佇列：send 入隊、get 出隊。Serverless 多實例下佇列不跨實例共享，
// 屬於「盡力而為」的實現，與 Go 的 channel 語義一致（無消息返回 404）。
const messageQueue: string[] = []

adminRouter.post("/message/send", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const message = body?.message
  if (message === undefined || message === null || message === "") {
    return c.json(
      { code: 400, message: "message is required", data: null },
      400,
    )
  }
  messageQueue.push(String(message))
  return c.json({ code: 200, message: "success", data: null })
})

adminRouter.post("/message/get", (c) => {
  const message = messageQueue.shift()
  if (message === undefined) {
    return c.json({ code: 404, message: "no message", data: null }, 404)
  }
  return c.json({ code: 200, message: "success", data: message })
})

// ============ 審計日誌介面 (添加日期: 2026-09-05) ============

// GET /api/admin/audit/logs - 查詢審計日誌
adminRouter.get("/audit/logs", async (c) => {
  try {
    const { queryAuditLogs } = await import("../internal/model/audit")

    const username = c.req.query("username")
    const action = c.req.query("action")
    const method = c.req.query("method")
    const status = c.req.query("status") as "success" | "failure" | undefined
    const startDate = c.req.query("start_date")
    const endDate = c.req.query("end_date")
    const limit = parseInt(c.req.query("limit") || "100", 10)

    const logs = queryAuditLogs({
      username,
      action,
      method,
      status,
      startDate,
      endDate,
      limit: Math.min(limit, 1000), // 最多返回 1000 條
    })

    return c.json({
      code: 200,
      message: "success",
      data: {
        content: logs,
        total: logs.length,
      },
    })
  } catch (err: any) {
    return c.json(
      {
        code: 500,
        message: err.message || "Failed to query audit logs",
        data: null,
      },
      500,
    )
  }
})

// GET /api/admin/audit/stats - 獲取審計日誌統計
adminRouter.get("/audit/stats", async (c) => {
  try {
    const { getAuditStats } = await import("../internal/model/audit")
    const stats = getAuditStats()

    return c.json({
      code: 200,
      message: "success",
      data: stats,
    })
  } catch (err: any) {
    return c.json(
      {
        code: 500,
        message: err.message || "Failed to get audit stats",
        data: null,
      },
      500,
    )
  }
})

// POST /api/admin/audit/cleanup - 清理過期日誌
adminRouter.post("/audit/cleanup", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const retentionDays = parseInt(body.retention_days || "30", 10)

    const { cleanupExpiredLogs } = await import("../internal/model/audit")
    cleanupExpiredLogs(retentionDays)

    return c.json({
      code: 200,
      message: `Cleaned up logs older than ${retentionDays} days`,
      data: null,
    })
  } catch (err: any) {
    return c.json(
      {
        code: 500,
        message: err.message || "Failed to cleanup logs",
        data: null,
      },
      500,
    )
  }
})
