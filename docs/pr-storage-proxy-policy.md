<!--
PR title / PR 標題:
- Use Conventional Commits: `type(scope): summary`
- Allowed types: `feat`, `docs`, `fix`, `style`, `refactor`, `chore`
- Scope is required by the current PR title check.
- For breaking changes, add `!`: `feat(driver)!: change auth flow`
-->

`feat(storage): implement storage-level proxy policy and align drivers with Go behavior`

## Summary / 摘要

<!--
Briefly describe what changed and why.
簡要說明改了什麼，以及為什麼需要改。
-->

本 PR 修復了儲存級下載/代理配置在 TSWorker 後端**全部失效**的問題，並把四個此前只有資料庫列與表單項、沒有讀取方的欄位真正接入運行時，行為與 Go 版 OpenList 對齊。

**問題背景**：`web_proxy`、`webdav_policy`、`down_proxy_url`、`disable_proxy_sign`、`proxy_range`、`enable_sign`、`disable_index`、`custom_cache_policies` 這些欄位在 TSWorker 中都能在後台填寫、也能存入資料庫，但後端**沒有任何代碼讀取它們**。同時 `server/raw.ts` 用一段硬編碼的驅動名單強制若干驅動走代理：

```ts
const needsProxy =
  isProxy ||
  normDriver === "webdav" ||
  normDriver === "sharepoint" ||
  normDriver === "onedrive" ||
  normDriver === "onedriveapp" ||
  normDriver === "weiyun" ||
  normDriver === "tencentweiyun"
```

因此 **OneDrive 無論後台怎麼配置都無法使用 302 直鏈**，管理員在儲存編輯頁看到的所有代理選項實際上都是裝飾。

<!--
- List user-visible behavior changes.
- List important implementation changes.
- Mention config, storage, API, or compatibility changes if any.

- 列出用戶可感知的行為變化。
- 列出重要實現變化。
- 如涉及配置、儲存、API 或相容性變化，請明確說明。
-->

### 用戶可感知的行為變化

- **OneDrive / OneDriveAPP 默認改為 302 直鏈下載**（對齊 Go 默認值 `302_redirect`）。此前被硬編碼強制代理。如需保留代理行為，請將該儲存的 `webdav_policy` 設為 `native_proxy`。
- `web_proxy`、`webdav_policy`、`down_proxy_url`、`disable_proxy_sign` 在後台的配置**從此真實生效**。
- 儲存編輯表單新增四個欄位：`proxy_range`、`enable_sign`、`disable_index`、`custom_cache_policies`。
- 儲存表單按驅動能力差異化顯示：Go 的 `MustProxy`（`OnlyProxy`/`NoLinkURL`）驅動不再出現 302 選項；`PreferProxy` 驅動的 `web_proxy` 默認勾選；`proxy_range` 僅對 Go 中聲明 `ProxyRangeOption` 的驅動顯示。
- `/fs/list` 對開啟 `disable_index` 的儲存返回 `403 {"message":"Index is disabled for this storage"}`。
- `/fs/list` 響應新增 `cache_expiration` 欄位（路徑級快取策略計算後的分鐘數）。
- **代理下載超過平台載荷上限時不再返回平台錯誤頁**：EdgeOne 雲函數對單次請求/響應 body 的上限為 6 MiB，原生代理超限時改為「降級 302 直鏈」或返回可讀的 413（詳見下方「平台載荷上限保護」）。

### 重要實現變化

- 新增 `internal/driver/proxy.ts`：統一的下載模式決策與驅動代理能力註冊表，對齊 Go 的 `Config.MustProxy()` / `Config.DefaultProxy()` / `ShouldProxy()`。
- 新增 `internal/driver/storageopts.ts`：解析 `proxy_range` / `enable_sign` / `disable_index` / `cache_expiration` / `custom_cache_policies` 並提供 glob 匹配與快取時長合成。
- `server/raw.ts`：用 `resolveProxyDecision()` 替換硬編碼驅動名單；抽出 `proxyUpstream()`；實現 `use_proxy_url`（含 `$path` 替換與運行時補籤）。
- `server/admin.ts`：新增 `buildProxyFields()` 復刻 Go `internal/op/driver.go` 的表單分支規則。
- `pkg/sign.ts`：`isEncryptPath` 增加儲存級簽名分支，判定順序為「儲存 `enable_sign` → meta 密碼」。
- **修復 `getDownProxyUrl()`**：此前只讀 `storage.addition`，而表單把 `down_proxy_url` 寫在儲存行**頂層**，導致 `use_proxy_url` 永遠取不到值。

### 配置 / 儲存 / API 變化

- 無資料庫 schema 變更：所用列均已存在，本 PR 僅補上讀取方。
- `/fs/list` 響應為**向後相容的增量變更**（新增 `cache_expiration`，且開啟 `disable_index` 時會新增 403 分支）。
- 新增 19 個單元測試。

- [ ] This PR has breaking changes.
      / 此 PR 包含破壞性變更。
- [x] This PR changes public API, config, storage format, or migration behavior.
      / 此 PR 修改了公開 API、配置、儲存格式或遷移行為。
- [ ] This PR requires corresponding changes in related repositories.
      / 此 PR 需要關聯倉庫同步修改。

> 關於相容性：本 PR **不含破壞性變更**，但存在**行為變更**——OneDrive 系列的默認下載模式由「強制代理」變為「302 直鏈」。這與 Go 版一致，但會改變既有 OneDrive 儲存的實際表現：存量儲存沒有 `webdav_policy` 值，將解析為 `302_redirect`。若某些掛載依賴代理（例如直鏈在受限租戶下不可用），請顯式設置 `webdav_policy = native_proxy`。該行為變更已在下方「Testing」中說明，建議在 release note 中提示用戶。

Related repository PRs / 關聯倉庫 PR:

- OpenList: N/A（本 PR 為對齊 Go 版既有行為，無需 Go 側改動）
- OpenList-Docs:

## Related Issues / 關聯 Issue

<!--
Use `Closes #123`, `Fixes #123`, or `Relates to #123`.
Remove this section if not applicable.
使用 `Closes #123`、`Fixes #123` 或 `Relates to #123`。
不適用時請刪除本節。
-->

Relates to #51

> 說明：本 PR **不修復** #51 的根因。`enable_sign` 會走 `getJwtSecret`，而 `readPersistedSecret` 只探測 KV、沒有 D1 分支，因此在 D1 多實例部署下仍會遇到簽名密鑰不穩定。`enable_sign=false` 可作為臨時繞過手段，但密鑰持久化需要單獨修復。

## Testing / 測試

<!--
Describe commands, platforms, and manual checks.
If not tested, explain why.

說明執行過的命令、測試平台和手動驗證。
如果未測試，請說明原因。
-->

- [ ] `go test ./...`（本項目為 TypeScript，不適用；替代命令見下）
- [ ] Manual test / 手動測試:

本項目使用的等價命令：

```bash
npx tsc --noEmit -p tsconfig.json        # 類型檢查：exit 0，無錯誤
node --import tsx --test "src/backend/**/*.test.ts"
```

測試結果（已合併 `origin/main`，即 main 上的 `9b9c243`）：**276 個測試，271 通過**。

其中 5 個失敗為**既有問題，與本 PR 無關**——在**純淨的 `origin/main` 上跑同一套命令得到完全相同的 5 個失敗**（基線為 200 個測試 / 195 通過 / 5 失敗）：

- `server/default_credentials.test.ts` — 默認憑據 / ADMIN_PASS 初始化與重置
  （`Initialization: a fresh deployment stays uninitialized without ADMIN_PASS`、
  `Initialization: an empty admin password stays empty (uninitialized), not a random one`、
  `Security(F-11): ADMIN_PASS still forces an explicit reset (to salted double-SHA256)`）
- `server/seed.test.ts` — `CAS codec matches casmeta base64 JSON field names`

新增 `server/proxy_request.test.ts` 的平台載荷上限用例（21 個，該文件累計 36 個），覆蓋：

- 上限解析：EdgeOne 運行時默認 6 MiB（含 SCF / Blob 判據）、`RAW_PROXY_MAX_BYTES` 覆蓋與置 0 關閉、非法值回退默認
- 運行時判定：`__requestOrigin` 不構成 EdgeOne 判據（該值在所有平台都會注入，不能用來判平台）
- 超限判定：等於上限不算超限、Range 分片按分片大小、大小未知不攔截
- 決策：未超限照常代理、超限且可直連時降級 302、超限且必須帶私有鑑權頭時返回可讀 413
- 串聯 `resolveProxyDecision()`：`web_proxy=true` 的 OneDrive 大文件降級 302；帶 `Authorization` 的 WebDAV 大文件返回可讀 413
- **Range + 簽名 + 上限的交互**（響應評審意見）：`upstreamBodySize()` 解析 Content-Length / Content-Range；412 兜底重試後上游回整份文件時按實際大小降級 302（簽名 URL 無需重算）；正常 206 分片不被誤傷；必須帶鑑權頭時返回可讀 413
- **私有頭判定**：`X-Emby-Token` / `X-Amz-Security-Token` / `X-Session-Id` 視為私有頭；`User-Agent` / `Referer` / `Origin` / `Content-Type` 不算（與倉庫內 33 處 `raw_url_headers` 的實際用法一致）

新增 `internal/driver/storageopts.test.ts`（19 個用例），覆蓋：

- `proxy_range`：未配置時默認透傳（對齊 Go 的透明代理）、顯式 true/false 優先
- `enable_sign` / `disable_index`：字符串與布爾兩種儲存形式
- `custom_cache_policies`：JSON 數組、對象映射、`max_age` 別名、非法輸入不拋錯
- glob 匹配：`*` 不跨目錄分隔符、`**` 可跨、`?` 通配
- 快取時長合成：命中覆蓋、未命中用基礎值、值為 0 表示不快取、多規則最後一條優先、非法/負數回退默認
- 代理決策協同：默認驅動走 302、開啟代理後 `proxy_range` 決定是否透傳 Range、`down_proxy_url` 多寫法解析

> **未做的驗證**：未在真實 Cloudflare Workers / EdgeOne 環境跑端到端下載。`use_proxy_url` 的運行時補籤路徑、以及 Range 透傳在中轉場景下的實際表現建議在合併前手動迴歸。產物需重新執行 `node scripts/build-edge.mjs` 生成。

## Checklist / 檢查清單

- [ ] I have read [CONTRIBUTING](https://github.com/OpenListTeam/OpenList/blob/main/CONTRIBUTING.md).
      / 我已閱讀 [CONTRIBUTING](https://github.com/OpenListTeam/OpenList/blob/main/CONTRIBUTING.md)。
- [ ] I confirm this contribution follows the repository license, contribution policy, and code of conduct.
      / 我確認此貢獻符合倉庫許可證、貢獻規範和行為準則。
- [ ] I have formatted the changed code with `gofmt`, `go fmt`, or `prettier` where applicable.
      / 我已按適用情況使用 `gofmt`、`go fmt` 或 `prettier` 格式化變更代碼。
- [ ] I have requested review from relevant maintainers or code owners where applicable.
      / 我已在適用情況下請求相關維護者或代碼所有者審查。

## AI Disclosure / AI 使用聲明

<!--
Please disclose any substantial AI assistance used in this PR.
Minor AI assistance, such as typo fixes, autocomplete, formatting suggestions,
or wording polish, does not need to be disclosed.
Remove this section if not applicable.

請披露此 PR 中使用的重要 AI 輔助內容。
輕微 AI 輔助，例如拼寫修正、自動補全、格式建議或文字潤色，無需披露。
如不適用，請刪除本節。

Deliberate non-disclosure may be treated as a trust and compliance issue.

故意隱瞞 AI 使用情況可能被視為信任與合規問題。
-->

- [x] This PR includes AI-assisted content.
      / 此 PR 包含 AI 輔助內容。

Tools used / 使用工具:

- [ ] ChatGPT
- [ ] Codex
- [ ] GitHub Copilot
- [ ] Claude
- [x] Gemini
- [x] Other (please specify) / 其他（請註明）: CodeBuddy (DeepSeek-V4.1-Flash)

Usage scope / 使用範圍:

- [x] Code generation / 代碼生成
- [x] Refactoring / 重構
- [ ] Documentation / 文件
- [x] Tests / 測試
- [ ] Translation / 翻譯
- [x] Review assistance / 審查輔助

- [x] I have reviewed and validated all AI-assisted content included in this PR.
      / 我已審核並驗證此 PR 中的所有 AI 輔助內容。
- [x] I have ensured that all AI-assisted commits include `Co-Authored-By` attribution.
      / 我已確保所有 AI 輔助提交都包含 `Co-Authored-By` 歸屬信息。
- [x] I can reproduce all AI-assisted content included in this PR without any AI tools.
      / 我可以在沒有任何 AI 工具的情況下重現此 PR 中包含的所有 AI 輔助內容。

> **已處理（響應評審 P0）**：本分支的全部提交都已在提交信息中帶上 `Co-Authored-By: CodeBuddy <noreply@codebuddy.ai>`。此前缺少該 trailer 的三個提交通過 `git cherry-pick` + `git commit --amend --trailer` 重放補上（文件樹與重寫前完全一致，`git diff` 為空），因此分支歷史被重寫並 `--force-with-lease` 更新，提交哈希已變化（見下方「Commits / 提交」）。

## Implementation Notes / 實現說明

### 決策順序（對齊 Go）

`resolveProxyDecision()` 的判定順序與 Go 的優先級一致：

| 順序 | 條件 | 結果 | 來源標記 |
|---|---|---|---|
| 1 | 驅動強制代理（`MustProxy`） | `native_proxy` | `force` |
| 2 | 儲存 `web_proxy = true` | `native_proxy` | `web_proxy` |
| 3 | 請求命中 `/p`、`/sd` 等代理前綴 | `native_proxy` | `proxy_path` |
| 4 | 儲存 `webdav_policy` 已配置 | 按配置值 | `storage_policy` |
| 5 | 驅動默認（`PreferProxy`，如 WebDav） | `native_proxy` | `driver_default` |
| 6 | 兜底 | `302_redirect` | `driver_default` |

第 3 項保留了原有的 `isProxy` 路徑判斷作為顯式入參，確保 `/p` 端點行為不發生迴歸。

### 驅動表單分支（對齊 Go `internal/op/driver.go`）

- **15 個 `MustProxy`（`OnlyProxy`/`NoLinkURL`）驅動**（WeiYun、SFTP、FTP、SMB、Crypt、Virtual、Strm、Mega_nz、ProtonDrive、Chunk、GoogleDrive、GooglePhoto、QuarkOpen、QuarkUC、ChaoXing）：策略選項為 `use_proxy_url,native_proxy`，默認 `native_proxy`，**不提供 302**。清單由 `internal/driver/proxy.ts` 單點提供，`admin.ts` 不再另抄一份（此前 123Pan / BaiduNetdisk / 115Open / 189Cloud / Terabox / 123PanShare 被誤標為 `only_proxy`，而 Go 裡它們只有 `PreferProxy` 或沒有任何標記）
- **WebDav**：`web_proxy` 默認 `true`，策略默認 `native_proxy`（對應 Go `PreferProxy: true`）
- **Onedrive / OnedriveAPP**：默認 `302_redirect`
- **`proxy_range`**：僅對 Go 中聲明 `ProxyRangeOption: true` 的 4 個驅動開放（139Yun、Alias、AListV3、OpenList）。語義為「是否透傳客戶端 Range」，**默認 `true`**：Go 的透明代理本就轉發客戶端請求頭（`internal/net/serve.go` 的 `ProcessHeader`），默認關閉會讓代理模式下的 seek / 斷點續傳靜默退化；上游拒絕或忽略 Range 時由 `shouldRetryWithoutRange()` 兜底

### `use_proxy_url` 的簽名處理

`down_proxy_url` 模板由管理員配置、不攜帶實例密鑰，因此無法在模板中預置簽名。本 PR 在運行時判定：當目標地址指向本站（相對路徑或同 host）且未設置 `disable_proxy_sign` 時，自動補上 `sign` 查詢參數，避免代理端點因缺少簽名被拒。構造出的 URL 仍會經過 `assertSafeUrl` 做 SSRF 校驗。

### 平台載荷上限保護（EdgeOne 雲函數 6 MiB）

`native_proxy` 會把整份文件當作雲函數響應體回傳，而 EdgeOne Makers 的 Cloud Functions 對「函數的請求/響應 body」有 **6 MiB** 硬上限，超限時平台在**網關層**直接返回 `413 CLOUD_FUNCTION_PAYLOAD_TOO_LARGE`（Powered by Tencent EdgeOne Makers 的錯誤頁）。請求根本到不了本服務，應用側的 CORS 頭、Range 處理、錯誤提示一律不會執行。

這也是 issue 中「EdgeOne + OneDrive 下載報 413」的直接原因：OneDrive 此前被硬編碼強制代理；上一提交只把**默認值**改成 302，任何**仍走代理**的路徑（`web_proxy`、`/p`、`webdav_policy=native_proxy`、`PreferProxy`/`MustProxy` 驅動）都依舊會把整份文件塞進雲函數響應體。

`server/proxy_request.ts` 新增上限決策 `decideProxyPayloadAction()`，在 `proxyUpstream()` 與兩處服務端字節流分支（`driver.createReadStream`、本地文件回退）之前執行：

| 情形 | 結果 |
|---|---|
| 未超限 / 平台不限制（非 EdgeOne 且未設置 `RAW_PROXY_MAX_BYTES`） | 正常原生代理 |
| 超限 + `raw_url` 可被瀏覽器直連（預授權直鏈） | 降級 302 直鏈，下載仍然可用 |
| 超限 + 無法降級（`driverMustProxy`，或直鏈需要 `Authorization`/`Cookie`） | 返回可讀的 413，而不是平台錯誤頁 |

Range 只回傳一個分片時按**分片大小**判斷，視頻拖動進度與斷點續傳不受影響；`proxy_range` 關閉時上游返回完整文件，因此按完整大小判斷。

**二次校驗（響應評審意見）**：前置判斷用的是「客戶端請求的分片大小」，但 `shouldRetryWithoutRange()` 會刪掉 Range 重試、上游也可能忽略 Range 直接回 200——這兩種情況下游回傳的是**整份文件**，僅靠前置判斷會漏放。因此 `proxyUpstream()` 在上游響應到達後再用 `upstreamBodySize()`（Content-Length，缺省回退 Content-Range 分段長度）複核一次實際大小，超限則取消上游 body 並降級 302 / 返回可讀 413；206 分片與簽名 URL 均不受影響（簽名綁定 URL，重試無需重算）。

新增環境變量：

| 變量 | 默認 | 說明 |
|---|---|---|
| `RAW_PROXY_MAX_BYTES` | EdgeOne 運行時 6 MiB；其他平台不限制 | 平台單次請求/響應上限（字節），設為 `0` 關閉限制（自託管恢復「永遠代理」） |

**運行時判定（`isEdgeOneRuntime()`）**：EdgeOne Node 雲函數跑在騰訊 SCF 上，平台會注入 `TENCENTCLOUD_SCF_FUNCTIONNAME`（與本倉庫 `internal/model/store/backend.ts` 的 `isServerlessRuntime()` 判據一致），因此以該變量 + `EDGEONE_BLOB` / 全局 `EdgeOne` 作為 EdgeOne 特徵。**刻意不用 `__requestOrigin`**：它由本倉庫 `src/backend/index.ts` 中間件在所有平台上注入，拿它判 EdgeOne 會把 Cloudflare / 自託管一起誤判，反而讓本可正常代理的大文件被降級成 302。Cloudflare Workers / 阿里雲 ESA 不套用 6 MiB；若這些平台也有同類上限，用 `RAW_PROXY_MAX_BYTES` 顯式聲明即可。

### 已知限制

`custom_cache_policies` 目前**只在 `/fs/list` 響應中回傳計算結果**，並未真正改變對象快取的讀寫行為——TSWorker 的快取層尚無「按路徑取過期時長」的入口。要做到 Go 那樣真正影響快取，需要接入快取層，屬後續獨立工作。

## Commits / 提交

- `8c0a88d` — `feat(proxy): align OneDrive and other drivers with Go 302/proxy policy`
- `7a9bcfc` — `feat(storage): implement proxy_range, enable_sign, disable_index and cache policies`
- `954ebff` — `fix(proxy): remove glob catastrophic backtracking and cover Range+sign interactions`
- `e5cbb9d` — `fix(proxy): fall back to 302 when the platform payload limit blocks native proxy`
- `cc896eb` — `docs(pr): document the platform payload-limit guard for the storage proxy policy PR`
- `cb4051f` — `fix(proxy): bound the upstream body size after a Range retry`
- `47d70d3` — `fix(proxy): detect EdgeOne runtimes by the SCF and Blob markers`
- `23a957e` — `refactor(proxy)!: align driver proxy capabilities with Go meta.go`
- `2e913e6` — `docs(pr): record the Go alignment pass`
- `8454f76` — `feat(proxy): honour proxy_types, text_types and proxy_ignore_headers`
- `38ed5de` — `docs(pr): document extension proxying and the /p gate`
- `6d38353` — `Merge remote-tracking branch 'origin/main' into feat/storage-proxy-policy`
  （解決 `internal/model/db.ts` 的 `unsealDb` 並行解密與 `server/raw.ts` 的下載路徑
  mount name 剝離兩處衝突，均取 main 的實現 + 保留本 PR 的 `/p` 端點判定）
- `c2fad5a` — `chore(edgeone): refresh cloud-functions artifact`
  （分支上的 `cloud-functions/[[default]].js` 早於本 PR 的改動，曾不含 payload 上限保護
  與 `/p` 准入等代碼；此處按倉庫既有約定重建）
- （本條 docs 提交）— `docs(pr): sync the commit list and the test baseline after the main merge`

（哈希隨本 PR 的最新提交更新；完整 diff 規模以 GitHub PR 頁面為準。）

> **破壞性行為變更（第二處）**：`PreferProxy` 驅動的「未配置 `web_proxy`」仍默認代理；但
> **顯式設置 `web_proxy=false` 的 WebDav / 123Pan / BaiduNetdisk 儲存會從「代理」變為「302 直鏈」**
> （與 Go 一致）。同理，此前被誤標為強制代理的 115Open / 189Cloud / Terabox / 123PanShare
> 現在可以走直鏈；GoogleDrive / GooglePhoto / QuarkOpen / QuarkUC / ChaoXing 則改為強制代理。

## 評審意見處理

| 評審項 | 處理 |
|---|---|
| P0 提交缺少 `Co-Authored-By` 歸屬 | 已重寫分支歷史為全部 6 個提交補上 trailer（見上方「AI 使用聲明」） |
| P1 `matchGlob()` 遞歸無深度限制可能 DoS | **已在 `954ebff` 修復**：`matchGlob()` 不再使用正則（舊實現把 glob 翻成正則，多個通配符產生相鄰貪婪量詞，實測單次匹配 508 秒 CPU），現為「按段切分 + 動態規劃」，無遞歸、無指數回溯，並有模式/目標長度上限；已有 200 段 `**` 與惡意回溯模式的耗時迴歸測試。評審建議的 `MAX_GLOB_DEPTH = 10` 會誤傷合法模式（如連續 200 個 `**/`），不是合適的修法 |
| P1 Range + 簽名交互測試覆蓋不足 | 已在 `954ebff` 抽出 `server/proxy_request.ts` 並補 17 個測試（Range 透傳不改簽名、412/200 兜底後無需重籤、206 不重試等）；本次 `cb4051f` 進一步補上「兜底重試後上游回整份文件」的二次大小校驗與 4 個用例 |
| P2 驅動能力映射缺少文件註釋 | **已在 `954ebff` 補上**：`internal/driver/proxy.ts` 頂部有驅動 ↔ Go `drivers/*/meta.go` 的完整映射表 |
| P2 未在真實環境端到端驗證 | 仍需手動迴歸（見上方「未做的驗證」） |
| **自審追加**：運行時判據寫錯，守衛在 EdgeOne 上不會生效 | **已在 `47d70d3` 修復**：原先只查 `EDGEONE` / `EO_REGION`，而 EdgeOne Node 雲函數的平台特徵是 `TENCENTCLOUD_SCF_FUNCTIONNAME`（見 `internal/model/store/backend.ts`），會導致 6 MiB 守衛在目標平台上靜默失效；現補上 SCF / `EDGEONE_BLOB` 判據，並明確不採用 `__requestOrigin` |
| **自審追加**：私有頭判定過於複雜 | 先在 `47d70d3` 改成「鑑權語義模式 + 白名單」，隨後對比 Go 後**退回精確名單**（`Authorization` / `Cookie`）：倉庫內 33 處 `raw_url_headers` 只用這兩種鑑權頭，驅動若引入新頭名應按 Go 的 `meta.go` 登記為 `MustProxy`，而不是在下載層猜頭名 |
| **自審追加**：413 文案把平台寫死 | **已在 `47d70d3` 修正**：改為中性表述，並提示限制也可能來自 `RAW_PROXY_MAX_BYTES` |

## 與 Go 版逐項對齊（對比 `OpenList-Backends` 後修正）

| 項 | Go 的事實 | 本 PR 的處理 |
|---|---|---|
| 強制代理清單 | `Config.MustProxy() = OnlyProxy \|\| NoLinkURL`，實際為 WeiYun、SFTP、FTP、SMB、Crypt、Virtual、Strm、Mega、ProtonDrive、Chunk、GoogleDrive、GooglePhoto、QuarkOpen、UC、ChaoXing（`local` 不在本 PR 的下載鏈路內；`bunny_storage` 是運行時條件） | 按此重寫 `DRIVER_FORCE_PROXY`；刪掉誤標的 123Pan / BaiduNetdisk / 115Open / 189Cloud，補上缺失的 GoogleDrive / GooglePhoto / QuarkOpen / QuarkUC / ChaoXing / Chunk |
| 驅動能力的兩份真相 | 能力聲明只在各驅動 `meta.go`，`op/driver.go` 據此生成表單 | `admin.ts` 的 `buildProxyFields()` 改為按驅動名從 `internal/driver/proxy.ts` 派生（22 處調用點不再傳 `only_proxy/prefer` 布爾值），並刪除 `registerDriverProxyCapability()` 這類重複登記入口 |
| `PreferProxy` 的用途 | 只用於**表單默認值**（`op/driver.go`），運行時 `ShouldProxy` 只看 `MustProxy \|\| WebProxy` | `resolveProxyDecision()` 不再在運行時強制 `PreferProxy` 驅動代理，改為「`web_proxy` 未配置時回退到驅動默認值」（`effectiveWebProxy()`），顯式 `web_proxy=false` 會被尊重 |
| `proxy_range` | 透明代理**默認轉發客戶端頭（含 Range）**；`proxy_range` 只是額外啟用驅動的 RangeReader 路徑（`internal/net/serve.go`、`internal/stream/util.go`） | 默認改為**透傳 Range**，`proxy_range=false` 才丟棄；保留 `shouldRetryWithoutRange()` 作為上游拒絕 Range 的兜底 |
| 未實現的 Go 特性 | `proxy_types` / `text_types` 擴展名代理、`/p` 的 403 限制、`proxy_ignore_headers` | **已實現**（見下方「擴展名代理與 /p 准入」），默認值對齊 Go 的 `internal/bootstrap/data/setting.go` |

### 擴展名代理與 /p 准入（對齊 Go 的 proxy_types / text_types / canProxy）

- **`proxy_types`（默認 `m3u8,url`）**：命中的擴展名一律由服務端代理——`.m3u8` / `.url`
  內部含相對引用，只有經本服務轉發才能被正確解析。作用於 `/d`、`/sd` 與 `/p`
  （即 Go `ShouldProxy` 的第三條）。
- **`text_types`（默認值取 Go 與 TSWorker 既有默認的並集）**：`/p` 端點用它放行文本類
  預覽（README、歌詞 `.lrc`、字幕 `.srt` / `.ass` / `.vtt`、彈幕等），即使儲存沒有開啟
  `web_proxy`。歷史默認值會由 `LEGACY_SETTING_MIGRATIONS` 自動遷移，避免升級後字幕/歌詞
  預覽被 403。
- **`/p` 准入檢查（Go `canProxy`）**：命中
  `MustProxy || web_proxy || webdav_policy=use_proxy_url || proxy_types || text_types`
  才放行，否則 **403 `proxy not allowed`**。`/d`、`/sd` 不做該限制（Go 裡它們走
  `ShouldProxy`）。WebDAV 協議端點（`/dav/*`）的 GET/HEAD 會按同一判據選擇
  `/api/p` 或 `/api/d`，避免 WebDAV 客戶端拿到 403。
- **`proxy_ignore_headers`（默認 `authorization,referer`）**：作用於本服務轉發給上游的
  **客戶端頭**（Range、兜底 User-Agent）；驅動自己聲明的頭不受影響——與 Go 的
  `ProcessHeader` 一致（先過濾客戶端頭，再套驅動 override）。注意 TS 只轉發這幾個必要
  的頭，不會像 Go 那樣把客戶端全部請求頭轉發給上游（避免 Cookie/Authorization 洩漏給
  第三方上游）。
- **`bunny_storage` 的條件能力**：對齊 Go `drivers/bunny_storage/driver.go` 的 `Config()`
  ——配置了 `storage_zone_name` 但未綁定 `cdn_base_url` 時視為 `MustProxy`（此時只有
  Storage API 可讀，瀏覽器直連會 401）；綁定 CDN 後按普通驅動處理。
| 平台載荷上限守衛（本 PR 新增） | Go 無常駐進程內的大小限制（由 nginx 等外部配置負責） | 屬 EdgeOne 等 Serverless 平台的適配層，非照搬 Go；已刪掉其中無 Go 對應、也無實際需求的 `RAW_PROXY_OVERFLOW` 開關 |
