/**
 * 儲存配置錯誤的「可展示化」工具：脫敏 + 截斷 + 建議組裝。
 *
 * 單獨成模塊的原因：兩處都需要同一套規則，而它們位於不同層次 ——
 *   - server/public.ts：免鑑權診斷介面（env_check / init_status / init/setup）
 *   - index.ts：全局 503 攔截中間件
 * 若各自實現一份，兩處給出的粒度（幾行、是否帶建議）遲早會漂移，用戶會在
 * 「同一個問題、兩個說法」之間反覆排查。
 */

/**
 * 對單行文本做脫敏（供免鑑權介面使用）。
 *
 * 目標：保留「問題類別」的可操作性，同時抹掉可能洩漏實現細節的部分：
 *   - 抹除形如 `scheme://user:pass@host` 的連接串憑據
 *   - 抹除常見的 key=value 形式的令牌
 *   - 截斷長度，避免回顯大段內部信息
 */
function scrub(s: string): string {
  let out = String(s).trim()
  out = out.replace(/(\w+:\/\/)[^/@\s]+@/g, "$1***@")
  out = out.replace(
    /\b(token|secret|password|passwd|pwd|api[_-]?key)\s*[=:]\s*\S+/gi,
    "$1=***",
  )
  const MAX = 160
  return out.length > MAX ? out.slice(0, MAX) + "…" : out
}

/**
 * 配置類錯誤的展示行數上限。
 *
 * 這些碼對應的是**我們自己**寫的多行提示（組合非法 / 驅動不可用 / 無儲存 /
 * 代理未配置），後續行才是「怎麼改」，必須展示出來；
 * 而運行期錯誤（HEALTH_ERROR 等）可能含內部主機名，僅取首行。
 */
const MULTILINE_ERROR_CODES = new Set([
  "INVALID_COMBINATION",
  "DRIVER_UNAVAILABLE",
  "UNKNOWN_DRIVER",
  "NO_STORAGE",
  "PROXY_CONFIG",
  "DRIVER_ERROR",
])

/**
 * 取出用於展示的最大行數。
 *
 * ⚠️ 使用約束（改文案時務必遵守）：這裡僅透傳前 N 行，因此**我們自己寫的多行
 * 提示，前 3 行必須自包含** —— 結論、答案、下一步動作都要落在前 3 行內。
 * 曾經的教訓：把「Auto-detection would pick: DB_DRIVER=d1」放在第 7 行，結果被
 * 截掉，用戶在界面上僅看到一段被砍斷的說明，根本不知道該改成什麼。
 * 另外每行還會被 scrub() 截到 160 字符，單行不要寫太長。
 */
export function reasonLines(code?: string | null): number {
  return code && MULTILINE_ERROR_CODES.has(code) ? 3 : 1
}

/**
 * 給界面用的一行短原因。
 *
 * 僅取首行：我們自己的多行提示都按「首行 = 原因，後續行 = 排查與修復方向」
 * 排列，所以首行天然是完整的一句 —— 界面不會出現被截斷的半句 + 省略號。
 * 完整說明仍在 message 欄位裡，供日誌與工具使用。
 */
export function storageErrorSummary(raw: any): string | null {
  if (raw === null || raw === undefined) return null
  const first = String(raw)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  return first ? scrub(first) : null
}

/**
 * 對錯誤文本做脫敏，供免鑑權介面使用。
 *
 * 默認僅保留首行（去掉多行堆棧）；`maxLines` 用於我們自己的、多行且
 * 可操作的配置類錯誤（如「組合非法 + 該驅動支持哪些格式 + 怎麼改」）。
 */
export function redact(raw: any, maxLines = 1): string {
  if (raw === null || raw === undefined) return "unknown error"
  const lines = String(raw)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, Math.max(1, maxLines))
    .map(scrub)
  return lines.length ? lines.join(" ") : "unknown error"
}

/**
 * 把儲存配置錯誤整理成「前端可直接展示」的形狀。
 *
 *   - reason：截斷後的原因（控制長度，避免把整段排查說明糊到界面上）
 *   - suggestion：一句話修復建議（「改什麼」，前端置頂展示）
 */
export function uiStorageError(detail: {
  code: string | null
  message: string | null
  suggestion: string | null
}): { reason: string | null; suggestion: string | null } {
  return {
    reason: detail.message
      ? redact(detail.message, reasonLines(detail.code))
      : null,
    suggestion: detail.suggestion,
  }
}
