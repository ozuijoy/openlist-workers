// 115 (115網盤 / 115 Open API) - Bearer Token 認證
// API reference: last branch src/drive/cloud115 (Open API)

export interface Driver115Addition {
  /** Open API 訪問令牌（必填） */
  access_token: string
  /** Open API 刷新令牌（必填） */
  refresh_token: string
  /** 根目錄文件夾 ID，默認 "0" */
  root_folder_id?: string
  /** 排序欄位 */
  order_by?: "file_name" | "file_size" | "user_utime" | "file_type"
  /** 排序方向 */
  order_direction?: "asc" | "desc"
}

// --- 115 Open API 響應類型 ---

/** Open API 文件對象（大寫欄位） */
export interface Cloud115File {
  Fid: string
  Fn: string
  /** "0" = 文件夾 */
  Fc: string
  FS: number
  Sha1?: string
  /** PickCode（下載用） */
  Pc?: string
  Thumbnail?: string
  Upt?: number
  Pid?: string
}

export interface Cloud115ListResp {
  state: boolean
  errcode?: number
  errno?: number
  error?: string
  count?: number
  offset?: number
  page_size?: number
  data?: Cloud115File[]
  // 舊格式（小寫欄位）相容
  files?: any[]
}

export interface Cloud115UserInfoResp {
  state: boolean
  data?: {
    user_id: string | number
    user_name: string
  }
}

export interface Cloud115DownResp {
  state: boolean
  url?: string
  data?: { url?: string }
}
