# 貢獻指南 (Contributing Guide)

感謝你對 **OpenList** 的關注與支持！🎉

OpenList 是一個基於 **SolidJS** + **Hono** + **TypeScript** 的現代化全棧文件列表與網盤管理系統。我們歡迎任何形式的貢獻，包括但不限於報告 Bug、提出新功能建議、改進文件、參與國際化翻譯以及提交代碼。

---

## 目錄

- [貢獻方式](#-貢獻方式)
- [本地開發環境](#-本地開發環境)
  - [環境要求](#環境要求)
  - [快速起步](#快速起步)
  - [常用腳本](#常用腳本)
- [核心架構與開發規範](#-核心架構與開發規範)
  - [全棧 Web 標準優先與邊緣相容（重要）](#全棧-web-標準優先與邊緣相容重要)
  - [添加新的儲存驅動 (Storage Driver)](#添加新的儲存驅動-storage-driver)
  - [前端開發規範 (SolidJS)](#前端開發規範-solidjs)
  - [國際化翻譯 (i18n)](#國際化翻譯-i18n)
- [Git 提交規範 (Commit Convention)](#-git-提交規範-commit-convention)
- [Pull Request (PR) 流程](#-pull-request-pr-流程)
  - [PR 準備與自檢清單](#pr-準備與自檢清單)
  - [AI 輔助使用聲明 (AI Disclosure)](#ai-輔助使用聲明-ai-disclosure)
- [行為準則與開源許可證](#-行為準則與開源許可證)

---

## 💡 貢獻方式

### 1. 報告 Bug

如果您在使用過程中發現了 Bug，請通過 [GitHub Issues](https://github.com/OpenListTeam/OpenList/issues) 提交：

- 檢查是否已有相同或相似的 Issue。
- 詳細描述問題發生的場景、復現步驟、預期行為與實際表現。
- 提供運行環境信息（部署方式如 Node.js 容器 / Cloudflare Workers / Vercel、Node 版本、瀏覽器版本等）。
- 附上相關的控制檯日誌或錯誤堆棧截圖/文本。

### 2. 提出功能建議 (Feature Requests)

我們樂於聽取各種創新的點子！提交功能建議前：

- 清晰闡述該功能的使用場景與價值。
- 簡述預期的交互方式或技術實現構想。

### 3. 參與國際化翻譯 (i18n)

項目使用 Crowdin 管理多語言翻譯：

- 可通過運行 `pnpm run crowdin:download` 同步最新文案。
- 也歡迎在 [Crowdin 項目頁面](https://oplist.org/) 或通過 PR 完善語言包。

### 4. 提交代碼 (Code Contributions)

無論是修復 Bug、重構代碼、新增網盤驅動還是優化 UI，我們都熱烈歡迎！請參考下文的開發與提交規範。

---

## 🛠️ 本地開發環境

### 環境要求

- **Node.js**：`>= 18.0.0`（推薦 `22.x`）
- **包管理器**：推薦使用 **`pnpm`**（`>= 9.0.0`）

### 快速起步

1. **Fork 並克隆倉庫**：

   ```bash
   git clone https://github.com/<your-username>/OpenList.git
   cd openlist
   ```

2. **安裝依賴**：

   ```bash
   pnpm install
   ```

3. **啟動本地開發伺服器**：

   ```bash
   pnpm run dev
   ```

   開發伺服器將同時啟動 Hono 後端 API 與 Vite 前端服務，默認訪問地址：`http://localhost:3000`。

4. **Cloudflare Workers 邊緣模擬調試（可選）**：
   ```bash
   pnpm run dev:worker
   ```

### 常用腳本

| 命令                  | 說明                                             |
| :-------------------- | :----------------------------------------------- |
| `pnpm run dev`        | 啟動本地全棧開發環境（Vite + Hono）              |
| `pnpm run lint`       | 執行 TypeScript 類型檢查 (`tsc --noEmit`)        |
| `pnpm run format`     | 使用 Prettier 格式化源碼                         |
| `pnpm run build`      | 構建完整生產產物（前端靜態資源 + Edge 後端腳本） |
| `pnpm run build:edge` | 使用 esbuild 單獨打包無伺服器/邊緣後端腳本       |
| `pnpm run test:189`   | 運行 189Cloud 驅動單元測試                       |
| `pnpm run crowdin`    | 上傳並下載 Crowdin 國際化翻譯資源                |
| `pnpm run i18n:build` | 更新並編譯國際化語言包                           |

---

## 🧱 核心架構與開發規範

```
openlist/
├── api/                   # 邊緣 / Serverless 入口 ([...route].ts)
├── src/
│   ├── backend/           # 後端核心 (Hono)
│   │   ├── drivers/       # 各網盤儲存驅動實現
│   │   ├── internal/      # 核心邏輯 (儲存調度/資料庫/操作層)
│   │   └── server/        # API 路由 (fs/auth/admin/share/task/mcp 等)
│   ├── components/        # SolidJS 通用前端組件
│   ├── pages/             # 前端頁面 (瀏覽/管理後台/分享/登入等)
│   ├── store/             # 響應式狀態管理
│   ├── types/             # 共享 TypeScript 類型定義
│   └── utils/             # 前端工具函數
```

### 全棧 Web 標準優先與邊緣相容（重要）

OpenList 的後端設計目標是**跨平台與邊緣原生**（既能在 Node.js 容器運行，也能部署在 Cloudflare Workers、Vercel、AWS Lambda 等邊緣無伺服器環境）：

1. **必須使用標準 Web API**：
   - 使用 `fetch`、`Web Crypto` (`crypto.subtle`)、`ReadableStream`、`Headers`、`Response` 等標準 Web API。
2. **禁止在通用後端直接引入 Node.js 獨佔模塊**：
   - 禁止在 `src/backend/server/` 或通用驅動中靜態引入 `fs`、`path`、`net`、`child_process` 等 Node 原生包。
   - 如需僅限 Node.js 容器的功能（如本地文件系統驅動 `LocalDriver`），必須使用動態導入 `await import(...)` 並做好運行環境檢測隔離。
   - 依賴 Node 原生二進制的驅動（當前為 `sftp` / `ftp`）會在邊緣構建階段被 [`scripts/build-edge.mjs`](../scripts/build-edge.mjs) 的 `emptyNodeDriverPlugin` 替換為空實現（構造時拋錯）。**新增此類驅動時，必須同步把驅動目錄與相關原生包加入該插件的依賴過濾規則**，否則邊緣平台會因缺少 `.node` 文件 loader 而打包失敗。
3. **資料持久化適配**：
   - 核心資料操作通過模型層抽象，支持 **Cloudflare KV**（邊緣環境）與 **JSON 文件**（Node.js 容器環境）無縫適配。

### 添加新的儲存驅動 (Storage Driver)

若需支持新的網盤或對象儲存，請按以下步驟實現：

1. **在 `src/backend/drivers/<driver_name>/` 創建驅動目錄**：
   - `types.ts`：定義該網盤的附加配置項（Addition）與 API 資料結構。
   - `util.ts`：封裝與該網盤開放平台/介面交互的 Client 類。
   - `driver.ts`：實現 `StorageDriver` 介面（定義於 `src/backend/internal/driver/base.ts`）。
2. **實現 `StorageDriver` 介面方法**：
   - `list(virtualPath, physicalPath)`: 獲取目錄文件列表
   - `get(virtualPath, physicalPath)`: 獲取單文件詳情/下載直鏈
   - `mkdir(virtualPath, physicalPath)`: 創建目錄
   - `rename(virtualPath, physicalPath, newName)`: 重命名
   - `remove(virtualPath, physicalPath, names)`: 刪除文件/目錄
   - `move` / `copy` / `put`（按網盤支持能力選擇實現）
3. **註冊驅動**：
   - 在 `src/backend/internal/op/storage.ts` 中引入並註冊驅動實例獲取邏輯。
   - 在 `src/backend/server/admin.ts` 中補充驅動配置項元資料（如需要後台驅動表單支持）。

### 前端開發規範 (SolidJS)

- UI 組件庫使用 `@hope-ui/solid` 與原生 CSS，避免引入冗餘龐大的樣式庫。
- 遵循 SolidJS 細粒度響應式最佳實踐（正確使用 `createSignal`、`createMemo`、`createStore`，避免解構 props 導致丟失響應性）。
- 注意暗色模式 (Dark Mode) 與移動端響應式佈局的適配。

---

## 📌 Git 提交規範 (Commit Convention)

提交信息請遵循 [Conventional Commits](https://www.conventionalcommits.org/) 規範，格式如下：

```
<type>(<scope>): <subject>
```

### 常用 Type 類型

- `feat`: 新增功能特性
- `fix`: 修復 Bug
- `docs`: 文件變動
- `style`: 代碼格式調整（不影響邏輯的空格、分號等）
- `refactor`: 重構代碼（既不修復 bug 也不添加新功能）
- `chore`: 構建過程、輔助工具或依賴項的變動
- `perf`: 性能優化

### 示例

- `feat(driver): add quark drive upload support`
- `fix(fs): resolve range header streaming issue`
- `docs(readme): update deployment instructions`
- `refactor(auth): simplify token verification flow`

---

## 🔀 Pull Request (PR) 流程

1. **創建分支**：從最新的 `main` 分支切出新分支：
   ```bash
   git checkout -b feat/your-feature-name
   ```
2. **編寫代碼與自測**：
   - 編寫優雅、註釋清晰的代碼。
   - 在本地充分測試變更功能及周邊邏輯。
3. **提交前自檢**：

   ```bash
   # 1. 確保無 TypeScript 類型錯誤
   pnpm run lint

   # 2. 格式化代碼
   pnpm run format

   # 3. 確保構建通過
   pnpm run build
   ```

4. **推送到遠程並提交 PR**：
   - 將分支推送到你的 Fork 倉庫並向 `main` 分支發起 PR。
   - 詳細填寫 PR 描述模板（參考項目提供的 [PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md)）。

### PR 準備與自檢清單

- [ ] 代碼已通過 `pnpm run lint` 類型檢查。
- [ ] 代碼已通過 `pnpm run format` 格式化。
- [ ] 已在本地測試通過（包括 Node.js 模式與邊緣環境模式相容性）。
- [ ] PR 標題符合 Conventional Commits 規範（包含必填的 `type(scope)`）。
- [ ] 如涉及破壞性變更或配置調整，已在 PR 摘要中明確說明。

### AI 輔助使用聲明 (AI Disclosure)

OpenList 歡迎開發者合理使用 AI 工具提升開發效率。為了確保代碼庫的合規性與可維護性：

- 若 PR 中包含由 AI（如 ChatGPT、Claude、Copilot、Gemini 等）大量生成的代碼或重構內容，請在 PR 模版中的 **AI Disclosure** 區域予以如實勾選與說明。
- 貢獻者需自行審查並完全理解所提交的 AI 輔助內容，確保代碼質量與安全性。

---

## 📜 行為準則與開源許可證

- **行為準則**：請保持友善、包容與互相尊重的溝通氛圍。對技術實現有不同意見時，歡迎基於事實和規範進行建設性討論。
- **開源許可證**：向本項目提交的所有貢獻均默認遵循項目的 [AGPL-3.0 許可證](LICENSE)。在提交代碼前，請確保你擁有提交該代碼的版權或已取得合規授權。
