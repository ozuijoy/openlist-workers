/**
 * DELETE /kv-delete?key=xxx
 *
 * 刪除 KV 鍵。需通過鑑權（內部調用標識 或 管理員 JWT）。
 */
import { authorize, deny, json, kvMissing, resolveKv } from "../_kv-proxy.js"

export async function onRequest({ request, env }) {
  if (request.method !== "DELETE") {
    return json({ error: "Method not allowed, use DELETE" }, 405)
  }

  const auth = await authorize(request, env)
  if (!auth.ok) return deny(auth)

  const kv = resolveKv(env)
  if (!kv) return kvMissing()

  const { searchParams } = new URL(request.url)
  const key = searchParams.get("key")
  if (!key) return json({ error: "Missing key parameter" }, 400)

  try {
    await kv.delete(key)
    return json({ success: true })
  } catch (err) {
    return json({ error: err?.message || String(err) }, 500)
  }
}
