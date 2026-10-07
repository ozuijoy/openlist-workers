import assert from "node:assert/strict"
import { test } from "node:test"
import app from "../index"

/**
 * KV 代理端點的「自調用環」迴歸測試。
 *
 * 現象（本地 `wrangler dev`）：滿屏 `GET /kv-list 503`，且每條耗時逐條增長
 * （2433ms → 2624ms …）。
 *
 * 機制：kv 驅動的可用性判定 = 向 `{origin}/kv-list?prefix=__health__` 發一次 HTTP
 * 探測（本地 origin 就是 dev server 自己）。若這些探測請求落進全局「儲存配置錯誤
 * 攔截」，中間件會再次解析驅動 → 再次探測自身 → 無限自調用；每層都要等內層返回，
 * 所以耗時持續增長，而每條響應都是 503（kv 不可用 → 配置錯誤）。
 *
 * 因此本部署必須：① 不把這些路徑交給攔截邏輯；② 明確回 410，而不是落進 SPA 兜底
 * （兜底返回 HTML 200，會讓探測誤判為「KV 可用」）。
 */

const JWT = "0123456789abcdef0123456789abcdef"

/** 記錄出站 fetch：KV 代理探測就表現為一次出站請求 */
function captureFetch(status = 503) {
  const original = globalThis.fetch
  const calls: string[] = []
  ;(globalThis as any).fetch = async (input: any) => {
    calls.push(String(input?.url ?? input))
    return new Response("stub", { status })
  }
  return {
    calls,
    restore: () => {
      ;(globalThis as any).fetch = original
    },
  }
}

const kvEnv = (): any => ({
  DB_DRIVER: "kv",
  DB_FORMAT: "map",
  JWT_SECRET: JWT,
  __requestOrigin: "https://example.workers.dev",
})

test("KV 代理端點：本部署不提供 → 410，且處理它絕不再發起探測", async () => {
  const cap = captureFetch(503)
  try {
    const res = await app.fetch(
      new Request("https://example.workers.dev/kv-list?prefix=__health__"),
      kvEnv(),
    )
    assert.equal(
      res.status,
      410,
      "必須明確拒絕：既不能 503（會被攔截邏輯遞歸），也不能 200（會被誤判為可用）",
    )
    const body: any = await res.json()
    assert.match(String(body.message), /not served by this deployment/)
    assert.equal(
      cap.calls.length,
      0,
      "處理該請求不得再發起任何出站探測，否則形成無限自調用環",
    )
  } finally {
    cap.restore()
  }
})

test("KV 代理端點：豁免攔截不影響業務介面（未降級、未放鬆）", async () => {
  const cap = captureFetch(503)
  try {
    const res = await app.fetch(
      new Request("https://example.workers.dev/api/public/settings"),
      kvEnv(),
    )
    assert.equal(res.status, 503, "kv 不可用時業務介面必須 503，不得靜默降級")
    const body: any = await res.json()
    assert.equal(body.data?.code, "DRIVER_UNAVAILABLE")
    assert.match(
      String(body.data?.suggestion),
      /DB_DRIVER=/,
      "503 仍要帶上「改成什麼」的建議",
    )
  } finally {
    cap.restore()
  }
})
