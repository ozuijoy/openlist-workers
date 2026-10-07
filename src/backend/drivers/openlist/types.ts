// openlist (掛載另一個 OpenList 實例) - 直接調用對端 /api/fs/* 介面
// API reference: last branch src/drive/openlist

export interface DriverOpenlistAddition {
  /** 對端 OpenList 實例地址 */
  url: string
  /** 登入用戶名（可選，提供則密碼登入） */
  username?: string
  /** 登入密碼（可選） */
  password?: string
  /** 訪問 token（可選，直接使用） */
  token?: string
  /** 元信息密碼（可選） */
  meta_password?: string
  /** 根目錄 */
  root_path?: string
}

export interface OLFile {
  name: string
  size: number
  is_dir: boolean
  modified: string
  created?: string
  thumb?: string
  sign?: string
  raw_url?: string
}

export interface OLResp<T = any> {
  code: number
  message: string
  data: T
}

export interface OLListData {
  content: OLFile[]
  total: number
}

export interface OLGetData {
  name: string
  size: number
  is_dir: boolean
  modified: string
  raw_url: string
  sign: string
}
