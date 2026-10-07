/**
 * Cloudflare KV API 驅動（遠程 REST API 訪問）
 * 
 * 通過 Cloudflare REST API 遠程訪問 KV，無需 Worker binding。
 * 適用於外部服務訪問、CI/CD、跨賬號訪問等場景。
 * 
 * 環境變量：
 * - CF_ACCOUNT / CLOUDFLARE_ACCOUNT_ID
 * - CF_KV_UUID / CLOUDFLARE_KV_NAMESPACE_ID
 * - CF_API_KEY / CLOUDFLARE_API_TOKEN
 */
import type { Driver } from "../types"

interface CfKvConfig {
  accountId: string
  namespaceId: string
  apiToken: string
}

function getCfKvConfig(env?: any): CfKvConfig | null {
  const e = env || (typeof process !== "undefined" ? process.env : {}) || {}
  const accountId = e.CF_ACCOUNT || e.CLOUDFLARE_ACCOUNT_ID
  const namespaceId = e.CF_KV_UUID || e.CLOUDFLARE_KV_NAMESPACE_ID
  const apiToken = e.CF_API_KEY || e.CLOUDFLARE_API_TOKEN

  if (!accountId || !namespaceId || !apiToken) return null

  return { accountId, namespaceId, apiToken }
}

function buildUrl(config: CfKvConfig, path: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/storage/kv/namespaces/${config.namespaceId}${path}`
}

export const cfkvDriver: Driver = {
  name: "cfkv",

  async isAvailable(env?: any): Promise<boolean> {
    return getCfKvConfig(env) !== null
  },

  async init(env?: any): Promise<void> {
    // Cloudflare KV API 無需初始化
  },

  async get(key: string, env?: any): Promise<string | null> {
    const config = getCfKvConfig(env)
    if (!config) throw new Error("Cloudflare KV API not configured")

    const url = buildUrl(config, `/values/${encodeURIComponent(key)}`)
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${config.apiToken}` },
    })

    if (resp.status === 404) return null
    if (!resp.ok) throw new Error(`Cloudflare KV API error: ${resp.status}`)

    return await resp.text()
  },

  async put(key: string, value: string, env?: any): Promise<void> {
    const config = getCfKvConfig(env)
    if (!config) throw new Error("Cloudflare KV API not configured")

    const url = buildUrl(config, `/values/${encodeURIComponent(key)}`)
    const resp = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${config.apiToken}` },
      body: value,
    })

    if (!resp.ok) throw new Error(`Cloudflare KV API error: ${resp.status}`)
  },

  async delete(key: string, env?: any): Promise<void> {
    const config = getCfKvConfig(env)
    if (!config) throw new Error("Cloudflare KV API not configured")

    const url = buildUrl(config, `/values/${encodeURIComponent(key)}`)
    const resp = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${config.apiToken}` },
    })

    if (!resp.ok && resp.status !== 404) {
      throw new Error(`Cloudflare KV API error: ${resp.status}`)
    }
  },

  async list(prefix: string, env?: any): Promise<string[]> {
    const config = getCfKvConfig(env)
    if (!config) throw new Error("Cloudflare KV API not configured")

    const keys: string[] = []
    let cursor: string | undefined

    do {
      const params = new URLSearchParams({ prefix, limit: "1000" })
      if (cursor) params.set("cursor", cursor)

      const url = buildUrl(config, `/keys?${params}`)
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${config.apiToken}` },
      })

      if (!resp.ok) throw new Error(`Cloudflare KV API error: ${resp.status}`)

      const data: any = await resp.json()
      keys.push(...(data.result || []).map((r: any) => r.name))
      cursor = data.result_info?.cursor
    } while (cursor)

    return keys
  },

  async health(env?: any): Promise<any> {
    const config = getCfKvConfig(env)
    if (!config) {
      return {
        configured: false,
        connected: false,
        platform: "Cloudflare KV API (REST)",
        mode: "cfkv",
        error:
          "Missing CF_ACCOUNT, CF_KV_UUID, or CF_API_KEY",
      }
    }

    try {
      await this.get("__health_check__", env)
      return {
        configured: true,
        connected: true,
        platform: "Cloudflare KV API (REST)",
        mode: "cfkv",
        accountId: config.accountId,
        namespaceId: config.namespaceId,
      }
    } catch (err: any) {
      return {
        configured: true,
        connected: false,
        platform: "Cloudflare KV API (REST)",
        mode: "cfkv",
        error: err?.message || String(err),
      }
    }
  },
}
