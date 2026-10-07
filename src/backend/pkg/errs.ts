export enum ErrorCode {
  OK = 200,
  BadRequest = 400,
  Unauthorized = 401,
  Forbidden = 403,
  NotFound = 404,
  InternalError = 500,

  // Custom AList/OpenList codes
  InvalidConfig = 1001,
  InvalidStorage = 1002,
  StorageNotReady = 1003,
  PathNotFound = 1004,
  AccountNotFound = 1005,
  TaskNotFound = 1006,
}

export class OpenListError extends Error {
  constructor(
    public code: ErrorCode,
    public message: string,
    public originalError?: any,
  ) {
    super(message)
    this.name = "OpenListError"
  }
}

export const Errs = {
  PathNotFound: new OpenListError(ErrorCode.PathNotFound, "Path not found"),
  NotReady: new OpenListError(ErrorCode.StorageNotReady, "Storage not ready"),
  InvalidConfig: new OpenListError(
    ErrorCode.InvalidConfig,
    "Invalid configuration",
  ),
  Unauthorized: new OpenListError(
    ErrorCode.Unauthorized,
    "Unauthorized access",
  ),
  Forbidden: new OpenListError(ErrorCode.Forbidden, "Permission denied"),
}

/**
 * 錯誤信息脫敏：對外返回錯誤時避免暴露內部實現細節（路徑、堆棧、驅動內部）。
 * 僅保留錯誤類型/API 層信息，敏感內容替換為通用描述。
 */
export function safeErrorMessage(
  e: any,
  fallback = "Internal server error",
): string {
  if (!e) return fallback
  const raw = typeof e === "string" ? e : e?.message || String(e)
  if (!raw) return fallback
  const s = String(raw)
  // 截斷超長信息（防止堆棧/大對象洩露）
  if (s.length > 200) return fallback
  // 屏蔽明顯的絕對路徑（Windows 與 POSIX）
  if (
    /[A-Za-z]:[\\/][^\\/\s]|[\\/][A-Za-z0-9_.-]+[\\/][A-Za-z0-9_.-]/.test(s) &&
    /\.(ts|js|mjs|cjs|json|toml|yml|yaml)/i.test(s)
  ) {
    return fallback
  }
  // 屏蔽堆棧特徵
  if (/at .*\(|at [A-Za-z0-9_.-]+:[0-9]+:[0-9]+/.test(s)) {
    return fallback
  }
  return s
}
