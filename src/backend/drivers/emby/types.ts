// Emby driver types
// Ported from: OpenList-Backends/drivers/emby

export interface EmbyAddition {
  /** Emby 伺服器地址，例如 http://localhost:8096 */
  url: string
  api_key: string
  user_id: string
  username: string
  password: string
  /** stream | download */
  link_method: string
  /** 根目錄 ID（虛擬視圖/文件夾 ID），默認 "1" */
  root_folder_id: string
}

export interface EmbyAuthResp {
  AccessToken: string
  User: { Id: string }
}

export interface EmbyItem {
  Name: string
  Id: string
  Type: string
  Path: string
  SeriesName: string
  IndexNumber: number
  ParentIndexNumber: number
  IsFolder: boolean
  Size: number
  DateCreated: string
}

export interface EmbyListResp {
  Items: EmbyItem[]
  TotalRecordCount: number
}

export interface EmbyMediaSource {
  Id: string
  Container: string
  SupportsDirectStream: boolean
}

export interface EmbyItemDetailResp {
  MediaSources: EmbyMediaSource[]
}
