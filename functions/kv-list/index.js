/**
 * GET /kv-list?prefix=xxx
 *
 * 列出 KV 鍵。需通過鑑權（內部調用標識 或 管理員 JWT）。
 *
 * EdgeOne KV list() 語義（依據官方 functions-kv 示例）：
 *   page.keys     -> [{ key, ttl, meta }]
 *   page.complete -> true 表示已到末頁
 *   下一頁 cursor 需手動取本頁最後一個 key
 *
 * 分頁加固：
 *   - 以本頁最後一個 key 作為下一頁 cursor（EdgeOne 約定）；
 *   - **重複頁檢測**：若本頁首個 key 與上一頁相同，說明 cursor 未生效
 *     （或平台語義變化），立即終止，避免返回大量重複項；
 *   - 結果去重，保證上游看到的鍵集合唯一。
 */
import { authorize, deny, json, kvMissing, resolveKv } from "../_kv-proxy.js"

export async function onRequest({ request, env }) {
  const auth = await authorize(request, env)
  if (!auth.ok) return deny(auth)

  const kv = resolveKv(env)
  if (!kv) return kvMissing()

  const { searchParams } = new URL(request.url)
  const prefix = searchParams.get("prefix") || ""

  try {
    const seen = new Set()
    let cursor = ""
    let complete = false
    let guard = 0
    let prevFirstKey = null

    // 安全閥：防止異常情況下無限循環
    while (!complete && guard < 1000) {
      guard += 1

      const page = await kv.list({ prefix, cursor, limit: 256 })
      const pageKeys = Array.isArray(page?.keys) ? page.keys : []

      if (pageKeys.length === 0) {
        complete = true
        break
      }

      const firstKey = pageKeys[0]?.key || null
      // 重複頁檢測：cursor 未推進（或平台語義變化）時立即終止
      if (firstKey !== null && firstKey === prevFirstKey) {
        console.warn(
          "[kv-list] repeated page detected; stopping pagination " +
            "to avoid returning duplicates",
        )
        break
      }
      prevFirstKey = firstKey

      for (const item of pageKeys) {
        if (item?.key) seen.add(item.key)
      }

      cursor = pageKeys[pageKeys.length - 1].key || ""
      complete = Boolean(page?.complete)
    }

    return json({ keys: [...seen] })
  } catch (err) {
    return json({ error: err?.message || String(err) }, 500)
  }
}
