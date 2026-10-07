// 123 Cloud Drive (123Pan) driver types
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/123

export interface Pan123Addition {
  /** 用戶名（手機號或郵箱） */
  username: string
  /** 密碼 */
  password: string
  /** 根文件夾 ID，默認為 0（根目錄） */
  root_id?: string
  /** 上傳執行緒數，默認 3 */
  upload_thread?: number
  /** 請求使用的 platform header，默認 "web" */
  platform?: string
  /** 排序欄位 */
  order_by?: "file_id" | "file_name" | "size" | "created_at" | "updated_at"
  /** 排序方向 */
  order_direction?: "asc" | "desc"
  /**
   * 已保存的登入令牌。設置後優先用令牌驗證（避免境外 IP 風控）；
   * 密碼登入或 cookie 解析成功後會持久化回此欄位。
   */
  access_token?: string
  /**
   * 瀏覽器 Cookie（可選）。從 123 網盤網頁登入後複製的 Cookie 字符串，
   * 或僅粘貼 `Authorization: Bearer <token>` 中的 token / Bearer 值。
   * 解析出其中的 JWT 後用作 Bearer 令牌，效果等同 access_token，
   * 適合 Cloudflare Workers 等出口 IP 被風控、賬號密碼登入失敗的環境。
   */
  cookie?: string
}

// --- API response types ---

export interface Pan123File {
  FileId: number
  FileName: string
  Size: number
  Type: number // 0 = file, 1 = folder
  UpdateAt: string // ISO 8601 timestamp
  Etag: string
  S3KeyFlag: string
  DownloadUrl?: string
}

export interface Pan123FilesResp {
  code: number
  message?: string
  data: {
    Next: string
    Total: number
    InfoList: Pan123File[]
  }
}

export interface Pan123LoginResp {
  code: number
  message?: string
  data: {
    token: string
  }
}

export interface Pan123DownloadResp {
  code: number
  message?: string
  data: {
    DownloadUrl: string
  }
}

export interface Pan123UserInfoResp {
  code: number
  data: {
    UID: number
    Nickname: string
    SpaceUsed: number
    SpacePermanent: number
    SpaceTemp: number
    FileCount: number
  }
}

export interface Pan123MkdirResp {
  code: number
  message?: string
  data: {
    FileId: number
  }
}

export interface Pan123BaseResp {
  code: number
  message?: string
}

// --- 上傳（S3 分片會話）響應類型 ---

/** 創建上傳會話（/file/upload_request, type=0）的返回 */
export interface Pan123UploadResp {
  code: number
  message?: string
  data: {
    /** AWS 直傳憑據（若有則走 AWS SDK 路徑，本驅動不使用） */
    AccessKeyId: string
    SecretAccessKey: string
    SessionToken: string
    /** S3 預簽名分片上傳所需欄位 */
    Bucket: string
    Key: string
    UploadId: string
    FileId: number
    StorageNode: string
    EndPoint: string
    /** 命中秒傳時為 true（文件已存在，無需實際上傳） */
    Reuse: boolean
  }
}

/** 獲取 S3 預簽名 URL（/file/s3_upload_object/auth 或 /file/s3_repare_upload_parts_batch）的返回 */
export interface Pan123S3PreSignedURLs {
  code: number
  message?: string
  data: {
    /** 分片號(字符串) → 該分片的預簽名 PUT URL */
    presignedUrls: Record<string, string>
  }
}
