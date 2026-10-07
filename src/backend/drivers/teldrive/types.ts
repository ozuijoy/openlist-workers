// teldrive (Telegram Drive 自託管) - Bearer token 認證
// API reference: last branch src/drive/teldrive

export interface DriverTeldriveAddition {
  /** TelDrive 服務地址 */
  url: string
  /** 訪問令牌（JWT） */
  access_token: string
  /** 根路徑 */
  root_path?: string
}

export interface TeldriveFile {
  id: string
  name: string
  /** "folder" | "file" */
  type: string
  mimeType: string
  size: number
  parentId: string
  createdAt: string
  updatedAt: string
}
