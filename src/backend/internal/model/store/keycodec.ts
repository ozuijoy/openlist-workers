/**
 * KV 鍵名編碼。
 *
 * EdgeOne KV 的鍵名約束：**只能包含字母、數字和下劃線**（[A-Za-z0-9_]）。
 * Cloudflare KV 允許更寬的字符集，但為相容兩者，統一按最嚴格約束編碼。
 *
 * 鍵名形如 `<table>_<primaryKey>`：
 *   users_1
 *   settings_site_title                        ← 下劃線原樣保留
 *   users_550e8400x2de29b...                   ← UUID 的 '-' 轉義
 *
 * 編碼規則（儘量保留可讀性，只在必要時轉義）：
 *   - [A-Za-z0-9_] 原樣保留（下劃線合法，無需轉義）
 *   - 其他字符按 UTF-8 逐字節轉義為 `xHH`
 *
 * 關於 `x` 的歧義：`x` 屬於保留字符集會被原樣保留，因此形如 `ax2d` 的
 * 原始內容與「a + 轉義 '-'」無法區分。這不影響正確性 —— 鍵名僅作為
 * 儲存地址，實體的主鍵值一律取自記錄 JSON，從不需要從鍵名反解。
 * `decodeKeyPart` 僅用於排查問題時人工閱讀。
 */

/** 鍵名分隔符 */
const KEY_SEP = "_"

/**
 * 判斷字符是否屬於 KV 合法字符集（且無需轉義）。
 */
function isPlain(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") ||
    ch === "_"
  )
}

/**
 * 將任意字符串編碼為 KV 合法的鍵片段。
 *
 * 按 Unicode 碼點遍歷，避免拆散代理對（emoji）；多字節字符整體交給
 * TextEncoder 處理。空字符串映射為 `0`，否則會產生形如 `users_` 的鍵名，
 * 與表前綴無法區分。
 *
 * 導出供單元測試驗證「編碼結果合法 且 decodeKeyPart 可逆」。
 */
export function encodeKeyPart(input: string): string {
  const s = String(input ?? "")
  if (s === "") return "0"
  if (/^[A-Za-z0-9_]+$/.test(s)) return s // 快路徑：完全合法則原樣返回

  let out = ""
  for (const ch of s) {
    if (isPlain(ch)) {
      out += ch
    } else {
      for (const b of new TextEncoder().encode(ch)) {
        out += "x" + b.toString(16).padStart(2, "0")
      }
    }
  }
  return out
}

/**
 * 解碼鍵片段（僅用於排查問題與資料遷移，不參與正常讀寫路徑）。
 */
export function decodeKeyPart(input: string): string {
  const s = String(input ?? "")
  let out = ""
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch !== "x" || !/^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) {
      out += ch
      continue
    }
    // 收集連續的 xHH 字節後統一按 UTF-8 解碼（多字節字符會產生多組）
    const bytes: number[] = []
    let j = i
    while (s[j] === "x" && /^[0-9a-fA-F]{2}$/.test(s.slice(j + 1, j + 3))) {
      bytes.push(parseInt(s.slice(j + 1, j + 3), 16))
      j += 3
    }
    try {
      out += new TextDecoder().decode(new Uint8Array(bytes))
    } catch {
      for (const b of bytes) out += String.fromCharCode(b)
    }
    i = j - 1
  }
  return out
}

/** 構造某張表的鍵名前綴，如 `users_` */
export function tableKeyPrefix(table: string): string {
  return `${encodeKeyPart(table)}${KEY_SEP}`
}

/** 構造實體完整鍵名，如 `users_1` */
export function entityKeyOf(table: string, id: string): string {
  return `${tableKeyPrefix(table)}${encodeKeyPart(id)}`
}
