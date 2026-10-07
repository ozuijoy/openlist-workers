/**
 * Map 格式適配器
 * 
 * 將整個資料對象序列化為單個 JSON 字符串，儲存在單個鍵中。
 * 適用於 KV/Blob 等簡單儲存系統。
 * 
 * 儲存格式：
 * - key: "openlist_config"
 * - value: JSON.stringify(data)
 */
import type { FormatAdapter, Driver } from "../types"

const CONFIG_KEY = "openlist_config"

export const mapFormat: FormatAdapter = {
  name: "map",

  async load(driver: Driver, env?: any): Promise<any | null> {
    const raw = await driver.get(CONFIG_KEY, env)
    if (!raw) return null

    try {
      return JSON.parse(raw)
    } catch (err) {
      console.error("[mapFormat] Failed to parse JSON:", err)
      return null
    }
  },

  async save(data: any, driver: Driver, env?: any): Promise<boolean> {
    const raw = JSON.stringify(data)
    await driver.put(CONFIG_KEY, raw, env)
    return true
  },
}
