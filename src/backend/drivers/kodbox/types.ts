// kodbox (可道雲 / KodBox 自建網盤) - form POST + accessToken
// API reference: Go drivers/kodbox

export interface DriverKodboxAddition {
  /** KodBox 站點地址（如 https://kod.example.com） */
  address: string
  /** 登入用戶名 */
  username?: string
  /** 登入密碼 */
  password?: string
  /** 根目錄路徑（可選） */
  root_path?: string
}

export interface KodboxCommonResp {
  /** true/false（成功）或字符串錯誤碼 */
  code: boolean | string
  info?: string | boolean
  data?: any
}

export interface KodboxFolderOrFile {
  path: string
  name: string
  createTime: number
  modifyTime: number
  size: number
  type: string // "folder" | "file"
}

export interface KodboxListData {
  folderList: KodboxFolderOrFile[]
  fileList: KodboxFolderOrFile[]
}
