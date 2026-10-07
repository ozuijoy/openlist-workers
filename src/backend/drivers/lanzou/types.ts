// Lanzou (藍奏雲) driver types
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/lanzou

export interface LanzouAddition {
  /** 掛載模式：cookie（推薦）、account（賬號密碼）、url（公開分享鏈接） */
  type?: "cookie" | "account" | "url"

  /** 賬號（手機號/UID），account 模式使用 */
  account?: string
  /** 密碼，account 模式使用 */
  password?: string

  /** 登入 Cookie（含 ylogin, phpdisk_info 等），cookie 模式使用 */
  cookie?: string

  /** 根文件夾 ID / 分享 ID（個人盤默認 -1，分享鏈接填分享 ID 如 b00xxxx） */
  root_folder_id?: string
  /** 提取碼 / 分享密碼 */
  share_password?: string

  /** 基礎 API 域名，默認 https://pc.woozooo.com */
  baseUrl?: string
  /** 分享頁面域名，默認 https://pan.lanzoui.com */
  shareUrl?: string
  /** User-Agent 請求頭 */
  user_agent?: string

  /** 是否通過 HEAD 請求修正文件精確大小與修改時間 */
  repair_file_info?: boolean

  /** 排序欄位 */
  order_by?: "name" | "size" | "time"
  /** 排序方向 */
  order_direction?: "asc" | "desc"
}

export interface LanzouFileOrFolder {
  name?: string
  id?: string
  name_all?: string
  size?: string
  time?: string
  fol_id?: string
  is_folder?: boolean
  url?: string
  pwd?: string
}

export interface LanzouFileShare {
  pwd?: string
  onof?: string
  taoc?: string
  is_newd?: string
  f_id?: string
  new_url?: string
  name?: string
  des?: string
}

export interface LanzouShareResp<T = any> {
  dom?: string
  url?: string
  inf?: T
  zt?: number
  info?: string
  text?: any
}
