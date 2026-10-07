/**
 * 記憶體驅動（模塊級 Map，不持久化）。
 *
 * 作為 auto 檢測失敗時的最終回退，保證無任何儲存綁定的環境下（本地開發、
 * 容器、CI）仍能正常讀寫配置（僅在單實例記憶體中生效，進程重啟後丟失）。
 * 與舊版 json 後端的「無綁定 → 記憶體回退」行為一致。
 */
import type { Driver } from "../types"

const store = new Map<string, string>()

export const memoryDriver: Driver = {
  name: "memory",

  async isAvailable(): Promise<boolean> {
    return true
  },

  async init(): Promise<void> {
    // 無需初始化
  },

  async get(key: string): Promise<string | null> {
    return store.get(key) ?? null
  },

  async put(key: string, value: string): Promise<void> {
    store.set(key, value)
  },

  async delete(key: string): Promise<void> {
    store.delete(key)
  },

  async list(prefix: string): Promise<string[]> {
    return [...store.keys()].filter((k) => k.startsWith(prefix))
  },

  async health(): Promise<any> {
    return {
      configured: true,
      connected: true,
      platform: "Memory",
      mode: "memory",
      hasData: store.size > 0,
      error: null,
    }
  },
}
