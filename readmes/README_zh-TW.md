<div align="center">
  <img src="https://raw.githubusercontent.com/OpenListTeam/Logo/main/logo.svg" width="128" height="128" alt="logo" />

  <p><em>OpenList 是一個多功能的目錄列表工具，支援數十種網盤文件掛載和文件預覽/下載/分享等功能</em></p>
  <p>本倉庫是官方 <a href="https://github.com/OpenListTeam/OpenList">OpenListTeam/OpenList</a> 專案的 TypeScript + Serverless 架構移植版</p>
  <p>基於 Cloudflare Workers / EdgeOne Cloud Function / Alibaba Cloud ESA 運行</p>

<a href="https://github.com/OpenListTeam/OpenList-Worker/blob/main/LICENSE"><img src="https://img.shields.io/github/license/OpenListTeam/OpenList-Worker" alt="License" /></a>
<a href="https://github.com/OpenListTeam/OpenList-Worker/actions/workflows/build-verify.yml"><img src="https://img.shields.io/github/actions/workflow/status/OpenListTeam/OpenList-Worker/build-verify.yml?branch=main" alt="Build status" /></a>
<a href="https://github.com/OpenListTeam/OpenList-Worker/releases"><img src="https://img.shields.io/github/release/OpenListTeam/OpenList-Worker" alt="latest version" /></a>
<a href="https://github.com/OpenListTeam/OpenList-Worker/discussions"><img src="https://img.shields.io/github/discussions/OpenListTeam/OpenList-Worker?color=%23ED8936" alt="discussions" /></a>
<a href="https://github.com/OpenListTeam/OpenList-Worker/releases"><img src="https://img.shields.io/github/downloads/OpenListTeam/OpenList-Worker/total?color=%239F7AEA&logo=github" alt="Downloads" /></a>

</div>

<div align="center">

[English](readmes/README_en.md) | 正體中文 | [日本語](readmes/README_ja.md) | [한국어](readmes/README_ko.md)

[上游專案](https://github.com/OpenListTeam/OpenList) · [貢獻指南](https://github.com/OpenListTeam/OpenList-Worker/blob/main/CONTRIBUTING.md) · [許可證](./LICENSE)

</div>

---

## 部署指南

### 前置要求

- Node.js 18+（推薦使用 pnpm）
- Cloudflare 帳號
- 基礎 Git 操作知識

---

## 部署方案選擇

### 方案比較表

| 方案 | 儲存類型 | 適用場景 | 免費額度 |
| :--- | :--- | :--- | :--- |
| **D1 (推薦)** | 關係型資料庫 (SQLite) | 中大型部署、需要 SQL 查詢 | 每日 100 萬次讀取 |
| **KV** | 鍵值對儲存 | 小型部署、簡單查詢 | 每日 10 萬次讀取 |
| **cfkv** | KV REST API | 無 binding 限制 | 按 API 調用計費 |

---

## 方案 A：D1 部署（推薦）

### 步驟 1：建立 D1 資料庫

1. 登入 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 左側選單選擇 **Workers & Pages** → **D1**
3. 點擊 **Create database**
4. 輸入資料庫名稱（建議：`openlist-db`）
5. 點擊 **Create**

### 步驟 2：綁定資料庫

1. 在 D1 資料庫頁面，找到 **Database ID**（格式：`xxxxx-xxxxx-xxxxx-xxxxx`）
2. 複製該 ID

### 步驟 3：編輯 wrangler.jsonc

```json
{
  "name": "openlist-tsworker",
  "main": "dist/worker.js",
  "compatibility_date": "2024-01-01",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "openlist-db",
      "database_id": "你的 D1 資料庫 ID"
    }
  ]
}
```

### 步驟 4：配置環境變數

在 Cloudflare Dashboard 的 Worker 設定頁面：

```
DB_FORMAT=sql
DB_DRIVER=d1
JWT_SECRET=隨機生成 32 位字元
```

### 步驟 5：部署

```bash
# 初始化並部署
pnpm run deploy
```

---

## 方案 B：KV 部署

### 步驟 1：建立 KV 命名空間

1. 登入 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 左側選單選擇 **Workers & Pages** → **KV**
3. 點擊 **Create namespace**
4. 輸入名稱（建議：`openlist-kv`）

### 步驟 2：編輯 wrangler.jsonc

```json
{
  "name": "openlist-tsworker",
  "main": "dist/worker.js",
  "compatibility_date": "2024-01-01",
  "kv_namespaces": [
    {
      "binding": "KV",
      "id": "你的 KV ID"
    }
  ]
}
```

> ⚠️ 注意：KV binding 名**必須是 `KV`**，否則會報錯

### 步驟 3：配置環境變數

```
DB_FORMAT=map
DB_DRIVER=kv
JWT_SECRET=隨機生成 32 位字元
```

### 步驟 4：部署

```bash
pnpm run deploy
```

---

## KV vs D1 詳細差異

### 資料格式

| | KV | D1 |
| :--- | :--- | :--- |
| **格式** | 鍵值對（整物件 JSON 或分 key） | 關係表（SQL） |
| **DB_FORMAT** | `map` 或 `key` | `sql` |
| **查詢能力** | 僅能按 key 查詢 | 支援 SQL 查詢 |

### 免費額度比較

| | KV | D1 |
| :--- | :--- | :--- |
| **每日讀取** | 10 萬次 | 100 萬次 |
| **每日寫入** | 1000 次 | 10 萬次 |
| **儲存限制** | 1 GB | 5 GB |

### 建議使用時機

| 場景 | 推薦方案 | 理由 |
| :--- | :--- | :--- |
| 初次部署測試 | KV | 設定簡單 |
| 中大型部署 | D1 | 查詢能力強、額度大 |
| 需要複雜查詢 | D1 | 支援 SQL |
| 預算有限 | D1 | 免費額度更大 |

---

## 驗證部署

### 檢查 Worker 運行

訪問你的 Worker URL，應看到：

- 首頁正常顯示
- `/health` 返回 `OK`
- `/api/public/env_check` 返回環境資訊

### 常見錯誤

| 錯誤訊息 | 原因 | 解決方案 |
| :--- | :--- | :--- |
| `DB_DRIVER不可用` | 未正確綁定資料庫 | 檢查 wrangler.jsonc 設定 |
| `KV binding not found` | KV binding 名不是 `KV` | 改為 `KV` |
| `SQL table not found` | D1 表未初始化 | 重新執行 `pnpm run deploy` |

---

## 功能簡介

OpenList 是一個運行於邊緣運算平台的多儲存聚合文件列表與管理系統，可將分散在不同網盤、物件儲存與協定服務中的文件統一到一個介面，進行瀏覽、預覽、下載與管理。

### 儲存聚合（78 個驅動）

- **國內網盤**：阿里雲盤、夸克網盤、百度網盤、115 網盤、123 雲盤、天翼雲盤、139 雲盤等
- **國際網盤**：Google Drive、OneDrive、Dropbox、MEGA、MediaFire、Proton Drive 等
- **物件儲存**：S3 相容（AWS/OSS/COS/MinIO）、Azure Blob、WebDAV、FTP 等
- **其他**：GitHub Releases、OpenList 分享、AList V3、Cloudreve、Kodbox 等

### 核心能力

- **文件瀏覽**：統一目錄樹，支援圖片、影片、音訊、文檔線上預覽
- **上傳下載**：跨儲存上傳、批次下載、串流傳輸
- **文件分享**：生成帶有效期、密碼、權限控制的分享連結
- **全文搜尋**：在已索引儲存中快速檢索文件
- **MCP 服務**：提供 AI 助手集成端點

---

## 技術架構

| 層級 | 技術 |
| :--- | :--- |
| **後端** | Cloudflare Workers + Hono.js + TypeScript |
| **資料庫** | D1 (SQLite) / KV / MySQL / MariaDB / PostgreSQL |
| **前端** | React 19 + TypeScript + Vite |
| **UI 庫** | Ant Design / Material-UI |

---

## 協助支援

- 🐛 **提交 Bug 或功能請求**：請前往 [_Issues_](https://github.com/OpenListTeam/OpenList-Worker/issues)
- 💬 **一般性問題與交流**：請前往 [_Discussions_](https://github.com/OpenListTeam/OpenList/discussions)

## 開源授權

`OpenList` 是基於 [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.txt) 授權的開源軟體。

## 聯絡我們

🌐 [@GitHub](https://github.com/OpenListTeam) · ✈️ [Telegram 交流群](https://t.me/OpenListTeam)

## 貢獻列表

感謝以下專案及其貢獻者：

- [Alist](https://github.com/AlistGo/alist)
- [OpenList](https://github.com/OpenListTeam/OpenList)（Go 版）
- 本專案全體貢獻者：[![Contributors](https://contrib.rocks/image?repo=OpenListTeam/OpenList-Worker)](https://github.com/OpenListTeam/OpenList-Worker/graphs/contributors)
