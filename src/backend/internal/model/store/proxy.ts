/**
 * KV HTTP 代理共享實現（EdgeOne Node 雲函數專用）。
 *
 * 背景：EdgeOne 的 KV 綁定僅注入到 Edge Functions（V8 運行時），不會注入到
 * Node 雲函數（SCF）。因此 Node 側拿不到 binding，必須經同部署的 Edge Function
 * （functions/kv-get|kv-put|kv-delete|kv-list）代為訪問 KV。
 *
 * 本模塊是該代理協議的**唯一實現**，被兩處消費：
 *   - driver/kv.ts  —— 業務資料讀寫（Driver 介面）
 *   - store/json.ts —— 密鑰/黑名單等既有 binding 形態調用方
 * 放在獨立模塊是為了避免 json.ts ↔ driver/kv.ts 互相導入形成循環依賴。
 */

/**
 * 校驗並歸一化 KV 代理目標 origin。
 *
 * 安全背景：`__requestOrigin` 由中間件從 `c.req.url` 派生，而後者源自請求的
 * Host 頭。若平台未嚴格校驗 Host，攻擊者構造 `Host: evil.com` 可能讓 Node 側
 * 把攜帶 **完整 JWT_SECRET** 的 `X-Internal-Call` 請求發往攻擊者伺服器（SSRF
 * 兼密鑰洩漏）。因此這裡做三重約束：
 *
 *  1. **必須是 http/https 絕對地址**（拒絕相對路徑、協議相對 URL）；
 *  2. **必須是能解析出 hostname 的合法 URL**；
 *  3. **生產環境（非 localhost）必須為 https**，避免明文傳輸密鑰。
 *
 * 顯式配置的 `EO_KV_URLS` 視為可信（運維意圖），但仍需通過 1/2；
 * 對它的 https 要求放寬，便於本地 http 調試。
 *
 * 刻意**不做**內網地址（RFC1918 / 雲元資料 169.254.169.254）黑名單：
 *   - 該類校驗需先做 DNS 解析才能防住重綁定，而邊緣運行時無法可靠解析；
 *   - 純字符串判斷防不住 `evil.com -> 內網IP` 的解析結果，屬虛假安全感；
 *   - 會誤傷合法的內網自託管部署（`EO_KV_URLS` 本就可指向內網 origin）。
 * 真正的防線是上面第 3 條：請求派生的 origin 必須是 https，且 Host 由
 * 平台校驗，攻擊者無法在不控制 Host 的前提下把密鑰外發出去。
 *
 * @returns 歸一化後的 origin（去掉結尾 `/`），不可用時返回 null
 */
export function sanitizeProxyOrigin(raw: any, env?: any): string | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }

  // 僅允許 http / https，拒絕其他協議（file:、ftp: 等）
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  if (!url.hostname) return null

  // 顯式配置的基址視為可信來源，僅做協議與 hostname 校驗
  const explicit = env?.EO_KV_URLS
  const isExplicit = typeof explicit === "string" && explicit.trim() === trimmed

  if (!isExplicit) {
    const isLocal =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]"
    // 請求派生的 origin 在非本地環境必須為 https，杜絕明文外發密鑰
    if (!isLocal && url.protocol !== "https:") {
      console.warn(
        "[DB] Rejecting non-HTTPS proxy origin derived from request: " +
          `${url.protocol}//${url.hostname} (would leak X-Internal-Call in clear text)`,
      )
      return null
    }
  }

  return `${url.protocol}//${url.host}`.replace(/\/$/, "")
}
