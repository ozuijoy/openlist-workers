import {
  LanzouAddition,
  LanzouFileOrFolder,
  LanzouFileShare,
  LanzouShareResp,
} from "./types"
import {
  mustParseTime,
  sizeStrToInt64,
  removeNotes,
  removeJSComment,
  calcAcwScV2,
  htmlJsonToMap,
  getJSFunctionByName,
} from "./help"

/** 藍奏雲分享頁候選域名（分享 ID 全局可用，任一域名都能訪問同一分享）。
 *  資料中心出口 IP（如 CF Workers）被某個 CDN 域名 WAF 攔截時，可自動切換到其他域名重試。 */
const LANZOU_SHARE_DOMAINS = [
  "pan.lanzoui.com",
  "lanzouw.com",
  "lanzoux.com",
  "lanzouy.com",
  "lanzou.com",
]

/** 藍奏雲 Cookie 過期提示文案（cookie 有效期約 15 天） */
const COOKIE_EXPIRED_MSG = "[Lanzou] Cookie 已過期或失效，請在管理後台重新填寫 Cookie（有效期約 15 天）"

export class LanzouClient {
  private addition: LanzouAddition
  private cookie: string = ""
  private uid: string = ""
  private vei: string = ""
  private onCookieUpdate?: (cookie: string) => void
  /** acw_sc__v2 挑戰值，按域名快取（cookie 域綁定）。
   *  求解後持久化，後續請求都攜帶對應域名的值；
   *  資料中心 IP（CF Workers）不帶此 cookie 會被藍奏雲 CDN WAF 403。 */
  private acwMap = new Map<string, string>()
  /** 故障轉移後成功的工作域名（如 lanzouw.com）。
   *  記錄後後續分享域請求優先使用它，避免分享頁與 ajaxfile.php 跨域導致 sign 失效。 */
  private workingShareHost: string = ""

  constructor(
    addition: LanzouAddition,
    onCookieUpdate?: (cookie: string) => void,
  ) {
    this.addition = addition
    this.cookie = (addition.cookie || "").trim()
    this.onCookieUpdate = onCookieUpdate
  }

  public getBaseUrl(): string {
    return (
      this.addition.baseUrl ||
      (this.addition as any).base_url ||
      "https://pc.woozooo.com"
    ).replace(/\/$/, "")
  }

  public getShareUrl(): string {
    return (
      this.addition.shareUrl ||
      (this.addition as any).share_url ||
      "https://pan.lanzoui.com"
    ).replace(/\/$/, "")
  }

  /** 分享頁域名對應的主機名（用於 acw_sc__v2 按域快取） */
  private shareHost(): string {
    try {
      return new URL(this.getShareUrl()).host
    } catch {
      return "pan.lanzoui.com"
    }
  }

  public getUserAgent(): string {
    return (
      this.addition.user_agent ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    )
  }

  public getCookie(): string {
    return this.cookie
  }

  private updateCookie(setCookie: string | null, host?: string) {
    if (!setCookie) return
    // set-cookie 裡可能直接下發 acw_sc__v2（WAF 挑戰通過後），按域快取
    const acwMatch = setCookie.match(
      /(?:^|,\s*)acw_sc__v2=([^;,\s]+)/i,
    )
    if (acwMatch && acwMatch[1]) {
      this.acwMap.set(host || this.shareHost(), acwMatch[1])
    }
    const parts = this.cookie ? this.cookie.split(";").map((s) => s.trim()) : []
    const entries = setCookie.split(/,(?=[a-zA-Z0-9_\-]+=[^;]+)/)
    for (const entry of entries) {
      const main = entry.split(";")[0].trim()
      const eqIdx = main.indexOf("=")
      if (eqIdx > 0) {
        const k = main.slice(0, eqIdx).trim()
        const v = main.slice(eqIdx + 1).trim()
        const idx = parts.findIndex((p) => p.startsWith(`${k}=`))
        if (idx !== -1) {
          parts[idx] = `${k}=${v}`
        } else {
          parts.push(`${k}=${v}`)
        }
      }
    }
    const updated = parts.filter(Boolean).join("; ")
    if (updated !== this.cookie) {
      this.cookie = updated
      this.onCookieUpdate?.(this.cookie)
    }
  }

  /**
   * 初始化驅動並獲取憑證
   */
  async init(): Promise<void> {
    const type = this.addition.type || "cookie"
    if (type === "account") {
      await this.login()
      await this.initVeiAndUid()
    } else if (type === "cookie") {
      if (this.cookie) {
        await this.initVeiAndUid()
      }
    }
    // 預熱 acw_sc__v2：主動請求一次分享頁觸發/通過 WAF 挑戰，
    // 讓後續 ajaxfile.php 等請求都帶上 acw_sc__v2 cookie（資料中心 IP 必需）
    if (!this.acwMap.has(this.shareHost())) {
      try {
        await this.request(`${this.getShareUrl()}/`, "GET")
      } catch {}
    }
  }

  /**
   * 探測分享頁真實域名。
   * 藍奏雲每個賬號的分享頁域名都不同（如 https://自定義部分.lanzn.com），
   * 配置的 shareUrl 只是兜底。向兜底域名請求一次分享頁，從頁面 HTML 的
   * iframe/src 或 JS 變量裡提取真實分享域名；失敗時回退到配置域名。
   */
  async probeShareDomain(shareId: string): Promise<string> {
    const cleanShareId = (shareId || "").replace(/^\//, "")
    if (!cleanShareId) return this.getShareUrl()
    try {
      const pageData = await this.request(
        `${this.getShareUrl()}/${cleanShareId}`,
        "GET",
      )
      const realDomain = this.extractRealShareDomain(pageData)
      return realDomain || this.getShareUrl()
    } catch {
      return this.getShareUrl()
    }
  }

  /** 從分享頁 HTML 中提取真實分享域名（iframe src / /fn? 鏈接 / 域名變量） */
  private extractRealShareDomain(pageData: string): string {
    const candidates: string[] = []
    const iframeMatch = pageData.match(/<iframe[^>]*?src=["'](https?:\/\/[^"'/]+)/i)
    if (iframeMatch) candidates.push(iframeMatch[1])
    const fnMatch = pageData.match(/["'](https?:\/\/[^"']*?\/fn\?[^"']*)["']/i)
    if (fnMatch) candidates.push(fnMatch[1])
    const domMatch = pageData.match(/["']?(?:dom|url)\s*[:=]\s*["']?(https?:\/\/[^"'\s]+)/i)
    if (domMatch) candidates.push(domMatch[1])
    for (const raw of candidates) {
      try {
        const u = new URL(raw)
        return `${u.protocol}//${u.host}`
      } catch {
        // 繼續下一個候選
      }
    }
    return ""
  }

  /**
   * 賬號密碼登入
   */
  async login(): Promise<void> {
    if (!this.addition.account || !this.addition.password) {
      throw new Error("[Lanzou] 賬號模式下必須提供賬號與密碼")
    }

    for (let retry = 0; retry < 3; retry++) {
      const headers: Record<string, string> = {
        "User-Agent": this.getUserAgent(),
        Referer: "https://pc.woozooo.com",
        "Content-Type": "application/x-www-form-urlencoded",
      }
      if (this.acwMap.has("up.woozooo.com")) {
        headers["Cookie"] = `acw_sc__v2=${this.acwMap.get("up.woozooo.com")}`
      }

      const res = await fetch("https://up.woozooo.com/mlogin.php", {
        method: "POST",
        headers,
        body: new URLSearchParams({
          task: "3",
          uid: this.addition.account,
          pwd: this.addition.password,
          setSessionId: "",
          setSig: "",
          setScene: "",
          setTocen: "",
          formhash: "",
        }),
      })

      this.updateCookie(res.headers.get("set-cookie"), "up.woozooo.com")
      const bodyStr = await res.text()

      if (bodyStr.includes("acw_sc__v2")) {
        this.acwMap.set("up.woozooo.com", calcAcwScV2(bodyStr))
        continue
      }

      let data: any
      try {
        data = JSON.parse(bodyStr)
      } catch {
        throw new Error(`[Lanzou] 登入響應異常: ${bodyStr.slice(0, 200)}`)
      }

      if (data.zt !== 1) {
        throw new Error(`[Lanzou] 登入失敗: ${data.info || bodyStr}`)
      }

      return
    }

    throw new Error("[Lanzou] 登入多次觸發 WAF 校驗失敗")
  }

  /**
   * 從 mydisk.php 獲取 uid 與 vei 憑證
   */
  async initVeiAndUid(): Promise<void> {
    const html = await this.request(
      `${this.getBaseUrl()}/mydisk.php?item=files&action=index`,
      "GET",
    )

    const uidMatch = html.match(/uid=([^'"&;]+)/)
    if (!uidMatch) {
      throw new Error(COOKIE_EXPIRED_MSG)
    }
    this.uid = uidMatch[1]

    const cleanHtml = removeNotes(html)
    try {
      const data = htmlJsonToMap(cleanHtml)
      this.vei = data["vei"] || ""
    } catch {
      const veiMatch = html.match(/['"]?vei['"]?\s*:\s*['"]?([^'",\s]+)['"]?/)
      if (veiMatch) this.vei = veiMatch[1]
    }
  }

  /**
   * 通用 HTTP 請求（包含 acw_sc__v2 自動求解、down_ip 頭處理、
   *  以及分享頁請求被 CDN 403 時自動切換其他藍奏雲域名重試）
   */
  async request(
    url: string,
    method: "GET" | "POST" = "GET",
    body?: Record<string, string>,
    customReferer?: string,
  ): Promise<string> {
    // 若已記錄工作域名，且當前 URL 屬於分享域（getShareUrl 或其候選域），
    // 則優先把 URL 切換到工作域名，確保分享頁與 ajaxfile.php 同域（sign 綁定域名）。
    let effectiveUrl = url
    const urlHost = safeHost(url)
    const isShareHost =
      urlHost === this.shareHost() ||
      LANZOU_SHARE_DOMAINS.includes(urlHost)
    if (isShareHost && this.workingShareHost && urlHost !== this.workingShareHost) {
      effectiveUrl = targetUrlWithDomain(url, this.workingShareHost)
    }

    // 分享頁請求 403/405 時自動切換候選域名重試（資料中心 IP 被單域名 WAF 攔截時有用）
    const isShareDomainReq = isShareHost
    const shareCandidates = isShareDomainReq
      ? LANZOU_SHARE_DOMAINS.filter((d) => !url.includes(d))
      : []

    const tryUrl = (targetUrl: string): Promise<string> => {
      const targetHost = safeHost(targetUrl)
      const targetIsShareDomain =
        targetHost === this.shareHost() ||
        LANZOU_SHARE_DOMAINS.includes(targetHost)
      // referer 必須與目標 URL 同域（藍奏雲對跨域 AJAX 返回 zt=0/403）
      let referer: string
      if (targetIsShareDomain) {
        // 分享域請求：referer 用目標域名自身（優先）或重寫後的 customReferer
        if (customReferer && LANZOU_SHARE_DOMAINS.includes(safeHost(customReferer))) {
          referer = targetUrlWithDomain(customReferer, targetHost)
        } else if (customReferer && safeHost(customReferer) === this.shareHost()) {
          referer = targetUrlWithDomain(customReferer, targetHost)
        } else {
          referer = `${new URL(targetUrl).origin}/`
        }
      } else {
        referer = customReferer || this.getBaseUrl()
      }

      return this.requestOnce(
        targetUrl,
        method,
        body,
        referer,
        targetHost,
      )
    }

    try {
      return await tryUrl(effectiveUrl)
    } catch (err: any) {
      // 僅在分享頁請求（非 baseUrl API）且確實被 WAF/403/405 拒絕時換域名重試
      const blocked =
        isShareDomainReq &&
        (err?.status === 403 || err?.status === 405 || /403|405/.test(err?.message || ""))
      if (!blocked) throw err
      for (const domain of shareCandidates) {
        const altUrl = targetUrlWithDomain(effectiveUrl, domain)
        try {
          const result = await tryUrl(altUrl)
          // 記錄成功的工作域名，後續分享域請求優先使用
          this.workingShareHost = domain
          return result
        } catch (e2: any) {
          const stillBlocked =
            e2?.status === 403 || e2?.status === 405 || /403|405/.test(e2?.message || "")
          if (!stillBlocked) throw e2
          // 繼續嘗試下一個域名
        }
      }
      throw err
    }
  }

  /**
   * 單次請求（含 acw_sc__v2 求解與重試）
   */
  private async requestOnce(
    url: string,
    method: "GET" | "POST",
    body: Record<string, string> | undefined,
    referer: string,
    host: string,
  ): Promise<string> {
    for (let retry = 0; retry < 3; retry++) {
      const headers: Record<string, string> = {
        Referer: referer,
        "User-Agent": this.getUserAgent(),
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        // 藍奏雲 WAF 校驗 AJAX 請求必須帶 X-Requested-With，否則返回 403/405
        "X-Requested-With": "XMLHttpRequest",
        // 模擬瀏覽器 AJAX 的 Fetch 元資料頭，降低被 WAF 攔的概率
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        Accept: "*/*",
      }
      // 同源 AJAX 請求帶 Origin（與 Referer 同域）
      const refHost = (() => {
        try {
          return new URL(referer).host
        } catch {
          return ""
        }
      })()
      if (refHost === host) {
        headers["Origin"] = referer.slice(0, referer.indexOf(refHost) + refHost.length)
      }

      let cookieStr = this.cookie
      if (url.includes("/file/")) {
        cookieStr = (cookieStr ? cookieStr + "; " : "") + "down_ip=1"
      }
      const acw = this.acwMap.get(host)
      if (acw) {
        cookieStr = (cookieStr ? cookieStr + "; " : "") + `acw_sc__v2=${acw}`
      }
      if (cookieStr) {
        headers["Cookie"] = cookieStr
      }

      let reqBody: string | undefined = undefined
      if (body && method === "POST") {
        headers["Content-Type"] =
          "application/x-www-form-urlencoded; charset=UTF-8"
        reqBody = new URLSearchParams(body).toString()
      }

      const res = await fetch(url, {
        method,
        headers,
        body: reqBody,
      })

      // 先處理 set-cookie（403 時 WAF 也可能下發 acw_sc__v2，必須快取）
      this.updateCookie(res.headers.get("set-cookie"), host)

      if (res.status === 403 || res.status === 405) {
        const err: any = new Error(`[Lanzou] ${url} 返回 HTTP ${res.status}`)
        err.status = res.status
        throw err
      }

      // 偶發的 429/5xx/網路波動不是業務錯誤：延遲後重試（藍奏雲限流常見）
      if (
        res.status === 429 ||
        res.status >= 500 ||
        res.status === 408
      ) {
        if (retry < 2) {
          await new Promise((resolve) =>
            setTimeout(resolve, 300 * (retry + 1)),
          )
          continue
        }
        const err: any = new Error(
          `[Lanzou] ${url} 返回 HTTP ${res.status}（多次重試仍失敗）`,
        )
        err.status = res.status
        throw err
      }

      const bodyStr = await res.text()

      if (bodyStr.includes("acw_sc__v2")) {
        this.acwMap.set(host, calcAcwScV2(bodyStr))
        continue
      }

      return bodyStr
    }

    throw new Error("[Lanzou] 請求觸發 acw_sc__v2 校驗超限")
  }

  /**
   * 執行 doupload.php 後台任務
   */
  async doupload(params: Record<string, string>): Promise<any> {
    const url = `${this.getBaseUrl()}/doupload.php?uid=${this.uid}&vei=${this.vei}`
    const bodyStr = await this.request(url, "POST", params)
    let data: any
    try {
      data = JSON.parse(bodyStr)
    } catch {
      throw new Error(`[Lanzou] 非 JSON 響應: ${bodyStr.slice(0, 200)}`)
    }

    if (data.zt === 9) {
      if (this.addition.type === "account") {
        await this.login()
        await this.initVeiAndUid()
        return this.doupload(params)
      }
      throw new Error(COOKIE_EXPIRED_MSG)
    }

    if (data.zt !== 1 && data.zt !== 2 && data.zt !== 4) {
      throw new Error(
        data.inf || data.info || `[Lanzou] API 錯誤 (zt: ${data.zt})`,
      )
    }

    return data
  }

  /**
   * 主動校驗當前 Cookie 是否有效。
   * 藍奏雲 Cookie 有效期約 15 天，過期後 doupload 返回 zt=9。
   * 此處通過請求根目錄文件列表來探測；url 模式（公開分享）不依賴 Cookie，恆為有效。
   * @returns { valid: true } 或 { valid: false, error: 過期提示 }
   */
  async checkCookieValid(): Promise<{ valid: boolean; error?: string }> {
    if (this.addition.type === "url") {
      return { valid: true }
    }
    try {
      if (this.addition.type === "account") {
        // account 模式自動重登，無需手動更新 Cookie
        return { valid: true }
      }
      // cookie 模式：請求一次根目錄列表探測有效性
      await this.getFiles("-1")
      return { valid: true }
    } catch (err: any) {
      const msg = err?.message || String(err)
      // 過期/uid 丟失/WAF 拒絕都視為 Cookie 失效，給出明確提示
      return {
        valid: false,
        error: /Cookie 已過期|未能獲取到 uid|請檢查 Cookie|zt=9/i.test(msg)
          ? COOKIE_EXPIRED_MSG
          : msg,
      }
    }
  }

  /**
   * 獲取個人網盤目錄下所有文件夾與文件
   */
  async getAllFiles(folderId: string): Promise<LanzouFileOrFolder[]> {
    const folders = await this.getFolders(folderId)
    const files = await this.getFiles(folderId)
    return [...folders, ...files]
  }

  async getFolders(folderId: string): Promise<LanzouFileOrFolder[]> {
    const resp = await this.doupload({
      task: "47",
      folder_id: folderId || "-1",
    })
    const list: any[] = resp.text || []
    return list.map((item) => ({
      ...item,
      name: item.name,
      fol_id: item.fol_id || item.id,
      is_folder: true,
    }))
  }

  async getFiles(folderId: string): Promise<LanzouFileOrFolder[]> {
    const allFiles: LanzouFileOrFolder[] = []
    for (let pg = 1; ; pg++) {
      const resp = await this.doupload({
        task: "5",
        folder_id: folderId || "-1",
        pg: String(pg),
      })
      const list: any[] = resp.text || []
      if (list.length === 0) break
      allFiles.push(
        ...list.map((item) => ({
          ...item,
          name_all: item.name_all || item.name,
          id: item.id,
          size: item.size,
          time: item.time,
          is_folder: false,
        })),
      )
    }
    return allFiles
  }

  /**
   * 獲取個人盤文件的公開分享信息
   */
  async getFileShareUrlById(fileId: string): Promise<LanzouFileShare> {
    const resp = await this.doupload({
      task: "22",
      file_id: fileId,
    })
    return resp.info || {}
  }

  /**
   * 通過公開分享頁面獲取目錄或單個文件
   */
  async getFileOrFolderByShareUrl(
    shareId: string,
    pwd: string = "",
  ): Promise<LanzouFileOrFolder[]> {
    const cleanShareId = shareId.replace(/^\//, "")
    const pageData = await this.request(
      `${this.getShareUrl()}/${cleanShareId}`,
      "GET",
    )

    if (pageData.includes("取消分享")) {
      throw new Error("[Lanzou] 該文件已取消分享")
    }
    if (pageData.includes("文件不存在")) {
      throw new Error("[Lanzou] 文件不存在")
    }

    const isFile = /class="fileinfo"|id="file"|文件描述/i.test(pageData)
    if (!isFile) {
      // 目錄分享
      return this.getFolderByShareUrl(pwd, pageData)
    } else {
      // 單文件分享
      const file = await this.getFilesByShareUrl(cleanShareId, pwd, pageData)
      return [file]
    }
  }

  /**
   * 解析分享目錄列表
   */
  private async getFolderByShareUrl(
    pwd: string,
    sharePageData: string,
  ): Promise<LanzouFileOrFolder[]> {
    const cleanHtml = removeNotes(sharePageData)
    let form: Record<string, string> = {}
    try {
      form = htmlJsonToMap(cleanHtml)
    } catch {
      form = {}
    }

    const files: LanzouFileOrFolder[] = []

    // 匹配子文件夾
    const subFolderMatches = Array.from(
      sharePageData.matchAll(
        /(?:folderlink|mbxfolder)[^>]*href=["']\/?([^"']+)["'][^>]*>(.+?)<\//gi,
      ),
    )
    for (const m of subFolderMatches) {
      files.push({
        id: m[1],
        name_all: m[2].trim(),
        is_folder: true,
      })
    }

    // 分頁獲取文件
    form["pwd"] = pwd || this.addition.share_password || ""
    for (let page = 1; ; page++) {
      form["pg"] = String(page)
      const resStr = await this.request(
        `${this.getShareUrl()}/filemoreajax.php`,
        "POST",
        form,
      )
      let resp: any
      try {
        resp = JSON.parse(resStr)
      } catch {
        break
      }
      if (
        resp.zt !== 1 ||
        !Array.isArray(resp.text) ||
        resp.text.length === 0
      ) {
        break
      }
      const list: any[] = resp.text

      files.push(
        ...list.map((item) => ({
          id: item.id,
          name_all: item.name_all || item.name,
          size: item.size,
          time: item.time,
          is_folder: false,
          pwd: form["pwd"],
        })),
      )
    }

    return files
  }

  /**
   * 解析單文件分享頁面並提取下載直鏈
   */
  async getFilesByShareUrl(
    shareId: string,
    pwd: string = "",
    cachedPageData?: string,
    customShareDomain?: string,
  ): Promise<LanzouFileOrFolder> {
    const cleanShareId = shareId.replace(/^\//, "")
    const shareBaseDomain = (
      customShareDomain ||
      (await this.probeShareDomain(cleanShareId))
    ).replace(/\/+$/, "")
    const sharePageUrl = `${shareBaseDomain}/${cleanShareId}`
    let pageData = cachedPageData
    if (!pageData) {
      pageData = await this.request(sharePageUrl, "GET")
    }

    pageData = removeNotes(pageData)
    pageData = removeJSComment(pageData)

    let param: Record<string, string> = {}
    let baseUrl = ""
    let downloadUrl = ""
    const fileResult: LanzouFileOrFolder = {
      id: cleanShareId,
      is_folder: false,
    }

    const needsPassword =
      pageData.includes("pwdload") || pageData.includes("passwddiv")

    if (needsPassword) {
      const fnCode = getJSFunctionByName(pageData, "down_p")
      param = htmlJsonToMap(fnCode, pageData)
      param["p"] = pwd || this.addition.share_password || ""

      const fileIdMatch =
        fnCode.match(/['"]?\/?ajax(?:file|m)\.php\?file=(\d+)['"]?/) ||
        pageData.match(/['"]?\/?ajax(?:file|m)\.php\?file=(\d+)['"]?/) ||
        fnCode.match(/file\s*[:=]\s*['"]?(\d+)['"]?/) ||
        pageData.match(/file\s*[:=]\s*['"]?(\d+)['"]?/) ||
        fnCode.match(/var\s+file_id\s*=\s*['"]?(\d+)['"]?/) ||
        pageData.match(/var\s+file_id\s*=\s*['"]?(\d+)['"]?/)
      const fileId = fileIdMatch ? fileIdMatch[1] : ""
      if (!fileId) throw new Error("[Lanzou] 未找到文件 ID")

      const resStr = await this.request(
        `${shareBaseDomain}/ajaxfile.php?file=${fileId}`,
        "POST",
        param,
        sharePageUrl,
      )
      let resp: LanzouShareResp<string>
      try {
        resp = JSON.parse(resStr)
      } catch {
        throw new Error(`[Lanzou] ajaxfile.php 響應格式錯誤: ${resStr}`)
      }
      if (resp.zt !== 1) {
        throw new Error(
          resp.info ||
            resp.text ||
            `[Lanzou] 密碼錯誤或提取鏈接失敗 (zt=${resp.zt})`,
        )
      }

      fileResult.name_all = resp.inf || "download"
      baseUrl = `${resp.dom}/file`
      downloadUrl = `${baseUrl}/${resp.url}`
    } else {
      const iframeMatch =
        pageData.match(/<iframe[^>]*?src=["']([^"']+)["']/i) ||
        pageData.match(/href=["'](\/fn\?[^"']+)["']/i) ||
        pageData.match(/["'](\/fn\?[^"']+)["']/i)
      if (!iframeMatch) {
        throw new Error("[Lanzou] 未找到下載頁面 iframe 參數")
      }

      const iframePath = iframeMatch[1]
      const iframeFullUrl = `${shareBaseDomain}${iframePath.startsWith("/") ? "" : "/"}${iframePath}`
      const nextPageData = await this.request(
        iframeFullUrl,
        "GET",
        undefined,
        sharePageUrl,
      )
      const cleanNextPage = removeNotes(nextPageData)
      param = htmlJsonToMap(cleanNextPage, cleanNextPage)

      const fileIdMatch =
        cleanNextPage.match(/['"]?\/?ajax(?:file|m)\.php\?file=(\d+)['"]?/) ||
        cleanNextPage.match(/file\s*[:=]\s*['"]?(\d+)['"]?/) ||
        cleanNextPage.match(/file=(\d+)/) ||
        cleanNextPage.match(/var\s+file_id\s*=\s*['"]?(\d+)['"]?/)
      const fileId = fileIdMatch ? fileIdMatch[1] : ""
      if (!fileId) throw new Error("[Lanzou] 未找到文件 ID")

      const resStr = await this.request(
        `${shareBaseDomain}/ajaxfile.php?file=${fileId}`,
        "POST",
        param,
        iframeFullUrl,
      )
      let resp: LanzouShareResp
      try {
        resp = JSON.parse(resStr)
      } catch {
        throw new Error(`[Lanzou] ajaxfile.php 響應格式錯誤: ${resStr}`)
      }
      if (resp.zt !== 1) {
        throw new Error(
          resp.info || resp.text || `[Lanzou] 提取鏈接失敗 (zt=${resp.zt})`,
        )
      }

      baseUrl = `${resp.dom}/file`
      downloadUrl = `${baseUrl}/${resp.url}`

      const nameMatch = pageData.match(
        /<title>(.+?) - 藍奏雲<\/title>|id="filenajax">(.+?)<\/div>|var filename = ['"](.+?)['"];|<div style="font-size[^>]*>([^<>]+)<\/div>|<div class="filethetext"[^>]*>([^<>]+)<\/div>/i,
      )
      if (nameMatch) {
        for (let i = 1; i < nameMatch.length; i++) {
          if (nameMatch[i]) {
            fileResult.name_all = nameMatch[i].trim()
            break
          }
        }
      }
    }

    const sizeMatch = pageData.match(/大小\W*([0-9.]+\s*[bkm]+)/i)
    if (sizeMatch) fileResult.size = sizeMatch[1]

    const timeMatch = pageData.match(
      /\d+\s*[秒天分小][鍾時]?前|[昨前]天|\d{4}-\d{2}-\d{2}/,
    )
    if (timeMatch) fileResult.time = timeMatch[0]

    // 解析 302 重定向獲得真實直鏈。
    // 藍奏雲直鏈伺服器（dom 返回的 lanrar.com 等）偶發限流/超時，
    // 網路錯誤必須重試而非直接失敗，避免"直鏈解析失敗"隨機出現。
    let realDirectUrl = downloadUrl
    let vs = ""
    let resolved = false
    for (let i = 0; i < 3; i++) {
      const headers: Record<string, string> = {
        Referer: baseUrl,
        "User-Agent": this.getUserAgent(),
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
      }
      let c = "down_ip=1"
      if (vs) c += `; acw_sc__v2=${vs}`
      headers["Cookie"] = c

      let probeRes: Response
      try {
        probeRes = await fetch(downloadUrl, {
          method: "GET",
          headers,
          redirect: "manual",
        })
      } catch {
        // 網路層偶發失敗（超時/斷連），退避重試
        if (i < 2) {
          await new Promise((resolve) => setTimeout(resolve, 400 * (i + 1)))
          continue
        }
        throw new Error("[Lanzou] 直鏈探測網路錯誤，請稍後重試")
      }

      if (
        probeRes.status === 301 ||
        probeRes.status === 302 ||
        probeRes.status === 303 ||
        probeRes.status === 307 ||
        probeRes.status === 308
      ) {
        const loc = probeRes.headers.get("location")
        if (loc) {
          realDirectUrl = new URL(loc, downloadUrl).toString()
          resolved = true
          break
        }
      }

      if (
        probeRes.status === 200 &&
        probeRes.url &&
        probeRes.url !== downloadUrl
      ) {
        realDirectUrl = probeRes.url
        resolved = true
        break
      }

      // 429/5xx 偶發限流：退避重試
      if (probeRes.status === 429 || probeRes.status >= 500) {
        if (i < 2) {
          await new Promise((resolve) => setTimeout(resolve, 400 * (i + 1)))
          continue
        }
        throw new Error(
          `[Lanzou] 直鏈探測返回 HTTP ${probeRes.status}，請稍後重試`,
        )
      }

      const bodyText = await probeRes.text()
      if (bodyText.includes("acw_sc__v2")) {
        vs = calcAcwScV2(bodyText)
        continue
      }

      // 二次驗證 ajax.php 兜底
      try {
        const ajaxParam = htmlJsonToMap(bodyText, bodyText)
        ajaxParam["el"] = "2"
        await new Promise((resolve) => setTimeout(resolve, 1500))

        const ajaxResStr = await this.request(
          `${baseUrl}/ajax.php`,
          "POST",
          ajaxParam,
          baseUrl,
        )
        const ajaxData = JSON.parse(ajaxResStr)
        if (ajaxData.url) {
          realDirectUrl = ajaxData.url.startsWith("http")
            ? ajaxData.url
            : new URL(ajaxData.url, baseUrl).toString()
          resolved = true
          break
        }
      } catch {
        // ajax.php 兜底失敗：再試一輪（可能是瞬時限流）
        if (i < 2) {
          await new Promise((resolve) => setTimeout(resolve, 600 * (i + 1)))
          continue
        }
      }
      break
    }

    if (!resolved) {
      throw new Error("[Lanzou] 直鏈解析失敗，請稍後重試")
    }

    fileResult.url = realDirectUrl
    return fileResult
  }

  /**
   * 通過 HEAD 請求獲取真實 Content-Length 和 Last-Modified
   */
  async getFileRealInfo(
    downUrl: string,
  ): Promise<{ size?: number; time?: string }> {
    try {
      const res = await fetch(downUrl, {
        method: "HEAD",
        headers: { "User-Agent": this.getUserAgent() },
      })
      const len = res.headers.get("content-length")
      const modified = res.headers.get("last-modified")
      return {
        size: len ? parseInt(len, 10) : undefined,
        time: modified ? new Date(modified).toISOString() : undefined,
      }
    } catch {
      return {}
    }
  }

  /**
   * 目錄與文件管理操作
   */
  async mkdir(parentId: string, dirName: string): Promise<void> {
    await this.doupload({
      task: "2",
      parent_id: parentId || "-1",
      folder_name: dirName,
      folder_description: "",
    })
  }

  async rename(fileId: string, newName: string): Promise<void> {
    await this.doupload({
      task: "46",
      file_id: fileId,
      file_name: newName,
      type: "2",
    })
  }

  async move(fileId: string, targetFolderId: string): Promise<void> {
    await this.doupload({
      task: "20",
      file_id: fileId,
      folder_id: targetFolderId,
    })
  }

  async remove(id: string, isFolder: boolean): Promise<void> {
    if (isFolder) {
      await this.doupload({
        task: "3",
        folder_id: id,
      })
    } else {
      await this.doupload({
        task: "6",
        file_id: id,
      })
    }
  }
}

/**
 * 將分享頁 URL 的主機名替換為指定候選域名（分享 ID 全局可用）
 */
function targetUrlWithDomain(url: string, domain: string): string {
  try {
    const u = new URL(url)
    u.host = domain
    return u.toString()
  } catch {
    return url
  }
}

/** 安全提取 URL 主機名 */
function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ""
  }
}
