import {
  __resetCipherKeyCacheForTest,
  cipherPrefix,
  createFieldCipher,
  detectCipherPrefix,
  isSealedCiphertext,
  type FieldCipher,
} from "../../pkg/crypto"
import {
  generateSecret,
  readPersistedSecret,
  setJsonEnvCtx,
  writePersistedSecret,
} from "./store/json"
import { getStoreBackend, readCipher } from "./store/backend"

// 保持外部（middlewares.ts / router.ts / admin.ts）對 getKvBinding / getKvStatus
// 的既有引用不變，從 json 後端 re-export。
export {
  getKvBinding,
  getKvStatus,
  readPersistedSecret,
  writePersistedSecret,
} from "./store/json"
export { getStoreStatus } from "./store/backend"

/**
 * 預覽/代理相關的默認設置，對齊 Go internal/bootstrap/data/setting.go：
 *   - text_types：Go 的默認值為「一大串文本擴展名」，這裡取 Go 與 TSWorker 既有
 *     默認值的**並集**（保留 TS 的 python/typescript/bash/css/log 等別名寫法），
 *     因為 /p 端點會用該列表判斷文本類預覽（含字幕 lrc/srt/ass/vtt）能否走代理；
 *   - proxy_types：Go 默認 `m3u8,url` —— 這類文件內部含相對引用，必須經服務端轉發；
 *   - proxy_ignore_headers：Go 默認 `authorization,referer` —— 轉發客戶端頭時忽略它們。
 */
const DEFAULT_TEXT_TYPES =
  "txt,htm,html,xml,java,properties,sql,js,json,c,cpp,python,py,php,go,rst,css,typescript,ts,log,conf,yaml,yml,cmd,bash,sh,vue,ini,md,bat,gitignore,h,hpp,tsx,vtt,srt,ass,rs,lrc,strm"
const DEFAULT_PROXY_TYPES = "m3u8,url"
const DEFAULT_PROXY_IGNORE_HEADERS = "authorization,referer"

/** TSWorker 歷史上寫入 KV 的 text_types 默認值（用於遷移到並集默認值） */
const LEGACY_TEXT_TYPES =
  "txt,htm,html,xml,java,properties,sql,js,json,c,cpp,python,py,php,go,rst,css,typescript,ts,log,conf,yaml,yml,cmd,bash,sh,vue,ini"

/**
 * 分享摘要/「複製鏈接」默認模板。
 *
 * 前端「複製鏈接」= matchTemplate(getSetting("share_summary_content"), data)。
 * 模板為空時結果就是空串，`writeText("")` 會清空剪貼板，於是按鈕彈出「已複製」
 * 但剪貼板裡什麼都沒有——分享管理頁的複製鏈接因此完全不可用。
 *
 * 這裡輸出**純分享 URL**，與按鈕文案（Copy link / 複製鏈接）以及文件工具欄
 * 「分享」對話框裡 `copy(link())` 的行為保持一致。上游 Go 的默認值是一整段
 * 社交分享文案（LEGACY_SHARE_SUMMARY_GO），對「複製鏈接」按鈕而言屬於誤導性
 * 行為，故不採用；已寫入該文案的實例由 LEGACY_SETTING_MIGRATIONS 遷移過來。
 */
const DEFAULT_SHARE_SUMMARY_CONTENT = "{{base_url}}/@s/{{id}}"

/** 上一版曾採用的上游 Go 分享摘要文案（僅用於遷移到純鏈接） */
const LEGACY_SHARE_SUMMARY_GO = `@{{creator}} shared {{#each files}}{{#if @first}}"{{filename this}}"{{/if}}{{#if @last}}{{#unless (eq @index 0)}} and {{@index}} more files{{/unless}}{{/if}}{{/each}} from {{site_title}}: {{base_url}}/@s/{{id}}{{#if pwd}} , the share code is {{pwd}}{{/if}}{{#if expires}}, please access before {{dateLocaleString expires}}.{{/if}}`

// Global default configuration payload for Cloudflare Workers
export const defaultDb = {
  settings: [
    // Group 1: SITE (https://doc.oplist.org/configuration/site)
    {
      key: "version",
      value: "v4.2.3",
      type: "string",
      help: "Application Version",
      group: 1,
      flag: 1,
    },
    {
      key: "site_title",
      value: "OpenList",
      type: "string",
      help: "Site Title",
      group: 1,
      flag: 0,
    },
    {
      key: "announcement",
      value: "",
      type: "text",
      help: "Site Announcement",
      group: 1,
      flag: 0,
    },
    {
      key: "pagination_type",
      value: "pagination",
      type: "select",
      options: "all,pagination,load_more,auto_load_more",
      help: "Pagination Type",
      group: 1,
      flag: 0,
    },
    {
      key: "default_page_size",
      value: "20",
      type: "number",
      help: "Default Page Size",
      group: 1,
      flag: 0,
    },
    {
      key: "allow_indexed",
      value: "false",
      type: "bool",
      help: "Allow Search Engine Indexing",
      group: 1,
      flag: 0,
    },
    {
      key: "allow_mounted",
      value: "true",
      type: "bool",
      help: "Allow Mounted Storages",
      group: 1,
      flag: 0,
    },
    {
      key: "robots_txt",
      value: "User-agent: *\nDisallow: /",
      type: "text",
      help: "Robots Txt Content",
      group: 1,
      flag: 0,
    },

    // Group 2: STYLE (https://doc.oplist.org/configuration/style)
    {
      key: "logo",
      value: "https://res.oplist.org/logo/logo.svg",
      type: "string",
      help: "Site Logo URL",
      group: 2,
      flag: 0,
    },
    {
      key: "favicon",
      value: "https://res.oplist.org/logo/logo.svg",
      type: "string",
      help: "Favicon URL",
      group: 2,
      flag: 0,
    },
    {
      key: "main_color",
      value: "#1890ff",
      type: "string",
      help: "Main Theme Color",
      group: 2,
      flag: 0,
    },
    {
      key: "home_icon",
      value: "openlist",
      type: "string",
      help: "Home Icon Name",
      group: 2,
      flag: 0,
    },
    {
      key: "home_container",
      value: "max_980px",
      type: "select",
      options: "max_980px,hope_container",
      help: "Home Container Width",
      group: 2,
      flag: 0,
    },
    {
      key: "settings_layout",
      value: "responsive",
      type: "select",
      options: "list,responsive",
      help: "Settings Layout Mode",
      group: 2,
      flag: 0,
    },

    // Group 3: PREVIEW (https://doc.oplist.org/configuration/preview)
    {
      key: "text_types",
      value: DEFAULT_TEXT_TYPES,
      type: "text",
      help: "Text File Extensions",
      group: 3,
      flag: 0,
    },
    {
      key: "audio_types",
      value: "mp3,ogg,aac,wav,wma,flac,m4a,opus",
      type: "text",
      help: "Audio File Extensions",
      group: 3,
      flag: 0,
    },
    {
      key: "video_types",
      value: "mp4,mkv,webm,avi,mov,flv,m3u8,ts",
      type: "text",
      help: "Video File Extensions",
      group: 3,
      flag: 0,
    },
    {
      key: "image_types",
      value: "jpg,png,jpeg,gif,bmp,svg,ico,webp,avif,tiff",
      type: "text",
      help: "Image File Extensions",
      group: 3,
      flag: 0,
    },
    {
      key: "proxy_types",
      value: DEFAULT_PROXY_TYPES,
      type: "text",
      help: "Proxy File Extensions",
      group: 3,
      flag: 0,
    },
    {
      key: "proxy_ignore_headers",
      value: DEFAULT_PROXY_IGNORE_HEADERS,
      type: "text",
      help: "Proxy Ignore Headers",
      group: 3,
      flag: 0,
    },
    {
      key: "external_previews",
      value: "{}",
      type: "text",
      help: "External Previews JSON Config",
      group: 3,
      flag: 0,
    },
    {
      key: "iframe_previews",
      value: "{}",
      type: "text",
      help: "Iframe Previews JSON Config",
      group: 3,
      flag: 0,
    },
    {
      key: "audio_cover",
      value: "https://file.nn.ci/alist/cover.png",
      type: "string",
      help: "Audio Default Cover Image URL",
      group: 3,
      flag: 0,
    },
    {
      key: "audio_autoplay",
      value: "false",
      type: "bool",
      help: "Autoplay Audio",
      group: 3,
      flag: 0,
    },
    {
      key: "video_autoplay",
      value: "false",
      type: "bool",
      help: "Autoplay Video",
      group: 3,
      flag: 0,
    },
    {
      key: "preview_archives_by_default",
      value: "false",
      type: "bool",
      help: "Preview Archives By Default",
      group: 3,
      flag: 0,
    },
    {
      key: "readme_autorender",
      value: "true",
      type: "bool",
      help: "Readme Autorender",
      group: 3,
      flag: 0,
    },
    {
      key: "filter_readme_scripts",
      value: "true",
      type: "bool",
      help: "Filter Readme Scripts",
      group: 3,
      flag: 0,
    },
    {
      key: "force_preview",
      value: "",
      type: "text",
      help: "Force Preview Config",
      group: 3,
      flag: 0,
    },
    {
      key: "specify_preview",
      value: "",
      type: "text",
      help: "Specify Preview Layout Config",
      group: 3,
      flag: 0,
    },
    {
      key: "markdown_autorender",
      value: "true",
      type: "bool",
      help: "Autorender Markdown",
      group: 3,
      flag: 0,
    },
    {
      key: "code_editor_theme",
      value: "vs-dark",
      type: "select",
      options: "vs,vs-dark,hc-black",
      help: "Monaco Theme",
      group: 3,
      flag: 0,
    },
    {
      key: "office_preview",
      value: "true",
      type: "bool",
      help: "Enable Office Document Preview",
      group: 3,
      flag: 0,
    },
    {
      key: "pdf_preview",
      value: "true",
      type: "bool",
      help: "Enable PDF Preview",
      group: 3,
      flag: 0,
    },

    // Group 4: GLOBAL (https://doc.oplist.org/configuration/global)
    {
      key: "hide_files",
      value: "",
      type: "text",
      help: "Files Regex to Hide",
      group: 4,
      flag: 0,
    },
    {
      key: "package_download",
      value: "true",
      type: "bool",
      help: "Package Download Enabled",
      group: 4,
      flag: 0,
    },
    {
      key: "customize_head",
      value: "",
      type: "text",
      help: "Custom Head HTML/CSS",
      group: 4,
      flag: 0,
    },
    {
      key: "customize_body",
      value: "",
      type: "text",
      help: "Custom Body Script",
      group: 4,
      flag: 0,
    },
    {
      key: "link_expiration",
      value: "0",
      type: "number",
      // 單位與 Go 一致：小時（Go internal/sign 用 time.Duration(expire)*time.Hour，
      // 官方文件 configuration/global.md 亦為 "in hours"）。0 = 永不過期。
      help: "Link Expiration in Hours (0 = never expire)",
      group: 4,
      flag: 0,
    },
    {
      key: "sign_all",
      value: "false",
      type: "bool",
      help: "Sign All Download Links",
      group: 4,
      flag: 0,
    },
    {
      key: "seed_site_url",
      value: "",
      type: "string",
      help: "Public site URL used by transfer seed sources",
      group: 4,
      flag: 1,
    },
    {
      key: "seed_default_matrix",
      value:
        '{"md5":{"whole":true,"pieces":false},"sha1":{"whole":true,"pieces":false},"sha256":{"whole":true,"pieces":false}}',
      type: "text",
      help: "Default transfer seed hash matrix",
      group: 4,
      flag: 1,
    },
    {
      key: "seed_format_policies",
      value: '{"oss":"off","torrent":"off","cas":"off"}',
      type: "text",
      help: "Automatic transfer seed format policies",
      group: 4,
      flag: 1,
    },
    {
      key: "seed_auto_generate_policy",
      value: "off",
      type: "select",
      options: "off,on",
      help: "Global automatic transfer seed policy",
      group: 4,
      flag: 1,
    },
    {
      key: "seed_single_direct_preview",
      value: "false",
      type: "bool",
      help: "Open single-file transfer seeds directly in preview",
      group: 4,
      flag: 0,
    },
    {
      key: "seed_cas_direct_access",
      value: "false",
      type: "bool",
      help: "When opening a single-file CAS seed, immediately rapid-upload it into the same folder and preview the restored file",
      group: 4,
      flag: 0,
    },
    {
      key: "seed_default_trackers",
      value: "",
      type: "text",
      help: "Default tracker list offered when generating torrent seeds (one tracker per line)",
      group: 4,
      flag: 1,
    },
    {
      key: "privacy_regs",
      value: "",
      type: "text",
      help: "Privacy Regex Rules",
      group: 4,
      flag: 0,
    },
    {
      key: "ocr_api",
      value: "",
      type: "string",
      help: "OCR API Endpoint",
      group: 4,
      flag: 0,
    },
    {
      key: "filename_char_mapping",
      value: "{}",
      type: "text",
      help: "Filename Char Mapping JSON",
      group: 4,
      flag: 0,
    },
    {
      key: "forward_direct_link_params",
      value: "",
      type: "string",
      help: "Forward Direct Link Params",
      group: 4,
      flag: 0,
    },
    {
      key: "ignore_direct_link_params",
      value: "",
      type: "string",
      help: "Ignore Direct Link Params",
      group: 4,
      flag: 0,
    },
    {
      key: "webauthn_login_enabled",
      value: "false",
      type: "bool",
      help: "Webauthn Login Enabled",
      group: 4,
      flag: 0,
    },
    {
      key: "allow_previewing_sharing_files",
      value: "true",
      type: "bool",
      help: "Allow Previewing Sharing Files",
      group: 4,
      flag: 0,
    },
    {
      key: "allow_previewing_sharing_archives",
      value: "true",
      type: "bool",
      help: "Allow Previewing Sharing Archives",
      group: 4,
      flag: 0,
    },
    {
      key: "force_proxy_sharing_files",
      value: "false",
      type: "bool",
      help: "Force Proxy Sharing Files",
      group: 4,
      flag: 0,
    },
    {
      key: "share_summary_content",
      value: DEFAULT_SHARE_SUMMARY_CONTENT,
      type: "text",
      help: "Share Summary Content",
      group: 4,
      flag: 0,
    },
    {
      key: "handle_hook_after_writing",
      value: "",
      type: "string",
      help: "Handle Hook After Writing",
      group: 4,
      flag: 0,
    },
    {
      key: "handle_hook_rate_limit",
      value: "0",
      type: "number",
      help: "Handle Hook Rate Limit",
      group: 4,
      flag: 0,
    },
    {
      key: "ignore_system_files",
      value: "true",
      type: "bool",
      help: "Ignore System Files (.DS_Store, desktop.ini, etc.)",
      group: 4,
      flag: 0,
    },
    {
      key: "auto_update_index",
      value: "false",
      type: "bool",
      help: "Auto Update Search Index",
      group: 4,
      flag: 0,
    },

    // Group 7: SSO
    {
      key: "sso_login_enabled",
      value: "false",
      type: "bool",
      help: "Enable SSO Login",
      group: 7,
      flag: 0,
    },
    {
      key: "sso_login_platform",
      value: "",
      type: "select",
      options: "Github,Microsoft,Google,Dingtalk,Casdoor,OIDC",
      help: "SSO Platform",
      group: 7,
      flag: 0,
    },
    {
      key: "sso_client_id",
      value: "",
      type: "string",
      help: "SSO Client ID",
      group: 7,
      flag: 0,
    },
    {
      key: "sso_client_secret",
      value: "",
      type: "string",
      help: "SSO Client Secret",
      group: 7,
      flag: 0,
    },
    {
      key: "sso_login_url",
      value: "",
      type: "string",
      help: "SSO Authorization Endpoint",
      group: 7,
      flag: 0,
    },
    {
      key: "sso_token_url",
      value: "",
      type: "string",
      help: "SSO Token Endpoint (optional, defaults per platform)",
      group: 7,
      flag: 0,
    },
    {
      key: "sso_userinfo_url",
      value: "",
      type: "string",
      help: "SSO UserInfo Endpoint (optional, defaults per platform)",
      group: 7,
      flag: 0,
    },
    {
      key: "sso_scopes",
      value: "",
      type: "string",
      help: "SSO OAuth2 Scopes (optional, space separated)",
      group: 7,
      flag: 0,
    },
    {
      key: "sso_oidc_discovery_url",
      value: "",
      type: "string",
      help: "OIDC Discovery URL (for OIDC platform)",
      group: 7,
      flag: 0,
    },
    {
      key: "sso_login_callback_url",
      value: "",
      type: "string",
      help: "SSO Redirect/Callback URL (optional, defaults to /api/auth/sso_callback)",
      group: 7,
      flag: 0,
    },
    {
      key: "sso_compatibility_mode",
      value: "false",
      type: "bool",
      help: "SSO Compatibility Mode (postMessage token handoff)",
      group: 7,
      flag: 0,
    },
    {
      key: "sso_auto_register",
      value: "false",
      type: "bool",
      help: "Auto Register New SSO Users",
      group: 7,
      flag: 0,
    },
    {
      key: "sso_default_dir",
      value: "/",
      type: "string",
      help: "SSO Default Directory for New Users",
      group: 7,
      flag: 0,
    },
    {
      key: "sso_default_permission",
      value: "0",
      type: "number",
      help: "SSO Default Permission for New Users",
      group: 7,
      flag: 0,
    },

    // Group 8: LDAP
    {
      key: "ldap_host",
      value: "",
      type: "string",
      help: "LDAP Server Host",
      group: 8,
      flag: 0,
    },
    {
      key: "ldap_port",
      value: "389",
      type: "number",
      help: "LDAP Server Port",
      group: 8,
      flag: 0,
    },

    // Group 10: TRAFFIC
    {
      key: "traffic_limit",
      value: "0",
      type: "number",
      help: "Traffic Limit in MB",
      group: 10,
      flag: 0,
    },
    {
      key: "ip_limit",
      value: "0",
      type: "number",
      help: "IP Rate Limit Per Minute",
      group: 10,
      flag: 0,
    },

    // Group 14: OTHER (https://doc.oplist.org/configuration/other)
    // 115 / 123 / PikPak / Thunder Temp Directories
    {
      key: "115_temp_dir",
      value: "",
      type: "string",
      help: "115 Temp Directory",
      group: 14,
      flag: 0,
    },
    {
      key: "115_open_temp_dir",
      value: "",
      type: "string",
      help: "115 Open Temp Directory",
      group: 14,
      flag: 0,
    },
    {
      key: "123_temp_dir",
      value: "",
      type: "string",
      help: "123 Pan Temp Directory",
      group: 14,
      flag: 0,
    },
    {
      key: "123_open_temp_dir",
      value: "",
      type: "string",
      help: "123 Open Temp Directory",
      group: 14,
      flag: 0,
    },
    {
      key: "123_open_callback_url",
      value: "",
      type: "string",
      help: "123 Open Callback URL",
      group: 14,
      flag: 0,
    },
    {
      key: "pikpak_temp_dir",
      value: "",
      type: "string",
      help: "PikPak Temp Directory",
      group: 14,
      flag: 0,
    },
    {
      key: "thunder_temp_dir",
      value: "",
      type: "string",
      help: "Thunder Temp Directory",
      group: 14,
      flag: 0,
    },
    {
      key: "thunder_browser_temp_dir",
      value: "",
      type: "string",
      help: "Thunder Browser Temp Directory",
      group: 14,
      flag: 0,
    },
    {
      key: "thunderx_temp_dir",
      value: "",
      type: "string",
      help: "ThunderX Temp Directory",
      group: 14,
      flag: 0,
    },

    // 115 / PikPak / Thunder
    {
      key: "token",
      value: "",
      type: "string",
      help: "115 / PikPak / Thunder Token",
      group: 14,
      flag: 0,
    },

    // Miscellaneous
    {
      key: "package_download_disabled",
      value: "false",
      type: "bool",
      help: "Disable Package Download",
      group: 14,
      flag: 0,
    },
  ],
  storages: [],
  users: [
    {
      id: 1,
      username: "admin",
      password: "",
      role: 2,
      permission: 0,
      base_path: "/",
      disabled: false,
      sso_id: "",
      allow_ldap: false,
      pwd_update_at: new Date().toISOString(),
    },
    {
      id: 2,
      username: "guest",
      password: "",
      role: 1,
      permission: 0,
      base_path: "/",
      disabled: false,
      sso_id: "",
      allow_ldap: false,
      pwd_update_at: new Date().toISOString(),
    },
  ],
  metas: [],
  shares: [],
  plugins: [],
}

let memoryDb: any = null
let globalEnvCtx: any = null

/**
 * 資料可信度狀態（防止「讀失敗 → 回退空庫 → 落盤覆蓋」）。
 *
 * - `dbTrusted`: 當前 memoryDb 是否來自一次成功的持久化讀取（或已成功寫入）。
 *   為 false 時表示 memoryDb 僅是空殼兜底/默認值，絕不能寫回儲存。
 * - `dbLastLoadError`: 最近一次讀取失敗的原因，用於給出可診斷的攔截日誌。
 * - `dbWriteBlocked`: 是否曾攔截過「疑似空資料寫回」，供診斷與迴歸測試使用。
 */
let dbTrusted = false
let dbWriteBlocked = false
let dbLastLoadError: string | null = null

/** 當前記憶體庫是否可信（可安全寫回持久化儲存）。 */
export function isDbTrusted(): boolean {
  return dbTrusted
}

/** 最近一次讀取持久化儲存失敗的錯誤信息（無錯誤時為 null）。 */
export function getDbLoadError(): string | null {
  return dbLastLoadError
}

/**
 * 是否曾經攔截過一次「疑似空資料寫回」。
 * 供診斷介面/日誌使用，說明寫前守衛已生效。
 */
export function isDbWriteBlocked(): boolean {
  return dbWriteBlocked
}

/**
 * 判斷一份資料是否為「疑似空庫/空殼」。
 *
 * 判定順序：
 *  1) 有任何儲存/分享/元資料/插件 → 不是空殼；
 *  2) 有任一「已設置密碼」的用戶 → 不是空殼（說明已初始化）；
 *     注意 defaultDb 自帶的 admin/guest 佔位用戶密碼為空，不算數；
 *  3) 所有設置都等於默認值 → 是空殼。
 *
 * 空殼判定用於 saveDb 的寫前守衛：讀取失敗後得到的默認庫不會被寫回。
 */
export function isDbShell(data: any): boolean {
  if (!data || typeof data !== "object") return true

  const countStorages = Array.isArray(data.storages) ? data.storages.length : 0
  const countShares = Array.isArray(data.shares) ? data.shares.length : 0
  const countMetas = Array.isArray(data.metas) ? data.metas.length : 0
  const countPlugins = Array.isArray(data.plugins) ? data.plugins.length : 0

  if (countStorages + countShares + countMetas + countPlugins > 0) {
    return false
  }

  // 注意：不能以「是否存在用戶」判斷是否為真實庫。
  // defaultDb 自帶 admin/guest 兩個佔位用戶（密碼為空），所以空殼裡也有用戶。
  // 僅有當存在「設置了密碼的用戶」時，才說明這是一份被初始化過的真實庫。
  const users = Array.isArray(data.users) ? data.users : []
  const hasInitializedUser = users.some(
    (u: any) => String(u?.password || "").trim() !== "",
  )
  if (hasInitializedUser) {
    return false
  }

  // 沒有任何實體時，僅有當設置也全部停留在默認值時，才視作空殼。
  const settings = Array.isArray(data.settings) ? data.settings : []
  const defaults = Array.isArray(defaultDb.settings) ? defaultDb.settings : []
  const defaultMap = new Map(defaults.map((s: any) => [String(s.key), s.value]))
  return settings.every(
    (s: any) =>
      defaultMap.has(String(s.key)) &&
      defaultMap.get(String(s.key)) === s.value,
  )
}

/**
 * 在請求處理開始時注入當前環境的持久化後端上下文。
 * CF Workers 每個實例的模塊級 globalEnvCtx 初始為 null，且請求會被負載均衡到
 * 不同實例——若不設置，getDb()/saveDb() 會退回記憶體模式，導致配置
 * （含網盤賬號密碼、access_token）讀取/持久化失敗。
 */
export function setEnvCtx(env: any) {
  if (env) {
    globalEnvCtx = env
    setJsonEnvCtx(env)
  }
}

// 已知的舊默認值 → 當前默認值遷移表。
// 修復「開發環境(無 KV，用新默認值)與生產環境(KV 裡保存了舊默認值)不一致」：
// 早期默認 logo/favicon 為空或 res.oplist.org 舊地址，已寫入 KV 的舊值不會被
// ensureDefaultSettings 的「僅補缺失 key」邏輯覆蓋，導致 prod 顯示舊圖標。
const LEGACY_SETTING_MIGRATIONS: Record<string, { from: any[]; to: string }> = {
  logo: {
    from: ["", "/logo.png", "https://res.oplist.org/logo/logo.png"],
    to: "https://res.oplist.org/logo/logo.svg",
  },
  favicon: {
    from: ["", "/favicon.png"],
    to: "https://res.oplist.org/logo/logo.svg",
  },
  // 上游 OpenList 的 home_container 默認是 max_980px（內容限寬 980px 居中），
  // 本項目早期誤把默認值設為 hope_container（HopeUI Container 無 maxW，流式全寬），
  // 導致首頁文件列表橫向鋪滿整屏。已寫入 KV 的舊默認值需要遷移回限寬佈局。
  home_container: {
    from: ["hope_container"],
    to: "max_980px",
  },
  // 對齊 Go 的 text_types 默認值：補上 md / vtt / srt / ass / lrc / strm 等。
  // 這些擴展名會被 /p 端點用來判斷「文本類預覽能否走代理」，
  // 缺了它們會讓字幕、歌詞、README 在未開 web_proxy 的儲存上被 403。
  text_types: {
    from: [LEGACY_TEXT_TYPES],
    to: DEFAULT_TEXT_TYPES,
  },
  // 「複製鏈接」：早期 seed 為空串（複製出空白），上一版一度採用上游 Go 的
  // 整段分享文案（複製出一堆非鏈接內容）。兩種已寫入的值都遷移到純分享 URL。
  share_summary_content: {
    from: ["", LEGACY_SHARE_SUMMARY_GO],
    to: DEFAULT_SHARE_SUMMARY_CONTENT,
  },
}

const ensureDefaultSettings = (db: any) => {
  if (!db) return
  if (!db.settings) {
    db.settings = []
  }
  let modified = false
  const newSettings: any[] = []
  const seenKeys = new Set<string>()

  for (const defSetting of defaultDb.settings) {
    seenKeys.add(defSetting.key)
    const matching = db.settings.filter((s: any) => s.key === defSetting.key)
    if (matching.length === 0) {
      newSettings.push(JSON.parse(JSON.stringify(defSetting)))
      modified = true
    } else {
      // If duplicates existed in KV/storage, pick the one with non-empty value if available
      const chosen =
        matching.find((s: any) => s.value && s.value.trim() !== "") ||
        matching[0]
      if (
        chosen.group !== defSetting.group ||
        chosen.help !== defSetting.help ||
        chosen.type !== defSetting.type ||
        chosen.options !== defSetting.options ||
        chosen.flag !== defSetting.flag
      ) {
        chosen.group = defSetting.group
        chosen.help = defSetting.help
        chosen.type = defSetting.type
        chosen.options = defSetting.options
        chosen.flag = defSetting.flag
        modified = true
      }
      if (matching.length > 1) {
        modified = true
      }
      // 舊默認值遷移：KV 中保存的值若等於已知舊默認值，更新為當前默認
      const migration = LEGACY_SETTING_MIGRATIONS[defSetting.key]
      if (migration && migration.from.includes(chosen.value)) {
        chosen.value = migration.to
        modified = true
      }
      newSettings.push(chosen)
    }
  }

  // Preserve any custom user-added settings not present in defaultDb
  for (const s of db.settings) {
    if (s.key && !seenKeys.has(s.key)) {
      seenKeys.add(s.key)
      newSettings.push(s)
    }
  }

  // 僅做記憶體補齊：絕不在這裡隱式落盤。
  //
  // 歷史缺陷：此處曾調用 saveDb(db)，導致「讀取失敗 → 回退默認庫 → 立刻把空殼
  // 寫回儲存」，從而覆蓋真實配置並讓系統反覆回到未初始化狀態。
  // 缺失的默認項會在下一次顯式寫入時隨之持久化。
  db.settings = newSettings
}

const ensureDefaultStorages = (db: any) => {
  if (!db) return
  if (!db.storages || !Array.isArray(db.storages)) {
    db.storages = []
  } else {
    // Sanitize any corrupt or invalid storages (e.g. driver is undefined/null/empty)
    db.storages = db.storages.filter(
      (s: any) =>
        s &&
        typeof s === "object" &&
        typeof s.driver === "string" &&
        s.driver.trim() !== "" &&
        s.driver !== "undefined" &&
        s.driver !== "null" &&
        typeof s.mount_path === "string" &&
        s.mount_path.trim() !== "",
    )
  }
}

const ensureDefaultShares = (db: any) => {
  if (!db) return
  if (!db.shares) {
    db.shares = []
  }
}

const ensureDefaultPlugins = (db: any) => {
  if (!db) return
  if (!db.plugins) {
    db.plugins = []
  }
}

// FIX(備份恢復 / meta 丟失): loadDb 此前對 settings/storages/shares/plugins 都做了
// 兜底，唯獨漏了 metas。舊 KV 資料若不含 metas 欄位，getDb() 返回的 db.metas 為
// undefined，meta/list 會因 db.metas.length 直接 500，meta/create 雖自行兜底，
// 但列表讀取始終失敗，表現為「恢復後 metas 一條都看不到」。
const ensureDefaultMetas = (db: any) => {
  if (!db) return
  if (!db.metas || !Array.isArray(db.metas)) {
    db.metas = []
  }
}

/**
 * Request-scoped memoization for getDb().
 *
 * A single /api/fs/list triggers 6-8 full KV reads plus a full JSON.parse of
 * the config. Alibaba ESA caps a request at exactly 8 KV subrequests, so one
 * directory listing could exhaust the budget on its own.
 *
 * Two layers:
 *  1. in-flight de-duplication — concurrent callers share one KV read.
 *  2. short-TTL memoization — sequential calls within a request reuse it.
 *
 * Trade-off worth knowing: on Workers `env` is shared across requests within
 * an isolate, so a cache hung directly on it would never expire.
 * AsyncLocalStorage would give exact per-request scope but is unavailable on
 * EdgeOne/ESA/Vercel (nodejs_compat is only declared in wrangler.toml). A 1s
 * TTL is the portable middle ground — worst case a concurrent isolate sees
 * config up to 1s stale, and saveDb() refreshes the cache on every write.
 *
 * TODO: threading `db` down from the handler gives exact per-request scope,
 * but touches all ~83 call sites.
 */
const DB_CACHE_TTL_MS = 1000
const dbCache = new WeakMap<object, { ts: number; db: any }>()
const dbInflight = new WeakMap<object, Promise<any>>()

/**
 * 儲存後端解析入口。默認直接委託給 store/backend 的 getStoreBackend；
 * 測試可通過 __setStoreBackendLoaderForTest() 注入樁後端，用於統計
 * load/save 次數，鎖定 getDb() 的快取行為（見 db_cache.test.ts）。
 */
let storeBackendLoader: (env: any) => Promise<any> = (env) =>
  getStoreBackend(env)

/**
 * 僅供測試：重置模塊級快取與記憶體快照，保證用例相互隔離。
 *
 * 注意：必須把「寫前守衛」的狀態（dbTrusted / dbLastLoadError / dbWriteBlocked）
 * 一併復位。它們同樣是模塊級狀態，且 db_write_guard.test.ts 直接斷言其取值；
 * 僅清快取會讓「reset 後回到初始態」的假設不成立，用例結果將取決於執行順序。
 */
export const __resetDbCacheForTest = () => {
  // WeakMap 無法整體清空，但無參調用的快取鍵就是 globalEnvCtx 自身
  // （見 resolveNoArgKey），逐個 delete 即可。
  if (globalEnvCtx && typeof globalEnvCtx === "object") {
    dbCache.delete(globalEnvCtx)
    dbInflight.delete(globalEnvCtx)
  }
  globalEnvCtx = null
  memoryDb = null
  storeBackendLoader = (env: any) => getStoreBackend(env)
  // 寫前守衛狀態復位（否則跨用例串味）
  dbTrusted = false
  dbLastLoadError = null
  dbWriteBlocked = false
  // 加密相關的快取與一次性告警復位：
  // 用例可能先後使用不同密鑰/不同 DB_CIPHER，快取串味會讓「首次告警」「換鑰後
  // 可解」這類斷言依賴執行順序。
  cachedEncryptionKey = null
  cachedFromEnv = false
  encryptionKeyWarned = false
  unsealKeyWarned = false
  sealKeyMissingWarned = false
  plaintextMigrationLogged = false
  // 密鑰派生快取與「未變化欄位跳過加密」快取同樣必須復位：
  // 用例會切換 DB_CIPHER / 密鑰，快取串味會讓斷言依賴執行順序。
  __resetCipherKeyCacheForTest()
  sealedCache.clear()
}

/** 僅供測試：注入統計型儲存後端。 */
export const __setStoreBackendLoaderForTest = (
  loader: (env: any) => Promise<any>,
) => {
  storeBackendLoader = loader
}

/**
 * 解析無參 getDb() / saveDb() 應使用的快取鍵（即請求級 globalEnvCtx）。
 *
 * 為什麼需要它（這是一次線上性能事故的修復核心）：
 *
 * `dbCache` / `dbInflight` 都以調用方傳入的 `envCtx` 對象作為鍵。但倉庫裡有
 * 大量內部調用是 **無參** 的（storage.ts 的驅動回調、getSettings/getUsers 等
 * 五個 getter），它們拿不到 request 級 env。此前 getDb() 對無參調用的處理是：
 *
 *     if (!envCtx) return loadDb(envCtx)   // ❌ 直接落盤，兩個快取全部繞過
 *
 * 於是「一次無參 getDb()」= 「一次完整的冷加載」：後端全量讀 + JSON.parse +
 * 逐欄位 AES 解密 + 5 次 ensureDefault*。而一次 WebDAV PROPFIND 或一次頁面加載
 * 會觸發數十次無參 getDb()，於是 KV 被讀數十次、D1 被查數十 × N 張表，
 * 兩種後端同時變慢（現象上「cf+kv 和 d1 都慢」）。
 *
 * 修復：無參調用回退到 `globalEnvCtx`（由 setEnvCtx / 傳參調用寫入的請求級
 * 環境），並以它為鍵複用同一套快取。這樣同一請求（同一 isolate）內的重複調用
 * 命中快取，不再重複落盤與解密。
 *
 * 這是一個**純函數**（不寫入任何模塊狀態）：無參調用的快取鍵始終就是
 * `globalEnvCtx` 本身，saveDb 刷新快取時用同一個鍵，天然對稱。
 */
const resolveNoArgKey = (): object | null => {
  const ctx = globalEnvCtx
  return ctx && typeof ctx === "object" ? ctx : null
}

const loadDb = async (envCtx?: any) => {
  if (envCtx) {
    globalEnvCtx = envCtx
  }

  // Priority 1: 持久化後端（json/KV/Blob、D1、MySQL）
  // 注意：envCtx 可能為空（如 resolvePath 等內部調用 getDb() 不傳 env）。
  // 此時必須回退到請求級 globalEnvCtx，否則 readDriver 讀不到 DB_DRIVER、
  // getD1 讀不到 DB binding，會錯誤回退到 json 後端讀到舊的 KV 資料。
  const activeEnv = envCtx || globalEnvCtx
  // 解析器可被測試注入（__setStoreBackendLoaderForTest），故用 let + 可空：
  // 解析動作必須在 try 內 —— 配置類錯誤（驅動缺失、驅動 × 格式非法）要與
  // 讀取錯誤走同一條降級路徑，否則它會以「未捕獲異常」的形式拋出，
  // 讓 /init/setup 僅給前端一個沒有原因的裸 500。
  let backend: Awaited<ReturnType<typeof storeBackendLoader>> | null = null
  try {
    backend = await storeBackendLoader(activeEnv)
    const persisted = await backend.load(activeEnv)
    if (persisted) {
      // 僅在資料裡確實存在密文時才構造解密器（才需要解析密鑰）：
      //   - DB_CIPHER=none（默認）且歷史資料全為明文 → 完全不需要密鑰，
      //     省掉一次持久化讀取，也不會誤報「缺少加密密鑰」；
      //   - 存在 enc:vN: 密文（舊部署 / 曾開啟加密）→ 仍按前綴解密，
      //     因此「關掉加密」不會讓既有資料讀不出來。
      const hadSealed = hasSealedValues(persisted)
      if (
        hadSealed &&
        readCipher(activeEnv) === "none" &&
        !plaintextMigrationLogged
      ) {
        plaintextMigrationLogged = true
        console.log(
          "[DB] DB_CIPHER=none: existing encrypted values were decrypted; the " +
            "next save will write them back as PLAINTEXT (per-field migration, " +
            "no explicit step needed). Set DB_CIPHER to keep them encrypted.",
        )
      }
      const fieldCipher = hadSealed
        ? await resolveFieldCipher(activeEnv, { needDecrypt: true })
        : null
      await unsealDb(persisted, fieldCipher)
      memoryDb = persisted
      ensureDefaultSettings(memoryDb)
      ensureDefaultStorages(memoryDb)
      ensureDefaultShares(memoryDb)
      ensureDefaultPlugins(memoryDb)
      ensureDefaultMetas(memoryDb)
      // 讀取成功：記憶體庫與持久化儲存一致，允許後續寫回。
      dbTrusted = true
      dbLastLoadError = null
      return memoryDb
    }
    // 後端讀取成功但沒有資料：可能是全新部署（首次初始化）。
    // 但若歷史上曾成功讀到過資料，則「讀到空」極可能是最終一致性/後端切換導致的
    // 短暫不可見，此時不能把默認庫當成事實，更不能讓它寫回儲存。
    if (dbTrusted && memoryDb) {
      console.warn(
        `[DB] Backend ${backend?.name ?? "storage"} returned empty while a trusted snapshot exists; ` +
          `keeping the in-memory snapshot to avoid overwriting real config.`,
      )
      ensureDefaultSettings(memoryDb)
      ensureDefaultStorages(memoryDb)
      ensureDefaultShares(memoryDb)
      ensureDefaultPlugins(memoryDb)
      ensureDefaultMetas(memoryDb)
      return memoryDb
    }
    dbTrusted = false
    dbLastLoadError = null
  } catch (err: any) {
    // 讀取失敗絕不能靜默回退到默認庫並落盤——這正是「資料庫被清空」的根因。
    console.error(
      `[DB] Error reading config from ${backend?.name ?? "storage"}:`,
      err?.message || err,
    )
    dbLastLoadError = String(err?.message || err)
    dbTrusted = false
  }

  // 僅有在此前已經成功讀取過（同一 isolate 內的可信快照）時，才允許繼續使用記憶體庫。
  // 若從未成功讀取過，則返回的僅是「不可信空殼」，saveDb 會在落盤前將其攔截。
  if (memoryDb && dbTrusted) {
    ensureDefaultSettings(memoryDb)
    ensureDefaultStorages(memoryDb)
    ensureDefaultShares(memoryDb)
    ensureDefaultPlugins(memoryDb)
    ensureDefaultMetas(memoryDb)
    return memoryDb
  }

  // Priority 2: In-Memory DB（模塊級，進程內共享；重啟即失，僅用於本地調試）
  // 注意：此分支明確標記為「不可信」，禁止寫回持久化儲存。
  memoryDb = JSON.parse(JSON.stringify(defaultDb))
  ensureDefaultStorages(memoryDb)
  ensureDefaultShares(memoryDb)
  ensureDefaultPlugins(memoryDb)
  ensureDefaultMetas(memoryDb)
  return memoryDb
}

export const getDb = async (envCtx?: any) => {
  if (envCtx) {
    globalEnvCtx = envCtx
  }

  // 快取鍵解析（性能關鍵）：
  //   有參調用 → 直接用 envCtx；
  //   無參調用 → 回退到請求級 globalEnvCtx，複用同一套快取。
  //
  // 歷史缺陷：無參時曾直接 `return loadDb(envCtx)`，繞過下面兩個快取，
  // 導致每次無參 getDb() 都觸發一次完整的後端讀取 + 解密，KV 與 D1 同時被
  // 放大數十倍而變慢。僅有當連 globalEnvCtx 都沒有（進程剛啟動、純記憶體調試）
  // 時才無法快取，此時退化為直讀——不影響資料正確性，僅是性能兜底。
  const cacheKey = envCtx || resolveNoArgKey()
  if (!cacheKey) return loadDb(envCtx)

  // 1) Concurrent de-duplication: concurrent callers share a single KV read.
  const pending = dbInflight.get(cacheKey)
  if (pending) return pending

  // 2) Short-TTL memoization: sequential calls in one request reuse the result.
  const hit = dbCache.get(cacheKey)
  if (hit && Date.now() - hit.ts < DB_CACHE_TTL_MS) return hit.db

  const promise = loadDb(envCtx)
    .then((db) => {
      dbCache.set(cacheKey, { ts: Date.now(), db })
      return db
    })
    .finally(() => {
      dbInflight.delete(cacheKey)
    })
  dbInflight.set(cacheKey, promise)
  return promise
}

/**
 * Persist the config. Returns whether the write actually landed.
 *
 * FIX: persistence failures used to be swallowed here with a console.error and
 * a void return, so callers could not tell a saved change from a lost one.
 * The next read would then fall back to defaults and silently overwrite real
 * config — the "config reverted to default" SEV2 in the incident report.
 *
 * Throwing is deliberately scoped to *failed writes*: when no KV binding is
 * configured at all (in-memory / container mode) this keeps the historical
 * warn-and-continue behavior, so unpersisted deployments are not broken by it.
 */
// ============================================================
// 靜態加密（At-rest encryption）—— 可選，由 DB_CIPHER 控制
//
// 修復 H-1：網盤 token/secret/OTP 等敏感欄位此前以明文 JSON 落 KV/Blob。
// 這裡在「持久化邊界」做欄位級加密（落盤前 seal、讀盤後 unseal），記憶體中
// 始終保持明文，因此 resolvePath / parseAddition / 各驅動 / admin 介面均無需
// 改動。密鑰統一取 JWT_SECRET（簽名與加密共用）。
//
// 與歷史實現的差別：
//   - **默認不加密**（DB_CIPHER=none）。加密是可選能力，而不是強制行為。
//   - 算法由 DB_CIPHER 選擇，見 pkg/crypto.ts 的 DbCipher：
//       aes-256-gcm（HKDF，低成本，推薦） / aes-256-gcm-pbkdf2（歷史 envelope）
//       / aes-256-cbc-hmac（Encrypt-then-MAC）
//   - **解密永遠由密文前綴驅動**（`enc:vN:`），與當前配置無關。於是：
//       關掉加密 → 既有密文仍能解開，並在下次寫入時轉為明文（自動遷移）；
//       換算法   → 既有密文按舊算法解開，下次寫入按新算法落盤；
//       明文資料 → 不帶前綴，原樣返回，升級不丟資料。
// ============================================================
const SENSITIVE_SETTING_KEYS = new Set([
  "token",
  "sso_client_secret",
  "sso_client_id",
  "ldap_bind_password",
  "ldap_bind_dn",
  "ocr_api",
  "handle_hook_after_writing",
])

let encryptionKeyWarned = false
/** 一次性告警：資料中存在密文但拿不到密鑰（避免每次加載都刷屏） */
let unsealKeyWarned = false
/** 一次性告警：配置了 DB_CIPHER 卻沒有密鑰，僅能明文落盤 */
let sealKeyMissingWarned = false
/** 一次性提示：舊部署的密文在 DB_CIPHER=none 下會被自動遷移為明文 */
let plaintextMigrationLogged = false

/**
 * 欄位加密密鑰的持久化鍵名。
 *
 * 注意：這是 **KV 儲存槽位名**，不是環境變量名。歷史部署已用它存過密鑰，
 * 改名會導致既有密文無法解密，故保持不變。
 */
export const ENCRYPTION_SECRET_KV_KEY = "openlist_encryption_secret"

/**
 * 解析「環境變量中顯式配置的」欄位加密密鑰。
 *
 * 約定：欄位加密與 JWT 簽名都優先使用 JWT_SECRET 環境變量。
 * 但兩者在「未配置 env」時的持久化槽位是獨立的
 * （加密 → openlist_encryption_secret，簽名 → openlist_jwt_secret），
 * 因此未配置 JWT_SECRET 的部署中二者會是不同的隨機值——這不影響正確性，
 * 加密與簽名本就無需同鑰。
 *
 * 長度不足 16 視為未配置，避免弱密鑰。
 *
 * 該來源具有**最高優先級且恆定不變**：僅要它存在，seal 與 unseal
 * 都必須使用它，從而保證加解密對稱。
 */
function readEnvEncryptionKey(env: any): string | null {
  const raw =
    env?.JWT_SECRET ||
    (typeof process !== "undefined" ? process.env?.JWT_SECRET : "")
  // 僅要求「非空」：長度是運維建議（推薦 32+），不是硬門檻。
  // 強制長度會帶來一個很壞的副作用 —— 用戶明明配了 JWT_SECRET，卻因為
  // 不足 16/32 字符被判為「未配置」，於是自動生成邏輯又生成一把新密鑰，
  // 造成「環境變量密鑰」與「持久化密鑰」並存、加解密分裂。
  return typeof raw === "string" && raw.trim().length > 0 ? raw : null
}

/**
 * JWT_SECRET 的推薦長度（僅用於文案與告警，**不做強制校驗**）。
 *
 * 為什麼是 32：`openssl rand -hex 32` 輸出 64 個 hex 字符，但 32 字符已是
 * 足夠強的 HS256 密鑰；這裡取 32 作為「推薦值」的下界。
 */
export const RECOMMENDED_JWT_SECRET_LENGTH = 32

/**
 * 判斷某個密鑰是否短於推薦長度（用於**提示**，不用於拒絕）。
 */
export function isJwtSecretShort(secret: string | null | undefined): boolean {
  return (
    typeof secret === "string" &&
    secret.length > 0 &&
    secret.length < RECOMMENDED_JWT_SECRET_LENGTH
  )
}

/** 進程內快取：避免每次 load/save 都讀儲存 */
let cachedEncryptionKey: string | null = null
/** 快取值是否來自環境變量（來自 env 的最高優先級，不會被持久化值替換） */
let cachedFromEnv = false

/**
 * 獲取欄位加密密鑰（僅讀，絕不生成）。
 *
 * 優先級：
 *   1. env.JWT_SECRET
 *   2. 持久化密鑰 openlist_encryption_secret（由 setup 階段寫入）
 *
 * 關鍵約束（保證加解密對稱）：
 *   - 生成僅發生在 setup，見 ensureEncryptionSecret()。此處絕不生成，
 *     否則一次瞬時讀取失敗就會換鑰，導致既有密文永久無法解密。
 *   - 環境變量一旦配置，就始終優先於持久化密鑰，且不會被其覆蓋，
 *     這樣運維顯式指定的密鑰總是生效。
 */
async function getEncryptionKey(envCtx?: any): Promise<string | null> {
  const env =
    envCtx ||
    globalEnvCtx ||
    (typeof process !== "undefined" ? process.env : {})

  // 環境變量優先級最高：每次都要先看，避免被此前的持久化快取擋住。
  const envKey = readEnvEncryptionKey(env)
  if (envKey) {
    if (!cachedFromEnv || cachedEncryptionKey !== envKey) {
      cachedEncryptionKey = envKey
      cachedFromEnv = true
    }
    return envKey
  }

  // 已從持久化解析過則複用
  if (cachedEncryptionKey && !cachedFromEnv) return cachedEncryptionKey

  // 回退到持久化密鑰（僅讀取）
  try {
    const persisted = await readPersistedSecret(env, ENCRYPTION_SECRET_KV_KEY)
    if (persisted && persisted.trim().length > 0) {
      cachedEncryptionKey = persisted
      cachedFromEnv = false
      return persisted
    }
  } catch {
    // 讀取失敗按未配置處理
  }

  if (!encryptionKeyWarned) {
    encryptionKeyWarned = true
    console.error(
      "[DB] No encryption key available: set JWT_SECRET. " +
        "Encrypted fields cannot be decrypted and new sensitive fields will be " +
        "stored in plaintext until a key becomes available.",
    )
  }
  return null
}

/**
 * 加密密鑰是否已就緒（**繞過進程內快取**，直查真實來源）。
 *
 * 用途：供 `/public/init_status` 向前端暴露「後端是否已準備好接受登入」。
 *
 * 為什麼需要繞過快取：setup 完成後，同一實例的快取裡必然有密鑰；但
 * 用戶實際登入請求很可能落在**另一個實例**（其快取為空，需重新讀 KV）。
 * 僅有真實來源（env 或 KV 持久化）可讀，才代表**任意實例**都能解密。
 *
 * @returns true 表示任意實例都能取得密鑰
 */
export async function isEncryptionReady(envCtx?: any): Promise<boolean> {
  const env =
    envCtx ||
    globalEnvCtx ||
    (typeof process !== "undefined" ? process.env : {})

  // 環境變量存在即永遠就緒
  if (readEnvEncryptionKey(env)) return true

  // 直查持久化（不走快取）
  try {
    const persisted = await readPersistedSecret(env, ENCRYPTION_SECRET_KV_KEY)
    return Boolean(persisted && persisted.trim().length > 0)
  } catch {
    return false
  }
}

/**
 * 初始化階段確保**共享密鑰**存在（JWT 簽名 + DB_CIPHER 啟用時的欄位加密）。
 * 僅在 setup 中調用。
 *
 * 為什麼 DB_CIPHER=none 時同樣要生成：這把密鑰同時充當 JWT 令牌的簽名密鑰
 * （middlewares.ts 的 getJwtSecret 會複用本槽位）。多實例 / 冷啟動必須共用同一把，
 * 否則令牌會隨機失效。`none` 僅表示「不加密資料庫欄位」，與密鑰是否存在無關。
 *
 * 行為（與 getEncryptionKey 使用完全相同的優先級，避免加解密分裂）：
 *   1. 環境變量已配置 → 直接採用，不寫持久化（尊重運維配置）
 *   2. 持久化密鑰已存在 → 複用（存在性門控，永不覆蓋）
 *   3. 都不存在 → 生成 → 寫入 → **回讀校驗（帶重試）**
 *
 * ## 為什麼必須「寫後回讀校驗」
 *
 * Cloudflare KV / EdgeOne KV 等**最終一致**儲存存在寫入傳播延遲：
 * 剛 `put` 的鍵，緊接著 `get` 可能返回 null（跨隔離實例尤其明顯）。
 *
 * 若 setup 寫入密鑰後直接返回，會出現嚴重故障：
 *   - setup 請求（實例 I₁）生成密鑰 A 並寫入，用 A 加密密碼落盤；
 *   - 緊隨其後的登入請求可能落在**另一個實例 I₂**，其快取為空，
 *     重新讀 KV 時 A 尚未傳播 → 讀到 null → `getEncryptionKey` 返回 null
 *     → `unsealDb` 跳過解密 → `password` 保持 `enc:v1:` 密文
 *     → `verifyUserPassword` 判定非 64 位 hex → **密碼認證失敗**。
 *   - 等待數十秒後 KV 傳播完成，又能登入（「過一會就好了」）。
 *
 * 因此這裡在寫入後**主動回讀確認**，讀不到則按指數退避重試，直到
 * 密鑰真正可讀（或超出重試上限，明確報錯而非靜默返回）。
 * 這樣 setup 僅有在密鑰**確實可被後續請求讀到**時才報告成功。
 *
 * 併發安全：用進程內單飛（inflight 合併）消除同一實例內的重複生成。
 *
 * @returns 密鑰；無法確定時返回 null 並說明原因
 */
let ensureSecretInflight: Promise<string | null> | null = null

/** 寫後回讀重試參數：總等待上限約 1.9s（0.1+0.2+0.4+0.8+... 封頂） */
const SECRET_VERIFY_RETRIES = 6
const SECRET_VERIFY_BASE_MS = 100
const SECRET_VERIFY_MAX_MS = 1000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function ensureEncryptionSecret(
  envCtx?: any,
): Promise<string | null> {
  // 進程內單飛：併發 setup 僅生成一次
  if (ensureSecretInflight) return ensureSecretInflight

  ensureSecretInflight = (async () => {
    const env =
      envCtx ||
      globalEnvCtx ||
      (typeof process !== "undefined" ? process.env : {})

    // 1. 環境變量優先。
    //    必須與 getEncryptionKey 完全一致，否則會出現「setup 生成隨機密鑰，
    //    而後續請求使用環境變量密鑰」的分裂：同一份資料被兩個密鑰加解密，
    //    已加密的密碼永遠解不開，表現為「初始化成功但密碼不正確」。
    const envKey = readEnvEncryptionKey(env)
    if (envKey) return envKey

    // 2. 已存在則複用（存在性門控，永不覆蓋）
    const existing = await readPersistedSecret(env, ENCRYPTION_SECRET_KV_KEY)
    if (existing && existing.trim().length > 0) {
      cachedEncryptionKey = existing
      cachedFromEnv = false
      return existing
    }

    // 3. 生成並寫入
    const generated = generateSecret()
    const ok = await writePersistedSecret(
      env,
      ENCRYPTION_SECRET_KV_KEY,
      generated,
    )
    if (!ok) {
      console.error(
        "[DB] Failed to persist an encryption key. Sensitive fields will be " +
          "stored in plaintext until JWT_SECRET is configured via environment variable.",
      )
      return null
    }

    // 4. 寫後回讀校驗（關鍵）：確保密鑰已傳播，後續請求能讀到同一密鑰。
    //    立即設快取，保證**本實例**後續調用（saveDb 加密）與寫入值一致。
    cachedEncryptionKey = generated
    cachedFromEnv = false

    let delay = SECRET_VERIFY_BASE_MS
    for (let i = 0; i < SECRET_VERIFY_RETRIES; i++) {
      const readBack = await readPersistedSecret(env, ENCRYPTION_SECRET_KV_KEY)
      if (readBack === generated) {
        console.log(
          `[DB] Generated and persisted a new encryption key ` +
            `(verified after ${i} retr${i === 1 ? "y" : "ies"})`,
        )
        return generated
      }
      // 讀到的值不是我們寫的那把（可能被併發 setup 覆蓋）：說明存在競態，
      // 採用「先寫入者優先」——複用已存在的密鑰，避免用兩把鑰匙加解密。
      if (readBack && readBack.trim().length > 0 && readBack !== generated) {
        console.warn(
          "[DB] A different encryption key already exists; adopting it to " +
            "keep encrypt/decrypt symmetric.",
        )
        cachedEncryptionKey = readBack
        cachedFromEnv = false
        return readBack
      }
      // 尚未傳播：退避重試
      await sleep(delay)
      delay = Math.min(delay * 2, SECRET_VERIFY_MAX_MS)
    }

    // 超出重試上限：密鑰寫入成功但暫時讀不回。返回它並讓本實例快取生效，
    // 但明確告警——此時跨實例的首次登入可能短暫失敗，稍後自動恢復。
    console.warn(
      `[DB] Encryption key written but not yet readable after ` +
        `${SECRET_VERIFY_RETRIES} retries. Cross-instance reads may lag ` +
        `briefly due to eventual consistency; retry shortly.`,
    )
    return generated
  })()

  try {
    return await ensureSecretInflight
  } finally {
    // 釋放單飛鎖：下次調用重新走完整檢查（密鑰已持久化，會命中步驟 2）
    ensureSecretInflight = null
  }
}

/**
 * 「未變化欄位跳過重新加密」快取（純性能優化，不參與任何功能語義）。
 *
 * ## 為什麼需要
 *
 * 記憶體中的庫**始終是明文**，而每次 `saveDb`（任何一次配置改動、任何一次 admin
 * 操作）都會把所有敏感欄位重新加密一遍。欄位沒變時這次加密毫無意義：
 *
 *   - 用 `aes-256-gcm` 時每欄位約 30 µs（WebCrypto 調用開銷）；
 *   - 用 `aes-256-gcm-pbkdf2` 時每欄位約 27 ms（PBKDF2 10 萬次）—— 這才是真痛；
 *   - 用 `des/3des-cbc-hmac` 時每欄位約 0.3 ms（純 JS）。
 *
 * load 時我們恰好知道「密文 ↔ 明文」的對應關係，把它記下來，save 時若明文未變、
 * 且算法與密鑰都未變，就直接複用原密文，跳過整個密碼學運算。
 *
 * ## 為什麼是安全的（無功能風險）
 *
 * 1. **三重校驗**後才複用：`明文相同` + `算法/密鑰指紋相同` + `密文算法 == 當前寫入算法`。
 *    任一不滿足都走正常加密路徑 —— 因此「換算法」「關加密」「輪換密鑰」「改值」
 *    的行為與不做該優化時**完全一致**（含自動遷移）。
 * 2. 複用僅發生在**同一明文、同一密鑰、同一算法**下，不會造成 nonce/IV 與
 *    不同明文複用（這是 AEAD 唯一需要避免的禁忌）。
 * 3. 快取僅在進程內、鍵為欄位身份（`users:1:password`），容量有上限；
 *    對同一欄位寫入不同值時條目會被覆蓋，不會讀到過期值。
 */
interface SealedCacheEntry {
  plain: string
  sealed: string
  /** 生成該密文時的 fieldCipher 指紋（算法 + 密鑰） */
  fp: string
  /** 生成該密文的算法（必須等於當前寫入算法才允許複用） */
  cipher: string
}

const SEALED_CACHE_LIMIT = 4096
const sealedCache = new Map<string, SealedCacheEntry>()

function rememberSealed(
  identity: string,
  plain: string,
  sealed: string,
  fp: string,
  cipher: string,
): void {
  if (sealedCache.size >= SEALED_CACHE_LIMIT) {
    const oldest = sealedCache.keys().next().value
    if (oldest !== undefined) sealedCache.delete(oldest)
  }
  sealedCache.set(identity, { plain, sealed, fp, cipher })
}

function recallSealed(
  identity: string,
  plain: string,
  fp: string,
  cipher: string,
): string | null {
  const hit = sealedCache.get(identity)
  if (!hit) return null
  if (hit.fp !== fp) return null // 算法或密鑰變了 → 必須重新加密
  if (hit.cipher !== cipher) return null // 密文算法 ≠ 當前寫入算法 → 需要遷移
  if (hit.plain !== plain) return null // 值變了 → 必須重新加密
  return hit.sealed
}

/**
 * 加密單個欄位（`seal`）。
 *
 * - 未啟用加密（fieldCipher 為 null）或未取到密鑰：原樣返回明文。
 * - 已有任意版本前綴：視為已加密（冪等），避免重複加密 —— 雙重加密會在下次讀取
 *   時僅解開一層、仍然呈現密文，表現為「密碼看起來還是亂碼」的詭異故障。
 * - 明文未變且算法/密鑰未變：複用上次的密文，跳過密碼學運算（見 sealedCache）。
 */
async function sealValue(
  value: string,
  fieldCipher: FieldCipher | null,
  identity: string,
): Promise<string> {
  if (!value || !fieldCipher || fieldCipher.cipher === "none") return value
  if (isSealedCiphertext(value)) return value // idempotent

  const reused = recallSealed(
    identity,
    value,
    fieldCipher.fingerprint,
    fieldCipher.cipher,
  )
  if (reused) return reused

  const sealed =
    cipherPrefix(fieldCipher.cipher) + (await fieldCipher.encrypt(value))
  rememberSealed(
    identity,
    value,
    sealed,
    fieldCipher.fingerprint,
    fieldCipher.cipher,
  )
  return sealed
}

/**
 * 解密單個欄位（`unseal`）。
 *
 * 算法由**密文前綴**決定，而不是當前 DB_CIPHER —— 這保證了「換算法 / 關加密」
 * 不會讓既有密文無法讀取。無前綴（明文）直接返回。
 */
async function unsealValue(
  value: string,
  fieldCipher: FieldCipher | null,
  identity: string,
): Promise<string> {
  if (!value || !isSealedCiphertext(value)) return value
  if (!fieldCipher) {
    // 有密文但拿不到密鑰：保持原值，絕不丟資料，但必須顯式告警 ——
    // 否則表現為「密碼/憑據看起來是亂碼」而無任何線索。
    if (!unsealKeyWarned) {
      unsealKeyWarned = true
      console.error(
        "[DB] Sealed values found in storage but no encryption key is " +
          "available; they will be left as-is (set JWT_SECRET, or restore the " +
          "original openlist_encryption_secret).",
      )
    }
    return value
  }
  const hit = detectCipherPrefix(value)
  try {
    const plain = await fieldCipher.decrypt(value)
    // 僅有「密文算法 == 當前寫入算法」時才記賬：否則一旦複用就等於阻止了
    // 「讀到 v1 → 保存為 v2」這類自動遷移（那是必須發生的）。
    if (hit && hit.cipher === fieldCipher.cipher) {
      rememberSealed(
        identity,
        plain,
        value,
        fieldCipher.fingerprint,
        hit.cipher,
      )
    }
    return plain
  } catch (e) {
    console.warn(
      "[DB] Failed to decrypt a sealed secret (wrong JWT_SECRET?):",
      e,
    )
    return value // keep raw value, never lose data
  }
}

/**
 * 資料中是否存在本模塊產生的密文（任意版本）。
 *
 * 用途：`DB_CIPHER=none` 且資料全為明文時，加載路徑**完全不需要**解析密鑰 ——
 * 既能避免一次額外的持久化讀取，也避免誤報「缺少加密密鑰」。
 */
function hasSealedValues(data: any): boolean {
  if (!data) return false
  for (const s of data.storages || []) {
    if (s && detectCipherPrefix(s.addition)) return true
  }
  for (const st of data.settings || []) {
    if (
      st &&
      SENSITIVE_SETTING_KEYS.has(st.key) &&
      detectCipherPrefix(st.value)
    ) {
      return true
    }
  }
  for (const u of data.users || []) {
    if (
      u &&
      (detectCipherPrefix(u.otp_secret) || detectCipherPrefix(u.password))
    ) {
      return true
    }
  }
  return false
}

/**
 * 依據 `DB_CIPHER` 與共享密鑰構造欄位加解密器（一次 save / load 複用一個實例）。
 *
 * @param opts.needDecrypt 讀取路徑專用：即使當前 `DB_CIPHER=none`，僅要資料裡存在
 *        歷史密文（`enc:vN:`）就仍然需要密鑰去解開它 —— 這正是「關掉加密後舊資料
 *        依舊可讀、並在下次保存時自動轉為明文」所依賴的分支。
 *        此時返回的對象寫入算法是 `none`（seal 側本就不會調用它）。
 * @returns null 表示「不需要加密/解密」或「需要但拿不到密鑰」。後者由調用方告警。
 */
async function resolveFieldCipher(
  env: any,
  opts?: { needDecrypt?: boolean },
): Promise<FieldCipher | null> {
  const cipher = readCipher(env)
  if (cipher === "none" && !opts?.needDecrypt) return null
  const secret = await getEncryptionKey(env)
  if (!secret) return null
  return createFieldCipher(cipher, secret)
}

async function sealDb(
  data: any,
  fieldCipher: FieldCipher | null,
): Promise<any> {
  // 未啟用加密：原樣落盤（不做無意義的複製）
  if (!fieldCipher || fieldCipher.cipher === "none" || !data) return data

  // ── 寫時複製（copy-on-write）而不是整庫 JSON 深拷貝 ──
  //
  // 歷史實現每次落盤前都 `JSON.parse(JSON.stringify(data))`：把**整個配置**
  // （含大量與敏感欄位無關的資料）序列化再反序列化一遍，大配置下是純開銷。
  // 這裡僅在「某個欄位確實被修改」時才複製它所屬的數組/實體；同時用展開運算符
  // 保持鍵順序，落盤結果與深拷貝版本逐字節一致。
  //
  // 密鑰派生由 fieldCipher 內部完成並快取（見 crypto.ts 的 cachedDerive），
  // 每個欄位仍然各自使用獨立隨機 IV。
  let storagesOut: any[] | undefined
  let settingsOut: any[] | undefined
  let usersOut: any[] | undefined

  // 1. 儲存配置中的 addition 欄位（網盤憑據）
  const srcStorages: any[] = Array.isArray(data.storages) ? data.storages : []
  for (let i = 0; i < srcStorages.length; i++) {
    const s = srcStorages[i]
    if (!s || !s.addition) continue
    const str =
      typeof s.addition === "string" ? s.addition : JSON.stringify(s.addition)
    if (!str || str === "{}") continue
    const sealed = await sealValue(
      str,
      fieldCipher,
      `storages:${s.id ?? i}:addition`,
    )
    if (sealed === s.addition) continue
    if (!storagesOut) storagesOut = srcStorages.slice()
    storagesOut![i] = { ...s, addition: sealed }
  }

  // 2. 敏感的系統設置
  const srcSettings: any[] = Array.isArray(data.settings) ? data.settings : []
  for (let i = 0; i < srcSettings.length; i++) {
    const st = srcSettings[i]
    if (!st || !SENSITIVE_SETTING_KEYS.has(st.key) || !st.value) continue
    const sealed = await sealValue(
      String(st.value),
      fieldCipher,
      `settings:${st.key}:value`,
    )
    if (sealed === st.value) continue
    if (!settingsOut) settingsOut = srcSettings.slice()
    settingsOut![i] = { ...st, value: sealed }
  }

  // 3. 用戶敏感信息（OTP 密鑰 / 密碼）
  const srcUsers: any[] = Array.isArray(data.users) ? data.users : []
  for (let i = 0; i < srcUsers.length; i++) {
    const u = srcUsers[i]
    if (!u) continue
    let next = u
    // OTP 密鑰
    if (u.otp_secret) {
      const sealed = await sealValue(
        String(u.otp_secret),
        fieldCipher,
        `users:${u.id ?? i}:otp_secret`,
      )
      if (sealed !== u.otp_secret) next = { ...next, otp_secret: sealed }
    }
    // 密碼二次加密（defense-in-depth，即使已哈希也加密儲存）
    if (u.password) {
      const sealed = await sealValue(
        String(u.password),
        fieldCipher,
        `users:${u.id ?? i}:password`,
      )
      if (sealed !== u.password) next = { ...next, password: sealed }
    }
    if (next !== u) {
      if (!usersOut) usersOut = srcUsers.slice()
      usersOut![i] = next
    }
  }

  // 沒有任何欄位被修改：直接複用原對象（與深拷貝版本落盤結果一致）
  if (!storagesOut && !settingsOut && !usersOut) return data

  const out: any = { ...data }
  if (storagesOut) out.storages = storagesOut
  if (settingsOut) out.settings = settingsOut
  if (usersOut) out.users = usersOut
  return out
}

/**
 * 解密併發上限。
 *
 * v2/v3 密文僅需一次快速密鑰派生；舊 v1 密文仍需 PBKDF2（10 萬次迭代），並在
 * 下次保存時自動遷移。限制併發可避免舊資料欄位很多時產生 CPU/記憶體峰值。
 */
const UNSEAL_CONCURRENCY = 16

async function unsealDb(
  data: any,
  fieldCipher: FieldCipher | null,
): Promise<void> {
  if (!fieldCipher || !data) return

  // 並行解密（帶併發上限）：
  //
  // 原先三類欄位（storage/setting/user）各自串行 await，舊 v1 欄位一多就是
  // 「N 次 PBKDF2（10 萬次迭代）」疊加，且該函數在一次請求內會被調用多次
  // （歷史缺陷下更是數十次），是加載變慢的主要貢獻之一。
  //
  // 這裡先**同步收集 thunk**（不在收集階段就把解密全部發起），再按
  // UNSEAL_CONCURRENCY 分批 await：既拿到並行帶來的牆鍾收益，又避免欄位極多
  // （如數千用戶）時一次性併發過多造成 CPU/記憶體峰值。
  //
  // 密鑰派生（v2 的 HKDF）由 fieldCipher 內部快取，本次加載僅發生一次。
  const tasks: Array<() => Promise<void>> = []

  // 1. 解密儲存配置（算法由密文前綴決定，與當前 DB_CIPHER 無關）
  const srcStorages: any[] = Array.isArray(data.storages) ? data.storages : []
  for (let i = 0; i < srcStorages.length; i++) {
    const s = srcStorages[i]
    if (s && typeof s.addition === "string" && isSealedCiphertext(s.addition)) {
      const target = s
      const sealedValue = target.addition
      const identity = `storages:${s.id ?? i}:addition`
      tasks.push(async () => {
        target.addition = await unsealValue(sealedValue, fieldCipher, identity)
      })
    }
  }

  // 2. 解密系統設置
  const srcSettings: any[] = Array.isArray(data.settings) ? data.settings : []
  for (let i = 0; i < srcSettings.length; i++) {
    const st = srcSettings[i]
    if (
      st &&
      SENSITIVE_SETTING_KEYS.has(st.key) &&
      typeof st.value === "string" &&
      isSealedCiphertext(st.value)
    ) {
      const target = st
      const sealedValue = target.value
      const identity = `settings:${st.key}:value`
      tasks.push(async () => {
        target.value = await unsealValue(sealedValue, fieldCipher, identity)
      })
    }
  }

  // 3. 解密用戶信息（OTP 密鑰 / 密碼）
  const srcUsers: any[] = Array.isArray(data.users) ? data.users : []
  for (let i = 0; i < srcUsers.length; i++) {
    const u = srcUsers[i]
    if (!u) continue
    // OTP 密鑰
    if (typeof u.otp_secret === "string" && isSealedCiphertext(u.otp_secret)) {
      const target = u
      const sealedValue = target.otp_secret
      const identity = `users:${u.id ?? i}:otp_secret`
      tasks.push(async () => {
        target.otp_secret = await unsealValue(sealedValue, fieldCipher, identity)
      })
    }
    // 密碼解密
    if (typeof u.password === "string" && isSealedCiphertext(u.password)) {
      const target = u
      const sealedValue = target.password
      const identity = `users:${u.id ?? i}:password`
      tasks.push(async () => {
        target.password = await unsealValue(sealedValue, fieldCipher, identity)
      })
    }
  }

  for (let i = 0; i < tasks.length; i += UNSEAL_CONCURRENCY) {
    await Promise.all(tasks.slice(i, i + UNSEAL_CONCURRENCY).map((run) => run()))
  }
}

export const saveDb = async (
  data: any,
  envCtx?: any,
  options?: { force?: boolean },
): Promise<boolean> => {
  if (envCtx) {
    globalEnvCtx = envCtx
  }

  const activeEnv = envCtx || globalEnvCtx

  // ============ 寫前守衛：永遠不得以「空資料」覆蓋持久化配置 ============
  //
  // 歷史缺陷鏈路：讀取失敗被吞掉 → 回退到默認（空）庫 → 後續任意寫操作把它
  // 落盤，真實配置被空殼覆蓋，系統隨後被判為「未初始化」，用戶看到的就是
  // 「資料庫被清空」。
  //
  // 核心不變量（務必長期保持）：
  //   **默認拒絕寫入空殼。** 空殼 = 沒有任何儲存/分享/元資料/插件，沒有設置
  //   密碼的用戶，且所有設置都還是默認值。無論當前是否「可信」，僅要 payload
  //   是空殼，就必須顯式 force 才允許落盤。
  //
  // 這樣即使某條調用鏈在讀取失敗後拿到默認庫，也無法把它寫回儲存。
  // 唯一的例外是調用方明確知情（首次初始化、管理員主動重置）並傳入 force。
  const shell = isDbShell(data)
  if (shell && !options?.force) {
    dbWriteBlocked = true
    const reason = dbLastLoadError
      ? `last load failed: ${dbLastLoadError}`
      : dbTrusted
        ? "payload is an empty/shell database"
        : "database was never successfully loaded from the persistence backend"
    console.error(
      `[DB] saveDb BLOCKED: refusing to persist an empty/shell database (${reason}). ` +
        `This guard prevents an empty payload from wiping real config. ` +
        `Pass saveDb(db, env, { force: true }) to override intentionally.`,
    )
    return false
  }

  memoryDb = data
  dbWriteBlocked = false
  // Refresh the request cache so any getDb() later in this request observes
  // the write rather than a pre-write snapshot.
  // 無參調用會以 globalEnvCtx 為鍵命中快取，因此這裡也同步刷新該鍵，
  // 否則「寫後讀」在無參路徑上可能讀到 TTL 內的舊快照。
  const cacheKey = envCtx || resolveNoArgKey()
  if (cacheKey) dbCache.set(cacheKey, { ts: Date.now(), db: data })

  // `activeEnv` 已在本函數開頭解析（寫前守衛也依賴它），這裡僅需通過可注入的
  // storeBackendLoader 取後端，便於測試統計 load/save 次數。
  const backend = await storeBackendLoader(activeEnv)
  const configured = backend.isConfigured
    ? await backend.isConfigured(activeEnv)
    : true
  if (!configured) {
    // No persistence configured — not a failed write, just an unpersisted
    // deployment. Preserve the old non-throwing behavior.
    console.warn(
      "[DB] WARNING: No persistence backend configured! Storage configuration changes will exist only in memory!",
    )
    return false
  }

  try {
    // 落盤前對敏感欄位做靜態加密（可選，見 DB_CIPHER），記憶體中的 data 保持明文。
    // cipher=none（默認）時直接按明文落盤，不解析密鑰（也不需要密鑰）。
    const cipher = readCipher(activeEnv)
    console.log(
      `[DB] saveDb: cipher=${cipher}, persisting to ${backend.name}, storages=${data.storages?.length || 0}`,
    )
    const fieldCipher = cipher === "none" ? null : await resolveFieldCipher(activeEnv)
    if (cipher !== "none" && !fieldCipher && !sealKeyMissingWarned) {
      // 僅在首次告警：密鑰缺失會持續到密鑰可用為止，逐次寫入都打印僅會刷屏。
      sealKeyMissingWarned = true
      console.error(
        `[DB] DB_CIPHER=${cipher} but no encryption key is available; ` +
          "sensitive fields will be stored in PLAINTEXT. Set JWT_SECRET.",
      )
    }
    const sealed = await sealDb(data, fieldCipher)
    console.log(
      `[DB] saveDb: sealed data size=${JSON.stringify(sealed).length} bytes`,
    )
    await backend.save(sealed, activeEnv)
  } catch (err: any) {
    console.error(
      `[DB] saveDb FAILED: backend=${backend.name}, error=${err?.message || err}`,
      `stack=${err?.stack?.substring(0, 500) || ""}`,
    )
    throw new Error(
      `[DB] Failed to persist config (${backend.name}); the change was NOT saved: ${err?.message || err}`,
    )
  }

  console.log(
    `[DB] Successfully persisted ${data.storages?.length || 0} storages to ${backend.name}`,
  )

  // 寫入成功 = 儲存中的內容與記憶體庫一致，因此記憶體庫現在可視為可信；
  // 這樣同一 isolate 後續的寫入不會被守衛誤攔。
  dbTrusted = true
  dbLastLoadError = null
  return true
}

export async function resolvePath(virtualPath: string, envCtx?: any) {
  const db = await getDb(envCtx)

  // ============ 路徑遍歷防護增強 (2026-09-08) ============
  // 1. URL 解碼（防止 %2e%2e 等編碼繞過）
  let path = virtualPath
  try {
    path = decodeURIComponent(String(path || ""))
  } catch {
    // 解碼失敗，使用原始值
  }

  // 2. 多重解碼檢測（防止雙重編碼繞過）
  let prevPath = ""
  let decodeAttempts = 0
  while (path !== prevPath && decodeAttempts < 3) {
    prevPath = path
    try {
      const decoded = decodeURIComponent(path)
      if (decoded === path) break // 沒有更多編碼
      path = decoded
      decodeAttempts++
    } catch {
      break
    }
  }

  // 3. 規範化路徑分隔符和特殊字符
  path = path
    .replace(/\\/g, "/") // 反斜槓 -> 正斜槓
    .replace(/%5c/gi, "/") // URL 編碼的反斜槓
    .replace(/%2f/gi, "/") // URL 編碼的正斜槓
    .replace(/\.{3,}/g, "..") // 多個點規範化為 ..
    .replace(/\/+/g, "/") // 多個斜槓合併為一個

  // 4. 檢測非法字符
  const illegalChars = ["\0", "\r", "\n", "\t"]
  for (const ch of illegalChars) {
    if (path.includes(ch)) {
      throw new Error(
        `invalid path: illegal character detected (0x${ch.charCodeAt(0).toString(16)})`,
      )
    }
  }

  // 5. Windows 絕對路徑檢測
  if (/^[A-Za-z]:/.test(path)) {
    throw new Error("invalid path: absolute Windows path not allowed")
  }

  // 6. UNC 路徑檢測
  if (path.startsWith("//") || path.startsWith("\\\\")) {
    throw new Error("invalid path: UNC path not allowed")
  }

  // Normalize ".." / "." segments so callers cannot escape the storage
  // mount root (path traversal). A leading ".." that pops an empty stack
  // is clamped to the root instead of escaping upward.
  const stack: string[] = []
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      stack.pop()
      continue
    }
    stack.push(seg)
  }
  let cleanPath = "/" + stack.join("/")
  if (cleanPath === "") {
    cleanPath = "/"
  }

  const activeStorages = (db.storages || []).filter(
    (s: any) =>
      !s.disabled &&
      typeof s.driver === "string" &&
      s.driver.trim() !== "" &&
      s.driver !== "undefined" &&
      s.driver !== "null" &&
      typeof s.mount_path === "string" &&
      s.mount_path.trim() !== "",
  )

  if (activeStorages.length === 0) {
    throw new Error(
      "failed get storage: storage not found; please add a storage first",
    )
  }

  const sortedStorages = [...activeStorages].sort((a: any, b: any) => {
    const aMount =
      "/" + (a.mount_path || "").split("/").filter(Boolean).join("/")
    const bMount =
      "/" + (b.mount_path || "").split("/").filter(Boolean).join("/")
    return bMount.length - aMount.length
  })

  for (const storage of sortedStorages) {
    const mount =
      "/" + (storage.mount_path || "").split("/").filter(Boolean).join("/")
    const isRootMount = mount === "/"
    const isMatch =
      isRootMount || cleanPath === mount || cleanPath.startsWith(mount + "/")

    if (isMatch) {
      let relPath = cleanPath
      if (!isRootMount) {
        relPath = cleanPath.slice(mount.length)
      }
      if (!relPath.startsWith("/")) {
        relPath = "/" + relPath
      }

      let addition: any = {}
      try {
        addition =
          typeof storage.addition === "string"
            ? JSON.parse(storage.addition || "{}")
            : storage.addition || {}
      } catch {
        addition = {}
      }
      const defaultRoot = "/"
      let rootFolder =
        addition.root_folder_path !== undefined
          ? addition.root_folder_path
          : defaultRoot

      const parts = [rootFolder, relPath]
        .map((p) => p.replace(/\\/g, "/"))
        .filter((p) => Boolean(p) && p !== "/")
      // Keep root_folder_path intact (e.g. Windows "C:/data" must not be
      // split into segments) while normalizing separators and slashes.
      const physicalPath = (parts.join("/") || "/").replace(/\/{2,}/g, "/")

      // FIX(C-2): defense-in-depth. Even if the normalization above ever
      // regresses, the resolved physical path may never leave rootFolder.
      // A rootFolder of "" or "/" means "no restriction", hence the skip.
      const rootNorm =
        String(rootFolder || "/")
          .replace(/\\/g, "/")
          .replace(/\/+$/, "") || "/"
      if (
        rootNorm !== "/" &&
        physicalPath !== rootNorm &&
        !physicalPath.startsWith(rootNorm + "/")
      ) {
        throw new Error("path traversal blocked: escapes storage root")
      }

      // FIX(H-4): 即使 rootFolder 為 "/"（無限制）從而跳過了上面的 containment
      // 校驗，最終物理路徑也絕不允許出現 ".." 段。這堵住了「root 掛載的儲存
      // 依賴 cleanPath 鉗制、而 root_folder_path 本身可能攜帶 .. 」的縱深缺口。
      if (physicalPath.split("/").includes("..")) {
        throw new Error("path traversal blocked: illegal '..' segment")
      }

      return {
        storage,
        relative: relPath,
        physical: physicalPath,
        rootFolder,
        cleanPath,
        isVirtual: false,
      }
    }
  }

  let isVirtual = false
  for (const storage of activeStorages) {
    const mount =
      "/" + (storage.mount_path || "").split("/").filter(Boolean).join("/")
    if (
      mount !== "/" &&
      mount.startsWith(cleanPath === "/" ? "/" : cleanPath + "/")
    ) {
      isVirtual = true
      break
    }
  }

  if (isVirtual) {
    return {
      storage: null,
      relative: cleanPath,
      physical: null,
      rootFolder: null,
      cleanPath,
      isVirtual: true,
    }
  }

  throw new Error("failed get storage: storage not found")
}

export async function getSettings() {
  const db = await getDb()
  const settingsObj: Record<string, any> = {}
  if (db.settings) {
    db.settings.forEach((s: any) => {
      settingsObj[s.key] = s.value
    })
  }
  return settingsObj
}

export async function getUsers() {
  const db = await getDb()
  return db.users || []
}

export async function getStorages() {
  const db = await getDb()
  return db.storages || []
}

export async function getMetas() {
  const db = await getDb()
  return db.metas || []
}

export async function getPlugins() {
  const db = await getDb()
  return db.plugins || []
}

export interface User {
  id: number
  username: string
  password?: string
  role?: number
  base_path?: string
  permission?: number
  disabled?: boolean
  otp_secret?: string
  ssh_keys?: any[]
  [key: string]: any
}
