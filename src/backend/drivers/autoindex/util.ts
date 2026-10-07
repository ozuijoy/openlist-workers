// AutoIndex utility functions
import * as xpath from "xpath"
import { DOMParser } from "@xmldom/xmldom"
import { parse, serialize } from "parse5"
import { AutoIndexNode } from "./types"

/**
 * 從 xpath.select 的返回中提取字符串值。
 * xpath 庫對 string()/number() 等表達式返回原始值（string/number），
 * 對 node-set 表達式返回數組。這裡統一相容兩種情況。
 */
function extractXPathValue(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw.trim() || undefined
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw)
  if (Array.isArray(raw) && raw.length > 0) {
    const first = raw[0] as any
    const v = (first?.nodeValue ?? first?.textContent ?? "").trim()
    return v || undefined
  }
  return undefined
}

// 將寬鬆 HTML 清洗為可被 XML 解析器（xmldom）解析的良構 XML：
// 1) 先用 parse5 按 HTML5 容錯規則修復未閉合/錯位/重複標籤；
// 2) 移除 XML 不需要的 DOCTYPE、註釋和 script/style；
// 3) 把 void 標籤（<hr>/<meta>/<br> 等）轉為自閉合。
//
// 不能直接把遠端 HTML 交給 xmldom 的 XML 模式：真實目錄頁常包含瀏覽器可以
// 正常處理的非嚴格 HTML。例如 archive.apache.org/dist/tomcat/ 同時有重複的
// html/body/pre 標籤，舊實現會拋 "Opening and ending tag mismatch"。parse5 與
// Go 版 htmlquery 底層的 HTML parser 一樣會容錯，再轉 XML 後仍可繼續使用用戶
// 配置的無前綴 XPath（如 //pre/a）。
//
// 注意：若直接用 xmldom 的 text/html 模式，它會注入 XHTML 命名空間，導致
// //pre/a 匹配不到。
const HTML_VOID_TAGS =
  "area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr"

function htmlToXml(html: string): string {
  let s = serialize(parse(html))
  s = s.replace(/<!DOCTYPE[^>]*>/gi, "")
  s = s.replace(/<!--[\s\S]*?-->/g, "")
  // script/style 的 raw text 可以包含 XML 非法的裸 <、&；AutoIndex XPath 不會
  // 依賴這些內容，移除可避免第二階段 XML 解析被無關腳本或樣式破壞。
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
  s = s.replace(
    new RegExp(`<(${HTML_VOID_TAGS})([^>]*?)/?\\s*>`, "gi"),
    "<$1$2/>",
  )
  return s
}

export function parseAutoIndexHTML(
  html: string,
  itemXPath: string,
  nameXPath: string,
  sizeXPath: string,
  modifiedXPath: string,
  ignoreNames: string[],
): AutoIndexNode[] {
  // @xmldom/xmldom >= 0.9 已廢棄 errorHandler，改用 onError 回調
  const doc = new DOMParser({
    onError: () => {},
  }).parseFromString(htmlToXml(html), "text/xml")

  const items = xpath.select(itemXPath, doc as unknown as Node) as Node[]
  const result: AutoIndexNode[] = []

  for (const item of items) {
    try {
      const nameNodes = xpath.select(nameXPath, item) as Node[]
      if (nameNodes.length === 0) continue

      const nameNode = nameNodes[0]
      let name = ""
      let url = ""

      if (nameNode.nodeType === 1) {
        // Element node
        const element = nameNode as Element
        name = element.textContent?.trim() || ""
        url = element.getAttribute("href") || ""
      } else if (nameNode.nodeType === 2) {
        // Attribute node
        const attr = nameNode as Attr
        name = attr.value.trim()
        url = attr.value
      } else {
        name = nameNode.textContent?.trim() || ""
      }

      // 與 Go 一致：先 CutSuffix 去掉目錄尾斜槓，再判斷是否命中忽略列表
      const isDir = name.endsWith("/")
      if (isDir) {
        name = name.slice(0, -1)
      }

      if (!name || ignoreNames.includes(name)) continue

      const size = extractXPathValue(xpath.select(sizeXPath, item))
      const modified = extractXPathValue(xpath.select(modifiedXPath, item))

      result.push({
        name,
        url,
        isDir,
        size,
        modified,
      })
    } catch (e) {
      // Skip invalid items
    }
  }

  return result
}

// 與 Go 側 units 映射對齊（支持 KiB/MiB/GiB/TiB/PiB、KB/MB/GB/TB/PB、bytes 等）
const sizeUnits: Record<string, number> = {
  "": 1,
  b: 1,
  byte: 1,
  bytes: 1,
  k: 1 << 10,
  kb: 1 << 10,
  kib: 1 << 10,
  m: 1 << 20,
  mb: 1 << 20,
  mib: 1 << 20,
  g: 1 << 30,
  gb: 1 << 30,
  gib: 1 << 30,
  t: 1 << 40,
  tb: 1 << 40,
  tib: 1 << 40,
  p: 1 << 50,
  pb: 1 << 50,
  pib: 1 << 50,
}

function splitUnit(s: string): [string, string] {
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] >= "0" && s[i] <= "9") {
      return [s.slice(0, i + 1).trim(), s.slice(i + 1).trim()]
    }
  }
  return ["", s]
}

export function parseSize(sizeStr: string): number {
  if (!sizeStr || sizeStr.trim() === "-") return 0
  const s = sizeStr.trim()
  const [numStr, unitStr] = splitUnit(s)
  const unit = unitStr.toLowerCase()
  const mul = sizeUnits[unit] ?? 1
  const num = parseFloat(numStr)
  if (isNaN(num)) return 0
  return Math.round(num * mul)
}

export function parseTime(timeStr: string, format: string): string {
  if (!timeStr) return new Date().toISOString()

  try {
    // Simple date parsing - support common formats
    // Go format: Mon Jan 2 15:04:05 -0700 MST 2006
    // Common formats: "2006-01-02 15:04", "02-Jan-2006 15:04", etc.

    // Try ISO format first
    const isoMatch = timeStr.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/)
    if (isoMatch) {
      const [, year, month, day, hour, minute] = isoMatch
      return new Date(
        `${year}-${month}-${day}T${hour}:${minute}:00`,
      ).toISOString()
    }

    // Try common formats
    const parsed = new Date(timeStr)
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString()
    }
  } catch (e) {
    // Ignore parse errors
  }

  return new Date().toISOString()
}
