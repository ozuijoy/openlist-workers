// cloudreve_v4 (Cloudreve V4 自建網盤) - RESTful API
// API reference: last branch src/drive/cdrevev4

export interface DriverCloudreveAddition {
  /** Cloudreve 站點地址（含協議，如 https://cloud.example.com） */
  address: string
  /** 登入用戶名（可選，提供則密碼登入） */
  username?: string
  /** 登入密碼（可選） */
  password?: string
  /** 訪問令牌（可選，直接使用） */
  access_token?: string
  /** 刷新令牌（可選） */
  refresh_token?: string
  /** 自定義 User-Agent */
  custom_ua?: string
  /** 啟用縮略圖 */
  enable_thumb?: boolean
  /** 排序欄位 */
  order_by?: string
  /** 排序方向 */
  order_direction?: string
}

export interface CloudreveFile {
  id: string
  path: string
  name: string
  size: number
  /** 0=文件, 1=目錄 */
  type: number
  created_at: string
  updated_at: string
}

export interface CloudreveListResp {
  files: CloudreveFile[]
  pagination: { next_token: string }
}

export interface CloudreveUrlResp {
  urls: { url: string }[]
}
