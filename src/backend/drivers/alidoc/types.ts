// AliDoc (釘釘文件) driver types
// Ported from: OpenList-Backends/drivers/alidoc

export interface AliDocAddition {
  /** 釘釘文件網頁 Cookie */
  cookie: string
  /** 根目錄 dentryUuid */
  root_folder_id: string
}

export interface AliDocApiResp {
  status: number
  isSuccess: boolean
  message?: string
  msg?: string
}

export interface AliDocDentry {
  dentryType: string
  dentryUuid: string
  parentDentryUuid: string
  name: string
  path: string
  fileSize: number
  createdTime: number
  updatedTime: number
  contentType: string
  extension: string
  dentryStatistic?: { childrenCount: number }
}

export interface AliDocListResp extends AliDocApiResp {
  data: { children: AliDocDentry[] }
}

export interface AliDocDownloadResp extends AliDocApiResp {
  data: {
    ossUrlPreSignatureInfo: { preSignUrls: string[] }
  }
}
