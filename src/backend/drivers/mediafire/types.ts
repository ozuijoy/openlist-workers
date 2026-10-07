// mediafire (MediaFire 網盤) - session_token 認證
// API base: https://www.mediafire.com/api/1.5

export interface DriverMediafireAddition {
  /** 登入 Cookie（必填，用於獲取 session_token） */
  cookie: string
  /** 會話 token（可選，缺省從 cookie 獲取） */
  session_token?: string
  /** 每頁數量 */
  chunk_size?: number
  /** 排序欄位 */
  order_by?: string
  /** 排序方向 */
  order_direction?: string
}

export interface MediafireFile {
  quickkey?: string
  folderkey?: string
  filename?: string
  name?: string
  size?: string
  created?: string
  isFolder: boolean
}

export interface MediafireApiResp<T = any> {
  response?: T
}

export interface MediafireContent {
  folder_content?: {
    folders?: { folderkey: string; name: string; created: string }[]
    files?: { quickkey: string; filename: string; size: string; created: string }[]
    more_chunks?: string
    chunk_size?: number
    chunk?: number
  }
  result?: string
}

export interface MediafireLinks {
  links?: { direct_download?: string; normal_download?: string }[]
  result?: string
}

export interface MediafireFolderCreate {
  folder_key?: string
  name?: string
  result?: string
}
