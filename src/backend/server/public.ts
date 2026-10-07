import { Hono } from "hono"
import {
  ensureEncryptionSecret,
  getDb,
  getDbLoadError,
  getStoreStatus,
  isDbTrusted,
  isEncryptionReady,
  saveDb,
} from "../internal/model/db"
import {
  getStoreConfigErrorDetail,
  isPersistentStorageAvailable,
  isServerlessRuntime,
  readCipher,
  readDriver,
  readFormat,
} from "../internal/model/store/backend"
import { setUserPassword } from "../pkg/password"
// 脫敏 / 截斷 / 摘要 / 建議組裝：與全局 503 攔截（index.ts）共用同一套規則
import {
  reasonLines,
  redact,
  storageErrorSummary,
} from "./storage-error"

export const publicRouter = new Hono()

/** 文件基址（配置與儲存說明） */
const DOC_BASE = "https://doc.oplist.org"
const DOC_STORAGE = `${DOC_BASE}/ecosystem/official_worker/guide_env`
const DOC_DRIVER = `${DOC_BASE}/ecosystem/official_worker/guide`

/**
 * 解析值歸一：解析失敗時內部會用 "none"/空串佔位，界面上顯示「do → none」
 * 僅會造成困惑，因此統一歸一為 null（前端僅顯示配置值）。
 */
function resolvedOrNull(value: any): string | null {
  const s = String(value ?? "").trim()
  return s && s !== "none" ? s : null
}

/**
 * 「沒有可用儲存後端」時的統一建議（單一來源）。
 *
 * ## 為什麼不再提 `set DB_DRIVER=auto`
 *
 * 舊文案是「Bind a storage backend (D1 / KV / Blob) **or set DB_DRIVER=auto**」。
 * 後半句在**絕大多數真實場景下是循環建議**：用戶看到這條 issue 時，`DB_DRIVER`
 * 往往**本來就是 auto**（CF / EdgeOne 部署的默認形態）。讓他「去設置 auto」等於
 * 讓他改一個已經正確的值，改完照舊報錯，僅會加深「這軟件壞了」的印象。
 *
 * 準確的表述是：auto **已經把所有候選驅動探測過一遍且都不可用**，因此缺的是
 * **平台側的綁定**，不是配置值。這裡僅說這件事。
 *
 * 若驅動解析器給出了更精確的 hint（如 `noStorageHint` 的逐平台文案），調用方
 * 會優先使用它，本函數僅是兜底。
 */
function bindBackendSuggestion(): string {
  return (
    "No storage binding was detected (auto probes every driver). " +
    "Bind one and redeploy — Cloudflare: D1 or KV namespace; " +
    "EdgeOne: Blob; ESA: ESA_BLOB."
  )
}

/**
 * 初始化前的環境自檢。
 *
 * 該介面**無需鑑權**（初始化頁在未登入時就需要它），且**不洩露任何敏感值**：
 * 僅報告「配置了什麼」「是否就緒」「哪裡不對」，絕不回顯密鑰或 DSN 原文。
 *
 * 返回：
 *   - config：DB_FORMAT / DB_DRIVER / DB_CIPHER 的配置值與實際解析值
 *   - storage：驅動可用性、健康狀態、連接錯誤
 *   - jwt：簽名/加密密鑰是否就緒
 *   - ready：綜合就緒判定（資料庫 + 密鑰都就緒）
 *   - issues：問題清單，每項含 code / level / message / docUrl
 */
publicRouter.get("/env_check", async (c) => {
  const env = c.env as any
  const driverCfg = readDriver(env)
  const formatCfg = readFormat(env)
  // 欄位加密算法（none = 不加密，默認）。僅報告配置，不回顯任何密鑰。
  const cipherCfg = readCipher(env)
  const serverless = isServerlessRuntime(env)

  // ── 儲存狀態（不拋錯，內部已做容錯）──
  const storage: any = await getStoreStatus(env).catch((err: any) => ({
    driver: "none",
    format: "none",
    available: false,
    configError: String(err?.message || err),
  }))

  // ── 可用性判定：**複用** isPersistentStorageAvailable（單一來源）──
  //
  // 以前這裡把判定公式（有驅動 && 非記憶體 && 無配置錯誤 && 驅動自報可用）
  // 在本文件裡重抄了一遍，與 store/backend.ts 的 isPersistentStatus 逐條等價。
  // 兩處獨立維護意味著任何一方新增條件（例如將來加「驅動已廢棄」）都會造成
  // 「503 攔截層」與「安裝嚮導是否放行」判定不一致，且症狀極難定位。
  //
  // isPersistentStorageAvailable 內部就是 getStoreStatus + isPersistentStatus，
  // 因此這裡複用不會多一次探測（getStorageBackend 內部已按 env 指紋快取）。
  const storageAvailable = await isPersistentStorageAvailable(env)

  // 以下中間量僅用於**挑選 issue 文案**（哪個 code / 哪句話），不再參與可用性計算。
  // 記憶體模式在 serverless 下不可接受（實例短暫、多租戶，寫入會靜默丟失）。
  const resolvedDriver = String(storage?.driver ?? "none")
  const isMemory = resolvedDriver === "memory"
  const hasDriver = resolvedDriver !== "none" && resolvedDriver !== ""
  const hasConfigError = Boolean(storage?.configError)

  // 配置齊全但驅動自檢失敗（如 KV 代理 401、資料庫連不上）。
  // 注意：storageAvailable 為 false 且並無上述三類原因時，就落在這裡。
  const driverHealthy = storage?.available !== false

  // ── JWT 密鑰就緒（真實來源，繞過快取）──
  const jwtReady = await isEncryptionReady(env).catch(() => false)

  // ── 問題清單（可操作提示 + 文件鏈接）──
  const issues: {
    code: string
    level: "error" | "warning"
    /**
     * 給界面的一行短原因（**應為完整的一句話**）。
     *
     * 界面僅展示這一行 + suggestion，開發者排查用的長篇說明放在 message 裡，
     * 避免出現「半句話 + 省略號」這種讀不懂的提示。
     */
    summary: string
    /** 完整說明（多行、已脫敏）：僅給日誌/工具用，界面不展示 */
    message: string
    docUrl: string
    /** 一句話修復建議（「改什麼」） */
    suggestion?: string | null
  }[] = []
  /** 配置錯誤的分類碼 + 短摘要 + 完整說明 + 修復建議（均脫敏） */
  let storageDetail: {
    code: string | null
    summary: string | null
    message: string | null
    suggestion: string | null
  } = {
    code: null,
    summary: null,
    message: null,
    suggestion: null,
  }

  if (hasConfigError) {
    const detail = await getStoreConfigErrorDetail(env, { silent: true })
    storageDetail = {
      code: detail.code,
      summary: storageErrorSummary(detail.message),
      message: detail.message,
      suggestion: detail.suggestion,
    }
  }

  if (hasConfigError && storageDetail.code === "NO_STORAGE") {
    // 一個可選後端都沒有：這類錯誤本身就是「沒有可用的儲存」，用一條通用提示
    // 說清即可，不必再疊一條內容相同的配置錯誤（兩條 issue 說同一件事僅會讓
    // 用戶以為出了兩個問題）。
    issues.push({
      code: "STORAGE_UNAVAILABLE",
      level: "error",
      summary: "No storage backend available.",
      message: "No storage backend available.",
      docUrl: DOC_STORAGE,
      suggestion: storageDetail.suggestion || bindBackendSuggestion(),
    })
  } else if (hasConfigError) {
    // 配置錯誤：界面僅給「一行短原因 + 一行怎麼改」；完整排查說明留在 message /
    // storage.error_message 裡，由日誌與工具消費。
    const isInvalidCombination = storageDetail.code === "INVALID_COMBINATION"
    const reason = redact(
      storageDetail.message || storage?.configError,
      reasonLines(storageDetail.code),
    )
    issues.push({
      code: isInvalidCombination
        ? "STORAGE_INVALID_COMBINATION"
        : "STORAGE_CONFIG_ERROR",
      level: "error",
      summary:
        storageDetail.summary ||
        (isInvalidCombination
          ? "Unsupported storage combination."
          : "Storage driver is not configured correctly."),
      message: isInvalidCombination
        ? `Unsupported storage combination: ${reason}`
        : `Storage driver is not configured correctly: ${reason}`,
      docUrl: DOC_DRIVER,
      suggestion: storageDetail.suggestion,
    })
  } else if (isMemory) {
    issues.push({
      code: "STORAGE_MEMORY_ONLY",
      level: serverless ? "error" : "warning",
      summary: serverless
        ? "In-memory storage only; data will be lost immediately."
        : "In-memory storage only; data will be lost on restart (fine for local dev).",
      message: serverless
        ? "In-memory storage only; data will be lost immediately."
        : "In-memory storage only; data will be lost on restart (fine for local dev).",
      docUrl: DOC_STORAGE,
      suggestion: bindBackendSuggestion(),
    })
  } else if (!hasDriver) {
    issues.push({
      code: "STORAGE_UNAVAILABLE",
      level: "error",
      summary: "No storage backend available.",
      message: "No storage backend available.",
      docUrl: DOC_STORAGE,
      suggestion: bindBackendSuggestion(),
    })
  }

  // 配置齊全但驅動自檢失敗（如 KV 代理 401、資料庫連不上）
  if (hasDriver && !isMemory && !hasConfigError && !driverHealthy) {
    const unreachable =
      `Storage driver "${resolvedDriver}" is configured but not reachable` +
      `${storage.error ? ": " + redact(storage.error) : ""}.`
    issues.push({
      code: "STORAGE_UNHEALTHY",
      level: "error",
      summary: unreachable,
      message: unreachable,
      docUrl: DOC_DRIVER,
      // 注意：這裡**不**再建議「set DB_DRIVER=auto」。
      // 能走到這裡說明驅動已成功解析（binding/憑據都齊），僅是自檢不通
      // （如 KV 代理 401）。此時改回 auto 沒有任何幫助 —— auto 會解析出同一個
      // 驅動、撞上同一個錯誤，屬於把用戶支去繞圈。真正要做的是修憑據/綁定。
      suggestion:
        `Check the credentials/bindings for "${resolvedDriver}" ` +
        "(it resolved, but its health check failed).",
    })
  }

  if (!jwtReady) {
    issues.push({
      code: "JWT_SECRET_MISSING",
      // 一律 warning：儲存可用時 setup 會自動生成並持久化密鑰，缺它不是
      // 「裝不了」，僅是「少了一層顯式配置的確定性」。不再升級為 error，
      // 否則會出現「報錯說缺密鑰 → 但生成密鑰僅能靠安裝 → 安裝又被報錯攔住」。
      level: "warning",
      // 密鑰支持**自動生成 + 持久化**（見 ensureEncryptionSecret），所以文案
      // 不說「必須手動配置」，而是同時給出「也可留空讓 setup 自動生成」這條路，
      // 避免用戶以為這是個必填項而無謂地卡在嚮導裡。
      summary: "JWT_SECRET is not set.",
      message:
        "JWT_SECRET is not set. If storage is available, a secret is generated " +
        "and persisted automatically during setup; setting it explicitly is " +
        "recommended so that all instances and cold starts share one key.",
      docUrl: DOC_STORAGE,
      suggestion:
        "Set JWT_SECRET (32+ chars recommended, `openssl rand -hex 32`) in your " +
        "deployment variables — or leave it empty and let setup generate one " +
        "(requires working storage).",
    })
  }

  // ── 綜合就緒：僅取決於「儲存可用」──
  //
  // 這裡曾寫成 `storageAvailable && jwtReady`，會造成**自死鎖**：
  //   1. 未配置 JWT_SECRET 時 jwtReady=false → ready=false；
  //   2. 前端 `canProceed()` 依賴 ready，於是初始化嚮導卡在第 1 步；
  //   3. 而密鑰的自動生成 `ensureEncryptionSecret()` 恰恰僅在**提交初始化
  //      （/public/init）時**才會執行（見下方 init 路由）。
  //   4. 結果：嚮導永遠進不到能觸發自動生成的那一步 → 「自動生成 JWT 未生效」。
  //
  // 語義上二者本就該分開：
  //   - `ready` 表示「儲存就緒、可以開始安裝」——這是**能否初始化**的前提；
  //   - `jwtReady` 表示「密鑰已就緒」——它可以是安裝的**結果**（自動生成），
  //     而不是安裝的前提。
  // 前端仍會把 jwt.ready=false 作為提示展示（並允許用戶選擇手動配置），
  // 但不再因此阻斷嚮導。
  const ready = storageAvailable

  return c.json({
    code: 200,
    message: "success",
    data: {
      runtime: {
        serverless,
        platform: storage?.platform ?? null,
      },
      config: {
        // 配置值（用戶顯式設置，或默認值）
        db_format: formatCfg,
        db_driver: driverCfg,
        // 敏感欄位落盤算法：none（默認，不加密）/ aes-256-gcm /
        // aes-256-gcm-sha256 / aes-256-cbc-hmac。歷史密文帶 enc:vN: 前綴，
        // 讀取時自動識別，因此該項隻影響**新寫入**。
        db_cipher: cipherCfg,
        // 實際解析值（auto 探測後的結果）；解析失敗時後端內部是 "none"，
        // 對界面沒有意義且會顯示成「do → none」，這裡統一歸一為 null。
        resolved_driver: resolvedOrNull(storage?.driver),
        resolved_format: resolvedOrNull(storage?.format),
      },
      storage: {
        available: storageAvailable,
        configured: storage?.configured ?? null,
        connected: storage?.connected ?? null,
        platform: storage?.platform ?? null,
        /** 是否處於記憶體兜底模式（重啟即失，serverless 下不可接受） */
        memory: isMemory,
        /**
         * 配置錯誤的機器可讀分類（無錯誤時為 null）：
         * INVALID_COMBINATION / DRIVER_UNAVAILABLE / NO_STORAGE /
         * PROXY_CONFIG / UNKNOWN_DRIVER / HEALTH_ERROR / DRIVER_ERROR
         */
        error_code: storageDetail.code,
        /** 一行短原因（界面展示這個） */
        summary: storageDetail.summary,
        /**
         * 完整原因（已脫敏、按分類限行）。
         *
         * 僅給日誌與工具用：界面展示它會出現「半句話 + 省略號」。
         */
        error_message:
          storageDetail.message !== null
            ? redact(storageDetail.message, reasonLines(storageDetail.code))
            : null,
        /** 一句話修復建議（「改什麼」），無錯誤時為 null */
        suggestion: storageDetail.suggestion,
      },
      jwt: {
        ready: jwtReady,
        // 僅告知來源類型，不回顯任何值
        source: jwtReady ? "env-or-persisted" : "none",
      },
      ready,
      issues,
      docUrl: DOC_STORAGE,
    },
  })
})

publicRouter.get("/settings", async (c) => {
  const db = await getDb(c.env)

  // Default settings aligned with Go backend InitialSettings()
  // Source: internal/bootstrap/data/setting.go + internal/conf/const.go
  const settingsObj: Record<string, string> = {
    // --- Site ---
    title: "OpenList",
    site_title: "OpenList",
    version: "v4.2.3",
    // 後端類型標識：前端據此在 GO / TS 模式間切換功能開關。
    // Go 版 OpenList 後端不返回此欄位，前端缺省視為 "go"。
    backend: "ts-worker",
    announcement: "",
    pagination_type: "pagination",
    default_page_size: "20",
    allow_indexed: "false",
    allow_mounted: "true",
    robots_txt: "User-agent: *\nAllow: /",

    // --- Appearance ---
    logo: "https://res.oplist.org/logo/logo.svg",
    favicon: "https://res.oplist.org/logo/logo.svg",
    main_color: "#1890ff",
    hide_storage_details: "false",
    hide_storage_details_in_manage_page: "false",
    customize_head: "",
    customize_body: "",

    // --- Preview types (must match Go defaults exactly) ---
    // text_types: file extensions that should open in text/code editor
    text_types:
      "txt,htm,html,xml,java,properties,sql,js,md,json,conf,ini,vue,php,py,bat,gitignore,yml,yaml,toml,Makefile,mk,dockerfile,sh,pub,lock,gradle,ts,tsx,jsx,go,rs,c,cpp,h,cs,rb,swift,kt,dart,r,m,pl,pm,lua,ex,exs",
    // audio_types: file extensions treated as audio
    audio_types: "mp3,flac,ogg,m4a,wav,opus,wma,aac,aiff,ape",
    // video_types: file extensions treated as video
    video_types: "mp4,mkv,avi,mov,rmvb,webm,flv,m3u8,ts,wmv,m2ts,mpg,mpeg,3gp",
    // image_types: file extensions treated as image
    image_types:
      "jpg,tiff,jpeg,png,gif,bmp,svg,ico,webp,avif,heic,heif,raw,cr2,nef,arw,dng",
    // proxy_types: file types that should be proxied through server (blank = none forced)
    proxy_types: "",
    // proxy_ignore_headers: headers to strip when proxying
    proxy_ignore_headers: "",

    // --- Preview behavior ---
    audio_autoplay: "false",
    video_autoplay: "false",
    readme_autorender: "true",
    filter_readme_scripts: "true",
    preview_download_by_default: "false",
    preview_archives_by_default: "false",
    share_preview_download_by_default: "false",
    share_preview_archives_by_default: "false",

    // --- Sharing ---
    // IMPORTANT: share_preview must be "true" — frontend blocks ALL previews when false
    share_preview: "true",
    share_archive_preview: "true",
    // 「複製鏈接」渲染的模板。缺失或為空時會渲染成空串，
    // `navigator.clipboard.writeText("")` 會清空剪貼板，按鈕照常彈「已複製」
    // 但粘貼出來是空的。默認輸出純分享 URL，與按鈕文案一致。
    share_summary_content: "{{base_url}}/@s/{{id}}",

    // --- Global ---
    hide_files: "/\\.DS_Store/i",
    link_expiration: "0",
    sign_all: "false",
    filename_char_mapping: "{}",
    forward_direct_link_params: "false",
    ignore_direct_link_params: "",
    package_download: "true",
    offline_download: "true",
    ocr_api: "",
    privacy_regs: "",

    // --- External / iframe previews (JSON map, default empty) ---
    // Format: {"ext1,ext2": {"preview_name": "https://example.com/?url=$url"}}
    iframe_previews: "{}",
    external_previews: "{}",

    // --- Security ---
    check_down_link: "false",
    check_update: "false",

    // --- Auth ---
    allow_guest: "true",
    webauthn_login_enabled: "false",
    sso_login_enabled: "false",
    sso_compatibility_mode: "false",
    ldap_login_enabled: "false",

    // --- Display ---
    show_disk_usage_in_plain_text: "false",
    non_efs_zip_encoding: "UTF-8",
  }

  // FIX(C-1 / F-14): explicit allowlist — this endpoint is unauthenticated.
  //
  // History: the handler used to echo every settings key, which leaked the
  // admin static API token (a match in isStaticApiToken() grants FULL admin).
  // An interim fix blocked credential-shaped keys with a regex; this upgrade
  // inverts the default so unknown keys fail closed: only keys listed here
  // are ever public. The list = the display defaults above + every key the
  // frontend actually reads (verified by scanning src/ for getSetting() /
  // settings["..."] usage — no dynamic key access exists; plugins read
  // settings through the admin endpoint instead).
  //
  // To publish a new setting, add its key here deliberately. Note the legacy
  // `Flag.PUBLIC/PRIVATE` field on setting items is NOT used as the boundary:
  // the `token` item carries flag:0 (it was meant as the 115/PikPak/Thunder
  // driver token, which collides with the admin API token key) — so that
  // field cannot be trusted as a security signal.
  const PUBLIC_SETTING_KEYS = new Set([
    ...Object.keys(settingsObj),
    // Keys read by the frontend beyond the defaults above:
    "audio_cover",
    "home_container",
    "ldap_login_tips",
    "search_index",
    "settings_layout",
    "share_icon",
    "share_summary_content",
    "sso_login_platform",
  ])

  // Second line of defense: even if a credential-shaped key is ever added to
  // the allowlist above by mistake, still refuse to echo it.
  const SENSITIVE_KEY =
    /(secret|password|passwd|pwd|cookie|token|credential|private[_-]?key|api[_-]?key|access[_-]?key|jwt|salt|signature|webhook)/i

  // Override with user-configured settings from database
  db.settings.forEach((s: any) => {
    if (s.key && s.value !== undefined) {
      if (!PUBLIC_SETTING_KEYS.has(s.key)) return
      if (SENSITIVE_KEY.test(s.key)) return
      settingsObj[s.key] = s.value
      // Handle legacy key alias
      if (s.key === "site_title") {
        settingsObj["title"] = s.value
      }
    }
  })

  // 動態檢查是否存在且啟用了 guest 賬號
  const guest = (db.users || []).find((u: any) => u.username === "guest")
  const isGuestActive = Boolean(guest && !guest.disabled)
  if (!isGuestActive || settingsObj.allow_guest === "false") {
    settingsObj.allow_guest = "false"
  } else {
    settingsObj.allow_guest = "true"
  }

  return c.json({
    code: 200,
    message: "success",
    data: settingsObj,
  })
})

publicRouter.get("/archive_extensions", (c) => {
  return c.json({
    code: 200,
    message: "success",
    data: [
      "zip",
      "rar",
      "7z",
      "tar",
      "gz",
      "bz2",
      "xz",
      "tar.gz",
      "tar.bz2",
      "tar.xz",
    ],
  })
})

publicRouter.get("/offline_download_tools", (c) => {
  return c.json({
    code: 200,
    message: "success",
    data: [], // Serverless environment: no background download tools
  })
})

publicRouter.get("/plugins", async (c) => {
  const db = await getDb(c.env)
  const plugins = db.plugins || []
  const activePlugins = plugins.filter((p: any) => p.enabled)
  return c.json({
    code: 200,
    message: "success",
    data: activePlugins,
  })
})

// 是否配置了 ADMIN_PASS（跳過安裝嚮導、自動初始化 admin）。
//
// 注意 env 與 process.env 都要看：Cloudflare Workers 走 env，本地/容器走
// process.env；兩者優先級與 auth.ts 的 getOrInitUsers 保持一致。
function adminPassConfigured(env: any): boolean {
  const fromEnv = env?.ADMIN_PASS
  const fromProc =
    typeof process !== "undefined" ? (process as any).env?.ADMIN_PASS : ""
  return String(fromEnv || fromProc || "").trim() !== ""
}

// 系統是否已初始化：存在已設置密碼的管理員賬號即為已初始化。
//
// 「可持久化儲存可用」是「已初始化」的前提，而不是並列的另一個檢查：
// 初始化結果必須能被持久化才算真正完成。若儲存不可用，getDb() 僅能退回
// 記憶體，此刻即便讀到了管理員賬號，也無法證明它會被保存下來 —— 重啟即丟。
// 因此這裡把儲存不可用直接判為 initialized=false，讓前端停留在初始化嚮導
// （那是唯一能提示用戶去修配置的地方），而不是歡快地跳去登入頁。
//
// 本介面已在 index.ts 的診斷豁免名單中，不會被儲存配置錯誤中間件攔截，
// 否則它在最需要報告問題的場景下反而拿不到任何信息。

publicRouter.get("/init_status", async (c) => {
  const storageReady = await isPersistentStorageAvailable(c.env)

  // 儲存不可用時不再嘗試讀庫：此時 getDb() 僅會返回記憶體副本，
  // 據此得出的 initialized=true 是假象。
  let initialized = false
  if (storageReady) {
    // ADMIN_PASS 自動初始化：安裝頁僅輪詢本介面，從不調用登入介面。
    // 若僅把 getOrInitUsers() 掛在登入路徑上，配置了 ADMIN_PASS 的新部署會
    // 永遠停在「未初始化 → 跳 /@init → 永遠不初始化」的死循環裡。
    //
    // 僅當運維顯式配置了 ADMIN_PASS 時才觸發（那是「請自動初始化」的明確
    // 意圖）：未配置時不調用，避免每次輪詢都嘗試寫入一份未初始化的佔位庫。
    // getOrInitUsers 本身是冪等的：已初始化（admin 密碼已是合法哈希）時
    // 不做任何寫入。
    if (adminPassConfigured(c.env)) {
      try {
        const { getOrInitUsers } = await import("./auth")
        await getOrInitUsers(c.env)
      } catch (err: any) {
        console.warn(
          "[DB] init_status: ADMIN_PASS auto-initialization failed: " +
            (err?.message || err),
        )
      }
    }

    const db = await getDb(c.env)
    const admin = (db.users || []).find((u: any) => u.role === 2)
    initialized = Boolean(admin && String(admin.password || "").trim() !== "")
  }

  // 就緒判定：加密密鑰在**真實來源**（env 或 KV）可讀。
  // 前端據此輪詢等待，避免 KV 最終一致性導致的「剛初始化完登入失敗」。
  const ready = initialized ? await isEncryptionReady(c.env) : false

  // ── 把「為什麼不能初始化」透給前端 ──
  //
  // 安裝嚮導僅能看到本介面，因此這裡必須給出可展示的原因，否則用戶僅會拿到
  // 一個 500 或一句「未初始化」，無從判斷是綁定缺失、組合寫錯還是密鑰缺失。
  // 兩類原因都返回（已脫敏）：
  //   storage_error      一行短原因（界面直接展示，故取首行摘要）
  //   storage_suggestion 一句話修復建議（「改什麼」）
  //   db_load_error      上一次從持久化後端讀取失敗的原因（運行期故障）
  let storageError: string | null = null
  let storageSuggestion: string | null = null
  if (!storageReady) {
    const detail = await getStoreConfigErrorDetail(c.env, { silent: true })
    storageError = storageErrorSummary(detail.message)
    storageSuggestion = detail.suggestion
  }
  const dbLoadError = getDbLoadError()

  return c.json({
    code: 200,
    message: "success",
    data: {
      initialized,
      ready,
      db_trusted: isDbTrusted(),
      storage_error: storageError,
      storage_suggestion: storageSuggestion,
      db_load_error: dbLoadError ? redact(dbLoadError, 1) : null,
    },
  })
})

// 執行系統初始化：創建管理員賬號並設置站點名稱等初始參數。
publicRouter.post("/init/setup", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const username = String(body.username || "admin").trim()
  const password = String(body.password || "").trim()
  const siteTitle = String(body.site_title || "").trim()

  if (!username) {
    return c.json({ code: 400, message: "username is required", data: null }, 400)
  }
  if (!password) {
    return c.json({ code: 400, message: "password is required", data: null }, 400)
  }
  if (password.length < 4) {
    return c.json(
      { code: 400, message: "password must be at least 4 characters", data: null },
      400,
    )
  }

  const db = await getDb(c.env)
  if (!db.users) db.users = []
  // 安全護欄：僅在「讀取持久化後端**失敗**」時拒絕初始化。
  //
  // loadDb() 對兩種「db 不可信」給出了不同信號，必須分別對待：
  //   1. getDbLoadError() !== null —— 讀取拋錯（binding 未注入、後端不可達、
  //      鑑權失敗等）。此時記憶體裡僅是兜底空殼，繼續初始化會把空庫寫回儲存、
  //      覆蓋真實配置（即「資料庫被清空」的根因）→ 必須拒絕。
  //   2. getDbLoadError() === null 且 !isDbTrusted() —— 讀取**成功但後端為空**，
  //      即全新部署 / 換到新庫後的首次初始化。這正是 setup 存在的意義。
  //      若也一併拒絕，就會出現「讀不到 → 不許初始化 → 永遠讀不到」的死鎖，
  //      讓全新空儲存永遠無法安裝（issue #62 現象 3）。
  const loadError = getDbLoadError()
  if (loadError) {
    console.error(
      "[DB] init/setup rejected: database could not be loaded from the persistence backend: " +
        loadError,
    )
    // 對外文案保持不變（相容既有前端/客戶端），但把「具體原因 + 分類碼」放進
    // data，讓安裝嚮導能直接展示，而不是隻給用戶一個通用 500。
    const detail = await getStoreConfigErrorDetail(c.env, { silent: true })
    const code = detail.code || "STORAGE_READ_FAILED"
    return c.json(
      {
        code: 500,
        message:
          "database is not readable; refusing to initialize to avoid overwriting existing config",
        data: {
          code,
          // 界面展示 summary（完整一句）；reason 保留給工具/日誌閱讀
          summary: storageErrorSummary(loadError),
          reason: redact(loadError, reasonLines(code)),
          // 一句話修復建議：有配置原因時優先用它（如「改成 DB_DRIVER=d1」），
          // 否則嚮導僅能展示一段原因，用戶仍不知道下一步做什麼。
          suggestion: detail.suggestion,
        },
      },
      500,
    )
  }

  const existing = db.users.find((u: any) => u.role === 2)

  if (existing && String(existing.password || "").trim() !== "") {
    return c.json(
      { code: 400, message: "system has already been initialized", data: null },
      400,
    )
  }

  // 初始化階段：確保**共享密鑰**存在（JWT 簽名 + DB_CIPHER 啟用時的欄位加密）。
  //
  // 僅在 setup 中生成 —— 且僅當持久化鍵不存在時。一旦寫入永不覆蓋，
  // 否則既有加密資料將無法解密。其他任何階段都僅讀不生成。
  //
  // 注意：**與 DB_CIPHER 無關**。DB_CIPHER=none 僅表示「不加密資料庫欄位」，
  // JWT 令牌簽名仍然需要一把跨實例/跨冷啟動一致的密鑰：如果運維沒有通過環境
  // 變量 JWT_SECRET 提供，就必須在這裡生成並持久化，否則每個實例/每次冷啟動
  // 都會各生成一把隨機密鑰，導致令牌隨機失效。因此這裡無條件調用。
  await ensureEncryptionSecret(c.env)

  if (existing) {
    // admin 賬號已存在但尚未設置密碼（未初始化）：直接更新
    existing.username = username
    await setUserPassword(existing, password)
  } else {
    // 首次創建 admin 賬號（Go User.SetPassword 雙層哈希）
    const admin: any = {
      id: 1,
      username,
      password: "",
      role: 2,
      permission: 0,
      base_path: "/",
      disabled: false,
      sso_id: "",
      allow_ldap: false,
      pwd_update_at: new Date().toISOString(),
    }
    await setUserPassword(admin, password)
    db.users.push(admin)
  }

  if (siteTitle) {
    if (!db.settings) db.settings = []
    const site = db.settings.find((s: any) => s.key === "site_title")
    if (site) {
      site.value = siteTitle
    } else {
      db.settings.push({
        key: "site_title",
        value: siteTitle,
        type: "string",
        help: "Site Title",
        group: 1,
        flag: 0,
      })
    }
  }

  // 初始化是唯一允許「在一次成功讀取（確認儲存為空）之後寫入空殼」的場景，
  // 因此顯式 force；此時 db 已包含新建的管理員用戶，本身也不再是空殼。
  await saveDb(db, c.env, { force: true })
  return c.json({ code: 200, message: "success", data: null })
})
