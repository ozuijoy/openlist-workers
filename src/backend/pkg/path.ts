/**
 * 路徑編碼工具（對齊 Go pkg/utils/path.go）。
 *
 * 獨立成文件是為了讓 internal/op/storage.ts 這類底層模塊能直接引用，
 * 而不必把 pkg/utils 的整條依賴鏈（hono / model/db / 其他子模塊）拉進來，
 * 避免 storage → utils → db → storage 的循環導入。
 */

/**
 * 逐段百分號編碼下載路徑（對齊 Go pkg/utils.EncodePath(path, true)）。
 *
 * Go 用的是 url.PathEscape 的 encodePath 模式：非保留字符 A-Za-z0-9-._~
 * 與子分隔符 $&+,:;=@ 原樣保留，其餘（`%`、`?`、`#`、空格、非 ASCII 等）
 * 逐字節百分號編碼；路徑分隔符 `/` 保留（Go 先按段切分再編碼，結果相同）。
 *
 * 為什麼下載鏈接必須編碼：raw_url 會被前端原樣當 href/src 使用
 *   - 路徑裡未編碼的 `?` / `#` 會被瀏覽器當成 query / fragment 截斷；
 *   - 路徑裡出現裸 `%`（如 "100%.txt"）會讓服務端 decodeURIComponent 拋
 *     URIError（raw.ts 的路徑解析），而 Go 因編碼了 `%` 不會遇到。
 */
export function encodeDownloadPath(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`
  return p.replace(/[^A-Za-z0-9\-_.~$&+,:;=@/]/gu, (ch) => {
    try {
      return encodeURIComponent(ch)
    } catch {
      // 孤立代理項等非法 UTF-16：原樣保留，絕不因編碼失敗拋錯
      return ch
    }
  })
}
