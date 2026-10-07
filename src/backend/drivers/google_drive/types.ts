// Google Drive 驅動配置類型
export interface GoogleDriveAddition {
  root_folder_id?: string
  refresh_token: string
  order_by?: string
  order_direction?: string
  // 在線 API 中轉模式（推薦，無需 client_id）
  use_online_api?: boolean
  api_url_address?: string
  // 直連 OAuth 模式（需要自己的 Google Cloud 應用）
  client_id?: string
  client_secret?: string
  // 上傳塊大小（MB）
  chunk_size?: number
}

// Google Drive API 文件類型
export interface GoogleFile {
  id: string
  name: string
  mimeType: string
  size?: string
  modifiedTime?: string
  createdTime?: string
  thumbnailLink?: string
  md5Checksum?: string
  sha1Checksum?: string
  sha256Checksum?: string
  shortcutDetails?: {
    targetId?: string
    targetMimeType?: string
  }
}

export const GOOGLE_DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder"
export const GOOGLE_DRIVE_SHORTCUT_MIME = "application/vnd.google-apps.shortcut"

// Google Drive 列表 API 請求欄位
export const FILES_LIST_FIELDS =
  "files(id,name,mimeType,size,modifiedTime,createdTime,thumbnailLink,shortcutDetails,md5Checksum,sha1Checksum,sha256Checksum),nextPageToken"
