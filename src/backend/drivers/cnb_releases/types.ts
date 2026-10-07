// cnb_releases (CNB 代碼託管 Releases) - Bearer token 認證
// API base: https://api.cnb.cool

export interface DriverCnbReleasesAddition {
  /** 倉庫 slug（org/repo） */
  repo: string
  /** 訪問令牌（必填） */
  token: string
  /** 使用 tag name 作為版本名 */
  use_tag_name?: boolean
  /** 新建 release 的目標分支 */
  default_branch?: string
}

export interface CNBAsset {
  id: string
  name: string
  size: number
  path: string
  created_at: string
  updated_at: string
}

export interface CNBRelease {
  id: string
  name: string
  tag_name: string
  created_at: string
  updated_at: string
  assets: CNBAsset[]
}
