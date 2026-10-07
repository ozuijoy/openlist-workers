/**
 * 阿里雲 ESA（邊緣安全加速）邊緣函數入口適配文件
 *
 * 適配要點：
 * 1. ESA fetch 簽名為 (request, context, env)，env 是第三個參數；
 *    而 Hono app.fetch 期望 (request, env, executionCtx)，需要調整參數順序。
 * 2. ESA 的 KV 儲存使用 new EdgeKV({ namespace }) API，與 Cloudflare Workers
 *    的 KV namespace binding 不同；此處將 EdgeKV 包裝成項目期望的
 *    { get, put, delete } 介面，並掛載到 env.KV 和 globalThis.KV，
 *    使項目的通用 KV 適配層（getKvBinding）能自動檢測並使用。
 * 3. ESA 不提供 ASSETS binding，前端 SPA 路由（如 /login、/@manage/*）
 *    無法通過靜態資源回退；此處內聯 dist/index.html 並通過 setSpaFallbackHtml
 *    注入，由 Hono 兜底直接返回 SPA 殼。
 * 4.【請求級 KV 快取】ESA 邊緣函數每個請求最多 8 次 KV 子請求，
 *    後端代碼在單次請求中可能反覆 getDb() 讀取同一個 key，導致超限。
 *    此處為每次請求創建獨立快取 Map，同 key 僅發起一次真實 KV 調用。
 */
declare const EdgeKV: any
import app, { setSpaFallbackHtml } from "./src/backend/index"
import INDEX_HTML from "./dist/index.html"
// 構建期內聯 dist/index.html 作為 SPA 兜底殼
setSpaFallbackHtml(INDEX_HTML)
// 模塊級：探測 EdgeKV 全局構造器（ESA 運行時可能掛在不同的全局對象上）
function detectEdgeKVCtor(): any {
  const candidates: any[] = []
  const g = globalThis as any
  if (g.EdgeKV) candidates.push(g.EdgeKV)
  if (g.edgeKV) candidates.push(g.edgeKV)
  try {
    const s = (typeof self !== "undefined" ? self : null) as any
    if (s && s !== g && s.EdgeKV) candidates.push(s.EdgeKV)
  } catch {
    /* ignore */
  }
  try {
    if (typeof EdgeKV !== "undefined") candidates.push(EdgeKV)
  } catch {
    /* ReferenceError 意味著未聲明，忽略 */
  }
  return candidates[0] || null
}
const MODULE_LEVEL_EDGE_KV = detectEdgeKVCtor()
console.log(
  `[ESA/entry] module loaded, module-level EdgeKV: ${!!MODULE_LEVEL_EDGE_KV}, ` +
    `globalThis keys: ${
      Object.keys(globalThis as any)
        .filter((k) => /kv|edge|storage|env|alibaba|worker/i.test(k))
        .join(",") || "(none matched)"
    }`,
)
function getEdgeKVCtorAtRequestTime(): any {
  if (MODULE_LEVEL_EDGE_KV) return MODULE_LEVEL_EDGE_KV
  const g = globalThis as any
  if (g.EdgeKV) return g.EdgeKV
  if (g.edgeKV) return g.edgeKV
  return null
}

/**
 * 模塊級 KV 快取（跨請求共享）。
 *
 * 解決 ESA EdgeKV 最終一致性問題：put 寫入後需要幾秒到幾十秒同步到所有邊緣節點，
 * 保存設置後立即 get 可能打到還沒同步的節點讀到舊值，導致"保存後刷新復原"。
 *
 * 此處維護一個帶 TTL 的模塊級快取：
 * - put 成功後立即寫入快取，後續 get 優先從快取讀，不依賴 EdgeKV 同步
 * - get 未命中快取時才發起真實 KV get，並寫入快取
 * - 快取 TTL 60 秒，避免長期持有舊資料（其他實例/節點更新的資料最多延遲 60 秒）
 * - 模塊級快取在函數實例複用期間有效，冷啟動後為空（正常行為）
 */
const MODULE_KV_CACHE_TTL_MS = 60_000
const moduleKvCache = new Map<
  string,
  { value: string | null; timestamp: number }
>()

function getModuleKvCache(key: string): string | null | undefined {
  const entry = moduleKvCache.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.timestamp > MODULE_KV_CACHE_TTL_MS) {
    moduleKvCache.delete(key)
    return undefined
  }
  return entry.value
}

function setModuleKvCache(key: string, value: string | null): void {
  moduleKvCache.set(key, { value, timestamp: Date.now() })
}

function deleteModuleKvCache(key: string): void {
  moduleKvCache.delete(key)
}

/**
 * 包裝 ESA EdgeKV 為項目通用的 { get, put, delete } 介面。
 * @param edgeKv 原始 EdgeKV 實例
 * @param cache  請求級快取 Map（每次請求新建），同 key 僅發起一次真實 KV 調用
 */
function wrapEsaEdgeKV(edgeKv: any, cache?: Map<string, string | null>) {
  return {
    async get(key: string, _type?: string): Promise<string | null> {
      // 1. 命中請求級快取：直接返回，不發起 KV 子請求
      if (cache && cache.has(key)) {
        return cache.get(key) as string | null
      }
      // 2. 命中模塊級快取（帶 TTL）：直接返回，解決 EdgeKV 最終一致性導致的"保存後復原"
      const moduleCached = getModuleKvCache(key)
      if (moduleCached !== undefined) {
        if (cache) cache.set(key, moduleCached)
        return moduleCached
      }
      try {
        let val = await edgeKv.get(key)
        if (val != null && typeof val !== "string") {
          if (typeof val.text === "function") {
            val = await val.text()
          } else if (typeof val.toString === "function") {
            val = val.toString()
          }
        }
        const result = val ?? null
        // 3. 寫入請求級快取和模塊級快取（含 null，避免 404 反覆重試）
        if (cache) cache.set(key, result)
        setModuleKvCache(key, result)
        return result
      } catch (e) {
        console.error(`[ESA/KV] get failed key=${key}:`, e)
        // 4. 失敗也快取 null，避免同一請求內反覆重試耗盡配額
        if (cache) cache.set(key, null)
        setModuleKvCache(key, null)
        return null
      }
    },
    async put(key: string, value: string): Promise<void> {
      try {
        await edgeKv.put(key, value)
        // put 成功後立即更新請求級快取和模塊級快取，使後續 get 能拿到新值
        // （不依賴 EdgeKV 最終一致性同步，解決"保存後刷新復原"）
        if (cache) cache.set(key, value)
        setModuleKvCache(key, value)
      } catch (e: any) {
        console.error(
          `[ESA/KV] put failed key=${key}, valueLen=${value?.length || 0}:`,
          e?.message || e,
          e?.stack || ""
        )
        // 不更新快取，讓後續 get 能重試
        throw e
      }
    },
    async delete(key: string): Promise<void> {
      try {
        await edgeKv.delete(key)
      } catch {}
      // delete 後使快取失效
      if (cache) cache.delete(key)
      deleteModuleKvCache(key)
    },
  }
}
export default {
  async fetch(request: Request, context: any, env: any) {
    // ESA: (request, context, env)
    // Hono: (request, env, executionCtx)
    const url = new URL(request.url)
    const isApiRequest = url.pathname.startsWith("/api")
    const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    // 【關鍵】每次請求創建獨立的 KV 快取 Map，隔離不同請求，避免資料汙染
    const kvCache = new Map<string, string | null>()

    if (isApiRequest) {
      const envKeys = env ? Object.keys(env) : []
      console.log(
        `[ESA/req:${reqId}] ${request.method} ${url.pathname}, ` +
          `env keys=[${envKeys.join(",")}], context type=${typeof context}`,
      )
    }
    const edgeKvCtor = getEdgeKVCtorAtRequestTime()
    if (env && typeof env !== "undefined") {
      const namespace = env.KV_NAMESPACE || "openlist"
      if (edgeKvCtor) {
        try {
          const edgeKv = new edgeKvCtor({ namespace })
          // probe 本身也走快取，避免和業務 get 爭搶配額
          let kvTestOk = false
          let kvTestErr: string | null = null
          try {
            await edgeKv.get("__openlist_probe__")
            kvTestOk = true
          } catch (e: any) {
            kvTestErr = e?.message || String(e)
          }
          // 傳入請求級快取
          const wrappedKv = wrapEsaEdgeKV(edgeKv, kvCache)
          // 同時掛載到 env 和 globalThis：ESA 的 env 對象可能是 Proxy/frozen，
          // 直接屬性賦值可能不生效；項目 getKvBinding 會同時檢查 env[key] 和 globalThis[key]
          try {
            env.KV = wrappedKv
          } catch (e) {
            console.warn(
              `[ESA/req:${reqId}] env.KV assign failed (env may be frozen):`,
              e,
            )
          }
          ;(globalThis as any).KV = wrappedKv
          if (isApiRequest) {
            const envHasKv = !!(env && env.KV)
            const globalHasKv = !!(globalThis as any).KV
            console.log(
              `[ESA/req:${reqId}] EdgeKV initialized namespace=${namespace}, ` +
                `probe=${kvTestOk ? "ok" : "FAIL:" + kvTestErr}, ` +
                `env.KV=${envHasKv}, globalThis.KV=${globalHasKv}, ` +
                `JWT_SECRET set=${!!env.JWT_SECRET}`,
            )
          }
        } catch (e: any) {
          console.error(
            `[ESA/req:${reqId}] EdgeKV init FAILED namespace=${namespace}:`,
            e?.message || e,
          )
        }
      } else if (isApiRequest) {
        console.warn(
          `[ESA/req:${reqId}] EdgeKV constructor NOT found — KV falls back to memory mode`,
        )
        const allKeys = Object.keys(globalThis as any)
        console.log(
          `[ESA/req:${reqId}] globalThis all keys (first 50): ${allKeys.slice(0, 50).join(",")}`,
        )
      }
    } else if (isApiRequest) {
      console.warn(
        `[ESA/req:${reqId}] env is undefined/null — fetch signature may be wrong`,
      )
    }

    const response = await app.fetch(request, env, context)

    // 【關鍵】對所有 /api/ GET 請求強制 no-cache，防止 ESA CDN 快取動態 API 響應。
    // 特別是 /api/public/settings：保存設置後立即刷新，CDN 可能返回快取的舊值，
    // 導致設置看起來"沒有保存"（站點標題在頁面頂部最明顯，最先被注意到）。
    if (request.method === "GET" && isApiRequest) {
      const newHeaders = new Headers(response.headers)
      newHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate")
      newHeaders.set("Pragma", "no-cache")
      newHeaders.set("Expires", "0")
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      })
    }

    return response
  },
}
