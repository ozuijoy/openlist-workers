/**
 * 輸入驗證模塊 (Input Validation)
 * 添加日期: 2026-09-05
 * 
 * 使用 Zod 進行類型安全的輸入驗證，防止注入攻擊和資料汙染
 */

import { z } from "zod"

// ============ 通用驗證器 ============

/**
 * 用戶名驗證（3-32 字符，僅字母數字下劃線）
 */
export const usernameSchema = z
  .string()
  .min(3, "Username must be at least 3 characters")
  .max(32, "Username must be at most 32 characters")
  .regex(/^[a-zA-Z0-9_]+$/, "Username can only contain letters, numbers, and underscores")

/**
 * 密碼驗證（8-128 字符，至少包含字母和數字）
 */
export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password must be at most 128 characters")
  .regex(/[a-zA-Z]/, "Password must contain at least one letter")
  .regex(/[0-9]/, "Password must contain at least one number")

/**
 * 郵箱驗證
 */
export const emailSchema = z
  .string()
  .email("Invalid email address")
  .max(255, "Email must be at most 255 characters")

/**
 * 路徑驗證（防止路徑遍歷攻擊）
 * 2026-09-08 增強：添加更多安全檢查
 */
export const pathSchema = z
  .string()
  .max(4096, "Path too long")
  .refine((path) => !path.includes(".."), "Path traversal detected")
  .refine((path) => !path.includes("\0"), "Null byte detected")
  .refine((path) => !path.includes("\r"), "Carriage return detected")
  .refine((path) => !path.includes("\n"), "Line feed detected")
  .refine((path) => !/^[A-Za-z]:/.test(path), "Absolute Windows path not allowed")
  .refine((path) => !path.startsWith("//") && !path.startsWith("\\\\"), "UNC path not allowed")

/**
 * TOTP 令牌驗證（6 位數字）
 */
export const totpTokenSchema = z
  .string()
  .length(6, "TOTP token must be 6 digits")
  .regex(/^\d{6}$/, "TOTP token must be numeric")

/**
 * 分頁參數驗證
 */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(1000).default(50),
})

// ============ API 請求驗證 ============

/**
 * 登入請求驗證
 */
export const loginRequestSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1, "Password is required"),
  totp_token: z.string().optional(), // 雙因素認證令牌（可選）
  remember: z.boolean().optional().default(false),
})

/**
 * 用戶創建請求驗證
 */
export const createUserRequestSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  role: z.number().int().min(0).max(3).default(1), // 0=超級管理員, 1=管理員, 2=普通用戶, 3=訪客
  permission: z.number().int().min(0).default(0),
  disabled: z.boolean().optional().default(false),
  base_path: pathSchema.optional(),
})

/**
 * 用戶更新請求驗證
 */
export const updateUserRequestSchema = z.object({
  password: passwordSchema.optional(),
  role: z.number().int().min(0).max(3).optional(),
  permission: z.number().int().min(0).optional(),
  disabled: z.boolean().optional(),
  base_path: pathSchema.optional(),
})

/**
 * 2FA 啟用請求驗證
 */
export const enable2FARequestSchema = z.object({
  token: totpTokenSchema, // 驗證用戶已正確配置 TOTP
})

/**
 * 文件操作請求驗證
 */
export const fileOperationRequestSchema = z.object({
  path: pathSchema,
  name: z.string().min(1).max(255).optional(),
  target: pathSchema.optional(),
})

/**
 * 設置更新請求驗證
 */
export const settingsUpdateRequestSchema = z.object({
  site_title: z.string().max(100).optional(),
  logo_url: z.string().url().max(500).optional(),
  allow_signup: z.boolean().optional(),
  default_role: z.number().int().min(0).max(3).optional(),
  session_timeout: z.number().int().min(300).max(86400).optional(), // 5 分鐘 ~ 24 小時
})

// ============ 驗證輔助函數 ============

/**
 * 驗證輸入並返回解析結果
 * @param schema Zod schema
 * @param data 待驗證資料
 * @returns { success, data?, error? }
 */
export function validate<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
): { success: true; data: T } | { success: false; error: string } {
  try {
    const parsed = schema.parse(data)
    return { success: true, data: parsed }
  } catch (err) {
    if (err instanceof z.ZodError) {
      const firstError = err.errors[0]
      const message = firstError ? `${firstError.path.join(".")}: ${firstError.message}` : "Validation failed"
      return { success: false, error: message }
    }
    return { success: false, error: "Unknown validation error" }
  }
}

/**
 * 驗證輸入並拋出異常（用於 async 路由）
 * @param schema Zod schema
 * @param data 待驗證資料
 * @returns 解析後的資料
 * @throws 驗證失敗時拋出錯誤
 */
export function validateOrThrow<T>(schema: z.ZodSchema<T>, data: unknown): T {
  return schema.parse(data)
}

/**
 * 安全驗證（不拋出異常，返回默認值）
 * @param schema Zod schema
 * @param data 待驗證資料
 * @param defaultValue 驗證失敗時的默認值
 * @returns 解析後的資料或默認值
 */
export function validateSafe<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
  defaultValue: T,
): T {
  try {
    return schema.parse(data)
  } catch {
    return defaultValue
  }
}

// ============ SQL 注入防護 ============

/**
 * 清理 SQL 查詢參數（雖然應該使用參數化查詢，但作為額外防護）
 */
export function sanitizeSQLInput(input: string): string {
  return input.replace(/['";\\]/g, "")
}

/**
 * 驗證排序欄位（防止 SQL 注入）
 */
export const sortFieldSchema = z.enum([
  "id",
  "name",
  "size",
  "modified",
  "created",
  "username",
  "role",
])

/**
 * 驗證排序方向
 */
export const sortOrderSchema = z.enum(["asc", "desc", "ASC", "DESC"])

// ============ XSS 防護 ============

/**
 * 轉義 HTML 特殊字符（防止 XSS）
 */
export function escapeHTML(input: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#x27;",
    "/": "&#x2F;",
  }
  return input.replace(/[&<>"'/]/g, (char) => map[char] || char)
}

/**
 * 清理用戶輸入的顯示文本（移除危險字符）
 */
export function sanitizeDisplayText(input: string): string {
  return input.replace(/[<>]/g, "").trim()
}

// ============ 導出所有驗證器 ============

export const validators = {
  username: usernameSchema,
  password: passwordSchema,
  email: emailSchema,
  path: pathSchema,
  totpToken: totpTokenSchema,
  pagination: paginationSchema,
  loginRequest: loginRequestSchema,
  createUserRequest: createUserRequestSchema,
  updateUserRequest: updateUserRequestSchema,
  enable2FARequest: enable2FARequestSchema,
  fileOperation: fileOperationRequestSchema,
  settingsUpdate: settingsUpdateRequestSchema,
  sortField: sortFieldSchema,
  sortOrder: sortOrderSchema,
}
