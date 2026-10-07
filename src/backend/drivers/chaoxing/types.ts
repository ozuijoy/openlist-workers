// chaoxing (超星小組網盤) - Cookie 認證 + AES 登入
// API reference: Go drivers/chaoxing

export interface DriverChaoXingAddition {
  user_name: string
  password: string
  bbsid: string
  root_folder_id?: string
  cookie?: string
}

// 手機端學習通上傳的文件 content 欄位與網頁端不同：
// 網頁端 json `"puid": 54321, "size": 12345`
// 手機端 json `"puid": "54321", "size": "12345"`
export interface ChaoXingFileContent {
  folderName?: string
  name?: string
  fileId?: string
  objectId?: string
  size?: number | string
  uploadDate?: number
}

export interface ChaoXingFile {
  id: number
  inserttime?: number
  content: ChaoXingFileContent
}

export interface ChaoXingListResp {
  msg?: string
  result?: number
  status?: boolean
  list?: ChaoXingFile[]
}

export interface ChaoXingDownResp {
  msg?: string
  download?: string
  fileStatus?: string
  status?: boolean
}

export interface ChaoXingUploadConfigResp {
  result?: number
  msg?: {
    puid?: number
    token?: string
  }
}

export interface ChaoXingUploadFileResp {
  result?: boolean
  msg?: string
  objectId?: string
  data?: Record<string, unknown>
}
