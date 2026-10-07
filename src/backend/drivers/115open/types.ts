// 115 Open (115網盤開放平台) driver types
// Re-ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/115_open
// (meta.go + types.go + 115-sdk-go types)

export interface Pan115Addition {
  /** 排序欄位: file_name / file_size / user_utime / file_type */
  order_by?: string
  /** 排序方向: asc / desc */
  order_direction?: string
  /** 所有 API 請求限速 ([limit]r/1s)，0 表示不限 */
  limit_rate?: number
  /** 列表分頁大小（1~1150，默認 200） */
  page_size?: number
  /** 訪問令牌（必填） */
  access_token?: string
  /** 刷新令牌（必填） */
  refresh_token?: string
  /** 根文件夾 ID，默認 "0" */
  root_id?: string
}

// --- API 響應類型（115 開放平台 proapi.115.com） ---

export interface Pan115Resp<T> {
  state: boolean
  code: number
  message: string
  data: T
}

export interface Pan115File {
  fid: string // 文件ID
  aid: string // 狀態 1 正常 7 回收站 120 徹底刪除
  pid: string // 父文件夾ID
  fc: string // 文件分類 0 文件夾 1 文件
  fn: string // 文件名
  fco: string // 文件夾封面
  pc: string // 文件提取碼
  upt: number // 修改時間
  uet: number // 修改時間
  uppt: number // 上傳時間
  sha1: string // 文件sha1
  fs: number // 文件大小
  ico: string // 後綴名
  thumbnail: string // 縮略圖
}

export interface Pan115GetFilesResp {
  state: boolean
  code: number
  message: string
  data: Pan115File[]
  count: number // 當前目錄文件數量
  offset: number
  limit: number
}

export interface Pan115UserInfoResp {
  user_id: number
  user_name: string
  user_face_s: string
  rt_space_info: {
    all_total: { size: string; size_format: string }
    all_remain: { size: string; size_format: string }
    all_use: { size: string; size_format: string }
  }
  vip_info: {
    level_name: string
    expire: number
  }
}

export interface Pan115FolderInfoResp {
  count: number
  size: string
  size_byte: number
  folder_count: number
  ptime: string
  utime: string
  file_name: string
  pick_code: string
  sha1: string
  file_id: string
  file_category: string
  paths: Array<{ file_id: string; file_name: string }>
}

export interface Pan115MkdirResp {
  file_name: string
  file_id: string
}

export interface Pan115DownUrlEntry {
  file_name: string
  file_size: number
  pick_code: string
  sha1: string
  url: { url: string }
}

export type Pan115DownUrlResp = Record<string, Pan115DownUrlEntry>

export interface Pan115UploadGetTokenResp {
  endpoint: string
  AccessKeySecret: string
  SecurityToken: string
  Expiration: string
  AccessKeyId: string
}

export interface Pan115UploadInitResp {
  pick_code: string
  status: number
  sign_key: string
  sign_check: string
  file_id: string
  target: string
  bucket: string
  object: string
  callback: {
    callback: string
    callback_var: string
  }
}
