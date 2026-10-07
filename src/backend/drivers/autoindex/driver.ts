// AutoIndex driver - Nginx/靜態目錄索引適配器
// Ported from: OpenList-Backends/drivers/autoindex
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { AutoIndexAddition, AutoIndexNode } from "./types"
import { parseAutoIndexHTML, parseSize, parseTime } from "./util"

const DefaultItemXPath = "//pre/a"
const DefaultNameXPath = "@href"
const DefaultSizeXPath = "string(following-sibling::text()[1])"
const DefaultModifiedXPath = "string(following-sibling::text()[2])"
const FETCH_TIMEOUT_MS = 30_000

export function normalizeAutoIndexAddition(a: any): AutoIndexAddition {
  const norm = { ...(a || {}) } as any
  norm.url = (norm.url || "").trim()
  // Go: 無 scheme 則補 https://，無尾斜槓則補 /
  if (norm.url && !/:\/\//.test(norm.url)) norm.url = "https://" + norm.url
  if (norm.url && !norm.url.endsWith("/")) norm.url += "/"
  norm.item_xpath = norm.item_xpath || DefaultItemXPath
  norm.name_xpath = norm.name_xpath || DefaultNameXPath
  norm.size_xpath = norm.size_xpath || DefaultSizeXPath
  norm.modified_xpath = norm.modified_xpath || DefaultModifiedXPath
  norm.modified_time_format = norm.modified_time_format || ""
  norm.ignore_file_names = norm.ignore_file_names || ""
  return norm as AutoIndexAddition
}

export class AutoIndexDriver implements StorageDriver {
  private addition: AutoIndexAddition
  private ignoreNames: string[] = []

  constructor(addition: any) {
    this.addition = normalizeAutoIndexAddition(addition)
    // Go 用換行分隔 ignore 列表；相容逗號分隔
    if (this.addition.ignore_file_names) {
      this.ignoreNames = this.addition.ignore_file_names
        .split(/\r?\n|,/)
        .map((s) => s.trim())
        .filter((s) => s)
    }
  }

  async init(): Promise<void> {
    if (!this.addition.url) throw new Error("url is required")
  }

  private cleanRel(p: string): string {
    return (p || "").split("/").filter(Boolean).join("/")
  }

  // 目錄 URL（帶尾斜槓，供相對 href 正確拼接）
  private buildDirURL(physicalPath: string): string {
    const rel = this.cleanRel(physicalPath)
    return this.addition.url + rel + (rel ? "/" : "")
  }

  private nodeToFileItem(node: AutoIndexNode, baseURL: string): FileItem {
    const fullURL = new URL(node.url, baseURL).toString()
    const isDir = node.isDir
    return {
      name: node.name,
      size: node.size ? parseSize(node.size) : 0,
      is_dir: isDir,
      modified: node.modified
        ? parseTime(node.modified, this.addition.modified_time_format || "")
        : new Date().toISOString(),
      // sign 保留給下載簽名（pkg/sign），不可塞入 URL，否則前端會拼出無效
      // ?sign=http://... 導致簽名校驗 401。直鏈走 raw_url。
      sign: "",
      type: calcFileType(node.name, isDir),
      raw_url: isDir ? "" : fullURL,
    }
  }

  async list(virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const baseURL = this.buildDirURL(physicalPath)
    // 邊緣運行時通常會等到平台級超時（EdgeOne 為 120 秒）才中止不可達的
    // 上游請求。顯式限制單次目錄讀取，避免一個失聯的 AutoIndex 掛載長期佔用
    // 實例並拖累同一服務的其他請求。
    const res = await fetch(baseURL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      throw new Error(`Failed to fetch ${baseURL}: HTTP ${res.status}`)
    }
    const html = await res.text()

    const nodes = parseAutoIndexHTML(
      html,
      this.addition.item_xpath || DefaultItemXPath,
      this.addition.name_xpath || DefaultNameXPath,
      this.addition.size_xpath || DefaultSizeXPath,
      this.addition.modified_xpath || DefaultModifiedXPath,
      this.ignoreNames,
    )

    const items: FileItem[] = nodes
      .filter((n) => n.name !== ".." && n.name !== ".")
      .map((n) => this.nodeToFileItem(n, baseURL))

    return sortFileItems(items, "name", "asc")
  }

  async get(virtualPath: string, physicalPath: string): Promise<FileItem> {
    const rel = this.cleanRel(physicalPath)
    const name = rel.split("/").filter(Boolean).pop() || "root"

    if (!rel) {
      return {
        name: "root",
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: this.addition.url,
        type: 1,
      }
    }

    // 靜態服務：文件 URL 即 根 URL + 相對路徑
    const fullURL = this.addition.url + rel
    return {
      name,
      size: 0,
      is_dir: false,
      modified: new Date().toISOString(),
      sign: fullURL,
      type: calcFileType(name, false),
      raw_url: fullURL,
    }
  }

  async mkdir(virtualPath: string, physicalPath: string): Promise<void> {
    throw new Error("AutoIndex is read-only")
  }

  async rename(
    virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    throw new Error("AutoIndex is read-only")
  }

  async remove(
    virtualPath: string,
    physicalPath: string,
    names: string[],
  ): Promise<void> {
    throw new Error("AutoIndex is read-only")
  }

  async move(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    throw new Error("AutoIndex is read-only")
  }

  async copy(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    throw new Error("AutoIndex is read-only")
  }

  async put(
    virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    throw new Error("AutoIndex is read-only")
  }
}
