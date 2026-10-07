// chunk (分片打包儲存) - 將大文件切分為多個分片存入底層儲存
// API reference: Go drivers/chunk

export interface ChunkAddition {
  /** 底層儲存掛載路徑 */
  remote_path: string
  /** 分片大小（字節） */
  part_size: number
  /** 僅當文件大小 > part_size 時才分片 */
  chunk_large_file_only?: boolean
  /** 分片目錄前綴 */
  chunk_prefix?: string
  /** 分片文件後綴（可選） */
  custom_ext?: string
  /** 是否儲存 hash 文件 */
  store_hash?: boolean
  /** 列表併發數 */
  num_list_workers?: number
  /** 是否啟用縮略圖 */
  thumbnail?: boolean
  /** 是否顯示隱藏文件 */
  show_hidden?: boolean
}

export interface ChunkPart {
  name: string
  size: number
  modified: string
  raw_url: string
  raw_url_headers?: Record<string, string>
}
