/**
 * POST /kv-put
 * body: { key: string, value: string }
 *
 * 寫入 KV。需通過鑑權（內部調用標識 或 管理員 JWT）。
 */
import { authorize, deny, json, kvMissing, resolveKv } from "../_kv-proxy.js"

export async function onRequestPost({ request, env }) {
  const auth = await authorize(request, env)
  if (!auth.ok) return deny(auth)

  const kv = resolveKv(env)
  if (!kv) return kvMissing()

  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: "Invalid JSON body" }, 400)
  }

  const { key, value } = body || {}
  if (!key || value === undefined || value === null) {
    return json({ error: "Missing key or value" }, 400)
  }

  try {
    await kv.put(String(key), String(value))
    return json({ success: true })
  } catch (err) {
    return json({ error: err?.message || String(err) }, 500)
  }
}

/** 非 POST 請求統一拒絕 */
export async function onRequest() {
  return json({ error: "Method not allowed, use POST" }, 405)
}
