/**
 * Blob 驅動：EdgeOne Blob Storage / ESA Blob
 * 
 * EdgeOne Blob 使用 SDK 方式（不是 binding）
 * ESA Blob 使用 binding 方式
 */
import type { Driver } from "../types"

/**
 * 判斷對象是否具備 Blob binding 的介面形態。
 *
 * 與 KV 同理，必須做介面校驗：環境變量可能只是「綁定名」字符串，
 * 而非綁定對象本身；直接當作 binding 使用會得到
 * "xxx.get is not a function"。
 */
function isBlobLike(b: any): boolean {
  if (!b || typeof b !== "object") return false
  // 屬性訪問可能觸發異常 getter，任何異常都視為「不是可用綁定」。
  try {
    // ESA Blob 至少需要讀取能力
    if (typeof b.get !== "function") return false
    return typeof b.put === "function" || typeof b.set === "function"
  } catch {
    return false
  }
}

/**
 * 檢測 ESA Blob binding（阿里雲）。
 *
 * env 與 globalThis 獨立檢查：env 為真值時不應阻斷對 globalThis 的探測。
 */
function getEsaBlobBinding(env?: any): any | null {
  const g = globalThis as any

  const fromEnv = env?.ESA_BLOB
  if (isBlobLike(fromEnv)) return fromEnv

  const fromGlobal = g?.ESA_BLOB
  if (isBlobLike(fromGlobal)) return fromGlobal

  return null
}

/**
 * 獲取 EdgeOne Blob Store（使用 SDK）
 */
async function getEdgeOneStore(namespace: string = "default"): Promise<any | null> {
  try {
    const { getStore } = await import("@edgeone/pages-blob")
    return getStore(namespace)
  } catch {
    return null
  }
}

export const blobDriver: Driver = {
  name: "blob",

  async isAvailable(env?: any): Promise<boolean> {
    // 檢查 ESA Blob binding
    if (getEsaBlobBinding(env) !== null) {
      return true
    }
    
    // 檢查 EdgeOne Blob SDK
    const store = await getEdgeOneStore()
    return store !== null
  },

  async init(env?: any): Promise<void> {
    // Blob 無需初始化
  },

  async get(key: string, env?: any): Promise<string | null> {
    // 優先使用 ESA Blob binding
    const esaBlob = getEsaBlobBinding(env)
    if (esaBlob) {
      try {
        const obj = await esaBlob.get(key)
        if (!obj) return null
        return await obj.text()  // ESA Blob 返回對象，需要 .text()
      } catch (err) {
        console.warn(`[Blob] ESA get key="${key}" failed:`, err)
        return null
      }
    }
    
    // 使用 EdgeOne Blob SDK
    const store = await getEdgeOneStore()
    if (!store) throw new Error("Blob not available")
    
    try {
      // EdgeOne SDK 默認 type="text" 返回字符串
      const v = await store.get(key)
      if (v == null) return null
      return typeof v === "string" ? v : JSON.stringify(v)
    } catch (err) {
      console.warn(`[Blob] EdgeOne get key="${key}" failed:`, err)
      return null
    }
  },

  async put(key: string, value: string, env?: any): Promise<void> {
    // 優先使用 ESA Blob binding
    const esaBlob = getEsaBlobBinding(env)
    if (esaBlob) {
      await esaBlob.put(key, value)
      return
    }
    
    // 使用 EdgeOne Blob SDK（注意：SDK 方法是 set，不是 put）
    const store = await getEdgeOneStore()
    if (!store) throw new Error("Blob not available")
    
    await store.set(key, value)
  },

  async delete(key: string, env?: any): Promise<void> {
    // 優先使用 ESA Blob binding
    const esaBlob = getEsaBlobBinding(env)
    if (esaBlob) {
      await esaBlob.delete(key)
      return
    }
    
    // 使用 EdgeOne Blob SDK
    const store = await getEdgeOneStore()
    if (!store) throw new Error("Blob not available")
    
    await store.delete(key)
  },

  async list(prefix: string, env?: any): Promise<string[]> {
    // 優先使用 ESA Blob binding
    const esaBlob = getEsaBlobBinding(env)
    if (esaBlob) {
      const keys: string[] = []
      let cursor: string | undefined

      do {
        const result = await esaBlob.list({ prefix, cursor })
        keys.push(...(result?.keys || []).map((k: any) => k.name))
        cursor = result?.cursor
      } while (cursor)

      return keys
    }
    
    // 使用 EdgeOne Blob SDK
    const store = await getEdgeOneStore()
    if (!store) throw new Error("Blob not available")
    
    // 文件：list({ prefix, paginate: true }) 自動聚合所有分頁，返回 { blobs: [{ key, etag }] }
    const result = await store.list({ prefix, paginate: true })
    return (result?.blobs || []).map((b: any) => b.key)
  },

  async health(env?: any): Promise<any> {
    const esaBlob = getEsaBlobBinding(env)
    const edgeOneStore = await getEdgeOneStore()
    
    if (esaBlob) {
      try {
        await esaBlob.head("__health_check__")
        return {
          driver: "blob",
          platform: "ESA Blob (binding)",
          available: true,
        }
      } catch (err: any) {
        return {
          driver: "blob",
          platform: "ESA Blob (binding)",
          available: false,
          error: err?.message || String(err),
        }
      }
    }
    
    if (edgeOneStore) {
      try {
        // EdgeOne SDK 沒有 head 方法，用 get 測試（不存在不報錯）
        await edgeOneStore.get("__health_check__")
        return {
          driver: "blob",
          platform: "EdgeOne Blob (SDK)",
          available: true,
        }
      } catch (err: any) {
        return {
          driver: "blob",
          platform: "EdgeOne Blob (SDK)",
          available: false,
          error: err?.message || String(err),
        }
      }
    }
    
    return {
      driver: "blob",
      available: false,
      error: "No Blob storage available",
    }
  },
}
