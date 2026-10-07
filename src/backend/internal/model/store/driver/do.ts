/**
 * Cloudflare Durable Objects 驅動。
 *
 * 通過 DO binding 獲取 stub，RPC 調用 OpenListDB 實例的方法。每個實例用
 * `idFromName` 定位（默認 ID "openlist-db"），保證資料持久在同一實例。
 *
 * 配置：
 * - DO binding 名固定為 `DO`
 * - DO_ID: DO 實例名稱（可選，默認 "openlist-db"）
 *
 * 需在 wrangler.toml 配置：
 *   [[durable_objects.bindings]]
 *   name = "DO"
 *   class_name = "OpenListDB"
 *   [[migrations]]
 *   tag = "v1"
 *   new_sqlite_classes = ["OpenListDB"]
 */
import type { Driver } from "../types"

/**
 * 判斷對象是否具備 Durable Object 命名空間介面形態。
 *
 * 必須校驗：環境變量可能僅是「綁定名」字符串，而非綁定對象，
 * 直接使用會得到 "binding.idFromName is not a function"。
 */
function isDoNamespaceLike(b: any): boolean {
  if (!b || typeof b !== "object") return false
  try {
    return typeof b.idFromName === "function"
  } catch {
    return false
  }
}

/**
 * 獲取 Durable Object 綁定。
 *
 * 綁定名固定為 DO。env 與 globalThis 獨立檢查：env 為真值時不阻斷對
 * globalThis 的探測。
 */
function getDoBinding(env?: any): any | null {
  const g = typeof globalThis !== "undefined" ? (globalThis as any) : {}
  if (isDoNamespaceLike(env?.DO)) return env.DO
  if (isDoNamespaceLike(g?.DO)) return g.DO
  return null
}

function getDoId(env?: any): string {
  const e = env || (typeof process !== "undefined" ? process.env : {}) || {}
  return String(e?.DO_ID || "openlist-db")
}

function getStub(env?: any): any | null {
  const binding = getDoBinding(env)
  if (!binding) return null
  try {
    const id = binding.idFromName(getDoId(env))
    return binding.get(id)
  } catch {
    return null
  }
}

export const doDriver: Driver = {
  name: "do",

  async isAvailable(env?: any): Promise<boolean> {
    return getDoBinding(env) != null
  },

  async init(env?: any): Promise<void> {
    const stub = getStub(env)
    if (stub && typeof stub.init === "function") {
      await stub.init()
    }
  },

  async get(key: string, env?: any): Promise<string | null> {
    const stub = getStub(env)
    if (!stub) throw new Error("DO binding not found")
    return await stub.kvGet(key)
  },

  async put(key: string, value: string, env?: any): Promise<void> {
    const stub = getStub(env)
    if (!stub) throw new Error("DO binding not found")
    await stub.kvPut(key, value)
  },

  async delete(key: string, env?: any): Promise<void> {
    const stub = getStub(env)
    if (!stub) throw new Error("DO binding not found")
    await stub.kvDelete(key)
  },

  async list(prefix: string, env?: any): Promise<string[]> {
    const stub = getStub(env)
    if (!stub) throw new Error("DO binding not found")
    return await stub.kvList(prefix)
  },

  async query(sql: string, params: any[], env?: any): Promise<any[]> {
    const stub = getStub(env)
    if (!stub) throw new Error("DO binding not found")
    return await stub.sqlQuery(sql, params)
  },

  async execute(sql: string, params: any[], env?: any): Promise<void> {
    const stub = getStub(env)
    if (!stub) throw new Error("DO binding not found")
    await stub.sqlExecute(sql, params)
  },

  async batch(
    statements: Array<{ sql: string; params: any[] }>,
    env?: any,
  ): Promise<void> {
    const stub = getStub(env)
    if (!stub) throw new Error("DO binding not found")
    await stub.sqlBatch(statements)
  },

  async health(env?: any): Promise<any> {
    const binding = getDoBinding(env)
    if (!binding) {
      return {
        configured: false,
        connected: false,
        platform: "Cloudflare Durable Objects",
        mode: "do",
        error: "DO binding not found (expected env.DO)",
      }
    }

    try {
      const stub = getStub(env)
      await stub.health()
      return {
        configured: true,
        connected: true,
        platform: "Cloudflare Durable Objects (SQLite)",
        mode: "do",
        doId: getDoId(env),
      }
    } catch (err: any) {
      return {
        configured: true,
        connected: false,
        platform: "Cloudflare Durable Objects",
        mode: "do",
        error: err?.message || String(err),
      }
    }
  },
}
