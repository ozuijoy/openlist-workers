// UrlTree driver types — 從文本定義的 URL 樹構建虛擬文件系統
export interface UrlTreeAddition {
  url_structure: string
  head_size?: boolean
  writable?: boolean
  root_folder_path?: string
}

export interface UrlTreeNode {
  url: string
  name: string
  level: number
  modified: number
  size: number
  children: UrlTreeNode[]
}
