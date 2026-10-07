// openlist_share (掛載 OpenList 分享鏈接) - 僅讀
// API reference: Go drivers/openlist_share

export interface DriverOpenlistShareAddition {
  /** 對端 OpenList 實例地址 */
  url: string
  /** 分享 ID */
  sid: string
  /** 分享密碼（可選） */
  pwd?: string
  /** 轉發歸檔請求（可選） */
  forward_archive_requests?: boolean
}

export interface OLShareResp<T = any> {
  code: number
  message: string
  data: T
}

export interface OLShareFile {
  name: string
  size: number
  is_dir: boolean
  modified: string
  created?: string
  thumb?: string
  sign?: string
  type?: number
}

export interface OLShareListData {
  content: OLShareFile[]
  total: number
  readme?: string
  write?: boolean
  provider?: string
}
