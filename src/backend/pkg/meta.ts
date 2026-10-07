import { getDb } from "../internal/model/db"
import type { UserPermissionObj } from "./permission"
import { isAdmin } from "./permission"

/**
 * Meta 消費層（對齊 Go server/common/check.go）。
 *
 * Meta 定義了路徑級別的權限、密碼、隱藏、自定義內容等規則，
 * 本模塊提供判斷用戶是否能訪問/讀/寫某路徑、以及獲取 readme/header 的函數。
 */

export interface Meta {
  id: number
  path: string
  password: string
  p_sub: boolean
  read_users: number[]
  read_users_sub: boolean
  write_users: number[]
  write_users_sub: boolean
  write: boolean
  w_sub: boolean
  hide: string
  h_sub: boolean
  readme: string
  r_sub: boolean
  header: string
  header_sub: boolean
}

/**
 * 獲取覆蓋指定路徑的最近祖先 meta（向上遞歸查找）。
 * 對齊 Go op.GetNearestMeta (internal/op/meta.go:27-65)。
 */
export async function getNearestMeta(
  path: string,
  env?: any,
): Promise<Meta | null> {
  const db = await getDb(env)
  const metas = db.metas || []
  if (metas.length === 0) return null

  const cleanPath = fixAndCleanPath(path)
  // 直接匹配
  const exact = metas.find(
    (m: Meta) => fixAndCleanPath(m.path) === cleanPath,
  )
  if (exact) return exact

  // 向上遞歸查找祖先
  let current = cleanPath
  while (current !== "/") {
    const parent = current.substring(0, current.lastIndexOf("/")) || "/"
    const match = metas.find((m: Meta) => fixAndCleanPath(m.path) === parent)
    if (match) return match
    current = parent
  }
  return null
}

/**
 * 判斷 meta 是否覆蓋目標路徑（相等或祖先 + sub 開關）。
 * 對齊 Go common.MetaCoversPath (server/common/check.go:83-99)。
 */
export function metaCoversPath(
  metaPath: string,
  reqPath: string,
  applyToSubFolder: boolean,
): boolean {
  const mp = fixAndCleanPath(metaPath)
  const rp = fixAndCleanPath(reqPath)
  if (mp.toLowerCase() === rp.toLowerCase()) return true
  if (!applyToSubFolder) return false
  let current = rp
  while (current !== "/") {
    current = current.substring(0, current.lastIndexOf("/")) || "/"
    if (mp.toLowerCase() === current.toLowerCase()) return true
  }
  return false
}

function fixAndCleanPath(p: string): string {
  const normalized = (p || "/")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .trim()
  if (normalized === "" || normalized === "/") return "/"
  const cleaned = "/" + normalized.split("/").filter(Boolean).join("/")
  return cleaned
}

/**
 * 判斷用戶能否訪問路徑（密碼 + read_users）。
 * 對齊 Go common.CanAccess (server/common/check.go:57-65)。
 */
export function canAccess(
  user: UserPermissionObj | null,
  meta: Meta | null,
  path: string,
  password: string = "",
): boolean {
  // 管理員無視所有限制
  if (user && isAdmin(user)) return true

  if (!meta) return true

  // 密碼保護：meta.password 非空 + 覆蓋路徑 → 需密碼
  if (
    meta.password &&
    meta.password.trim() !== "" &&
    metaCoversPath(meta.path, path, meta.p_sub)
  ) {
    if (password !== meta.password) return false
  }

  // read_users 白名單：非空 + 覆蓋路徑 → 用戶必須在列表
  if (
    meta.read_users &&
    meta.read_users.length > 0 &&
    metaCoversPath(meta.path, path, meta.read_users_sub)
  ) {
    if (!user || !meta.read_users.includes(user.id || 0)) return false
  }

  return true
}

/**
 * 判斷用戶能否讀取路徑（read_users 白名單）。
 * 對齊 Go common.CanRead (server/common/check.go:21-28)。
 */
export function canRead(
  user: UserPermissionObj | null,
  meta: Meta | null,
  path: string,
): boolean {
  // nil user（內部/系統上下文）無視限制
  if (user === null) return true
  if (user && isAdmin(user)) return true

  if (
    meta &&
    meta.read_users &&
    meta.read_users.length > 0 &&
    metaCoversPath(meta.path, path, meta.read_users_sub)
  ) {
    return meta.read_users.includes(user.id || 0)
  }
  return true
}

/**
 * 判斷用戶能否寫入路徑（write_users 白名單）。
 * 對齊 Go common.CanWrite (server/common/check.go:30-41)。
 */
export function canWrite(
  user: UserPermissionObj | null,
  meta: Meta | null,
  path: string,
): boolean {
  if (user === null) return true
  if (user && isAdmin(user)) return true

  if (
    meta &&
    meta.write_users &&
    meta.write_users.length > 0 &&
    metaCoversPath(meta.path, path, meta.write_users_sub)
  ) {
    return meta.write_users.includes(user.id || 0)
  }
  return true
}

/**
 * 判斷路徑能否繞過用戶寫權限開關（meta.write + w_sub）。
 * 對齊 Go common.CanWriteContentBypassUserPerms (server/common/check.go:43-51)。
 *
 * 返回 true 表示即使用戶無寫權限也可寫（目錄管理員強制開啟）。
 */
export function canWriteContentBypassUserPerms(
  meta: Meta | null,
  path: string,
): boolean {
  if (!meta) return false
  return meta.write && metaCoversPath(meta.path, path, meta.w_sub)
}

/**
 * 獲取路徑的 readme（meta.readme + r_sub）。
 * 對齊 Go handles/fsread.go:187-192 getReadme。
 */
export function getReadme(meta: Meta | null, path: string): string {
  if (!meta || !meta.readme) return ""
  if (metaCoversPath(meta.path, path, meta.r_sub)) {
    return meta.readme
  }
  return ""
}

/**
 * 獲取路徑的 header（meta.header + header_sub）。
 * 對齊 Go handles/fsread.go:194-199 getHeader。
 */
export function getHeader(meta: Meta | null, path: string): string {
  if (!meta || !meta.header) return ""
  if (metaCoversPath(meta.path, path, meta.header_sub)) {
    return meta.header
  }
  return ""
}

/**
 * 判斷文件名是否被 meta.hide 正則隱藏（h_sub 控制子目錄）。
 * 對齊 Go common.CanSeeHides (server/common/check.go:67-81)。
 *
 * 返回 true = 被隱藏（需過濾掉）。
 */
export function isHidden(
  meta: Meta | null,
  path: string,
  fileName: string,
): boolean {
  if (!meta || !meta.hide || meta.hide.trim() === "") return false
  if (!metaCoversPath(meta.path, path, meta.h_sub)) return false

  const patterns = meta.hide
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
  for (const pattern of patterns) {
    try {
      const re = new RegExp(pattern)
      if (re.test(fileName)) return true
    } catch {
      // 忽略非法正則
    }
  }
  return false
}

/**
 * 校驗 hide 欄位正則合法性（對齊 Go handles/meta.go:71-80 validHide）。
 * 返回 null = 合法；返回錯誤正則行 = 非法。
 */
export function validateHide(hide: string): string | null {
  if (!hide || hide.trim() === "") return null
  const lines = hide.split("\n").map((s) => s.trim()).filter(Boolean)
  for (const line of lines) {
    try {
      new RegExp(line)
    } catch {
      return line
    }
  }
  return null
}
