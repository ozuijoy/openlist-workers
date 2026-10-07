// Baidu Netdisk driver types
// Re-ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/baidu_netdisk
// (types.go + meta.go)

export interface BaiduAddition {
  /** 排序欄位: name / time / size */
  order_by?: string
  /** 排序方向: asc / desc */
  order_direction?: string
  /** 下載 API: official / crack / crack_video */
  download_api?: string
  /** 使用在線 API 刷新 token（無需 ClientID/ClientSecret） */
  use_online_api?: boolean | string
  /** 在線 token API 地址 */
  api_url_address?: string
  /** 本地 OAuth 的 ClientID */
  client_id?: string
  /** 本地 OAuth 的 ClientSecret */
  client_secret?: string
  /** crack / crack_video 下載模式使用的 UA */
  custom_crack_ua?: string
  /** 已保存的 access token（自動持久化） */
  access_token?: string
  /** 刷新令牌（必填） */
  refresh_token: string
  /** 上傳執行緒數，默認 "3"，範圍 1~32 */
  upload_thread?: string
  /** 單個分片上傳超時（秒），默認 60 */
  upload_timeout?: number
  /** 上傳 API 域名，默認 https://d.pcs.baidu.com */
  upload_api?: string
  /** 動態獲取上傳域名，失敗時回退到 upload_api */
  use_dynamic_upload_api?: boolean | string
  /** 自定義分片大小，0 為自動 */
  custom_upload_part_size?: number
  /** 低帶寬上傳模式 */
  low_bandwith_upload_mode?: boolean | string
  /** 僅列出視頻文件 */
  only_list_video_file?: boolean | string
}

// --- API response types ---

export interface BaiduTokenResp {
  access_token?: string
  refresh_token?: string
  expires_in?: number
}

export interface BaiduTokenErrResp {
  error?: string
  error_description?: string
}

/** 在線 API 響應（api.oplist.org/baiduyun/renewapi） */
export interface BaiduOnlineTokenResp {
  refresh_token?: string
  access_token?: string
  text?: string
}

export interface BaiduFile {
  category: number
  fs_id: number
  size: number
  path: string
  server_filename: string
  md5: string
  isdir: number
  // list resp
  server_ctime: number
  server_mtime: number
  local_mtime: number
  local_ctime: number
  // only create and precreate resp
  ctime: number
  mtime: number
  thumbs?: {
    url3?: string
  }
}

export interface BaiduListResp {
  errno: number
  guid_info: string
  list: BaiduFile[]
  request_id: number
  guid: number
}

export interface BaiduDownloadResp {
  errmsg: string
  errno: number
  list: Array<{ dlink: string }>
  request_id: string
}

export interface BaiduDownloadResp2 {
  errno: number
  info: Array<{ dlink: string }>
  request_id: number
}

export interface BaiduPrecreateResp {
  errno: number
  request_id: number
  return_type: number
  // return_type=1
  path: string
  uploadid: string
  block_list: number[]
  // return_type=2
  info?: BaiduFile
  /** 斷點續傳對應的上傳域名（運行時快取，不來自 API） */
  upload_url?: string
}

export interface BaiduUploadServerResp {
  bak_server: any[]
  bak_servers: Array<{ server: string }>
  client_ip: string
  error_code: number
  error_msg: string
  expire: number
  host: string
  newno: string
  quic_server: any[]
  quic_servers: Array<{ server: string }>
  request_id: number
  server: any[]
  server_time: number
  servers: Array<{ server: string }>
  sl: number
}

export interface BaiduQuotaResp {
  errno: number
  request_id: number
  total: number
  used: number
}

export interface BaiduUinfoResp {
  errno: number
  request_id: number
  vip_type: number
  [k: string]: any
}

export interface BaiduRespBody {
  errno?: number
  error_code?: number
  error_msg?: string
  [k: string]: any
}
