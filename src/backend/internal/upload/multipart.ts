/**
 * 服務層 Multipart 上傳會話管理器。
 *
 * 目標：讓 TS 後端提供與官方前端 `multipart.ts` 完全一致的 API 契約
 * （/fs/multipart/init | chunk | complete | status），內部橋接到驅動層的
 * createUploadSession / uploadPart / completeUploadSession（會話式分片）。
 *
 * 說明：
 * - 會話狀態存於進程內 Map（Worker 單實例存活期間可斷點續傳）。
 *   跨實例/冷啟動恢復依賴驅動 session token 的自包含性，本層不做 KV 持久化。
 * - chunk 按 index（0-based）橋接到驅動 uploadPart(partNumber = index + 1)，
 *   與官方前端 multipart.ts 的 chunk index 語義對齊。
 * - received 以區間數組 [number, number][] 表示，供前端斷點續傳跳過已收分片。
 */

export type MultipartState =
  | "receiving"
  | "completed"
  | "failed_retriable"
  | "failed_permanent"
  | "aborted"

export interface MultipartSession {
  upload_id: string
  state: MultipartState
  attempt: number
  path: string
  size: number
  chunk_size: number
  total_chunks: number
  /** 已收到分片 index 集合（0-based） */
  received: Set<number>
  /** 驅動層 session token（createUploadSession 返回） */
  driver_session: string
  /** 驅動層分片 md5（complete 時傳給 completeUploadSession） */
  partMd5s: (string | undefined)[]
  /** 驅動名 + 儲存引用，用於 chunk/complete 時重新 resolve 驅動 */
  storage_driver: string
  created_at: number
  error?: string
}

export interface MultipartSnapshot {
  upload_id: string
  state: MultipartState
  attempt: number
  path: string
  size: number
  chunk_size: number
  total_chunks: number
  received: [number, number][]
  received_bytes: number
  frontier: number
  storage_progress: number
  error?: string
}

const sessions = new Map<string, MultipartSession>()

const CHUNK_MIN = 1 * 1024 * 1024 // 1MB
const CHUNK_MAX = 64 * 1024 * 1024 // 64MB
const CHUNK_DEFAULT = 10 * 1024 * 1024 // 10MB

/** 將前端建議的 chunk_size clamp 到 [1MB, 64MB] */
export function clampChunkSize(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return CHUNK_DEFAULT
  return Math.min(CHUNK_MAX, Math.max(CHUNK_MIN, Math.floor(raw)))
}

/** 區間數組 → 有序區間列表（合併相鄰） */
function intervalsOf(set: Set<number>): [number, number][] {
  const arr = Array.from(set).sort((a, b) => a - b)
  if (arr.length === 0) return []
  const out: [number, number][] = []
  let start = arr[0]
  let end = arr[0]
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] === end + 1) {
      end = arr[i]
    } else {
      out.push([start, end])
      start = end = arr[i]
    }
  }
  out.push([start, end])
  return out
}

export function snapshot(s: MultipartSession): MultipartSnapshot {
  const intervals = intervalsOf(s.received)
  const receivedBytes = s.received.size * s.chunk_size
  // frontier：連續已收的最大 index + 1（驅動順序寫入進度）
  let frontier = 0
  for (let i = 0; i < s.total_chunks; i++) {
    if (!s.received.has(i)) break
    frontier = i + 1
  }
  const storageProgress =
    s.total_chunks > 0
      ? Math.floor((s.received.size / s.total_chunks) * 100)
      : 0
  return {
    upload_id: s.upload_id,
    state: s.state,
    attempt: s.attempt,
    path: s.path,
    size: s.size,
    chunk_size: s.chunk_size,
    total_chunks: s.total_chunks,
    received: intervals,
    received_bytes: receivedBytes,
    frontier,
    storage_progress: storageProgress,
    error: s.error,
  }
}

export function getSession(uploadId: string): MultipartSession | undefined {
  return sessions.get(uploadId)
}

/** 查找同 path+size 的未完成會話（用於斷點續傳） */
export function findReceivingSession(
  path: string,
  size: number,
): MultipartSession | undefined {
  for (const s of sessions.values()) {
    if (
      s.path === path &&
      s.size === size &&
      (s.state === "receiving" || s.state === "failed_retriable")
    ) {
      return s
    }
  }
  return undefined
}

export function putSession(s: MultipartSession): void {
  sessions.set(s.upload_id, s)
}

export function deleteSession(uploadId: string): void {
  sessions.delete(uploadId)
}

/** 生成 upload_id */
export function newUploadId(): string {
  const rnd =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36)
  return `mp_${rnd}`
}

/** 清理過期的 completed / aborted 會話（簡單防記憶體洩漏） */
export function pruneSessions(maxAgeMs = 60 * 60 * 1000): void {
  const now = Date.now()
  for (const [id, s] of sessions) {
    if (
      (s.state === "completed" || s.state === "aborted") &&
      now - s.created_at > maxAgeMs
    ) {
      sessions.delete(id)
    }
  }
}
