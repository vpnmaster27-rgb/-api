# 維修派工 APP 後端 API

Express API 使用 Supabase PostgreSQL 儲存帳號與共用工單。API 伺服器是唯一資料庫連線端；APK 不直接連 PostgreSQL，也不包含資料庫密碼。

## 啟動

需求：Node.js 20 以上，以及 Supabase PostgreSQL Session pooler 連線字串。

1. 複製 `.env.example` 為 `.env`。
2. 在 Supabase Dashboard 的 **Connect → Session pooler** 複製連線 URI，填入 `.env` 的 `DATABASE_URL`。
3. 執行：

```sh
npm ci
npm start
```

`DATABASE_URL` 是秘密，不要提交 Git、放進 APK 或寫入日誌。正式部署時，請在 Render 服務的環境變數中設定；不要建立 `.env` 檔上傳到 Render。

## 資料表

- `public.users`：帳號、顯示名稱、密碼、群組與主管旗標。
- `public.work_orders`：工單 ID、JSON payload 與更新時間。

目前 Supabase 專案已建立上述資料表並載入既有測試資料。`npm run db:init` 只會建立缺少的結構並啟用 RLS，不會刪除或重建資料。

## API

- `POST /api/register` — 註冊測試帳號
- `POST /api/login` — 登入並回傳使用者資訊
- `GET /api/users` — 取得人員名冊，不回傳密碼
- `GET /api/time` — 取得伺服器時間資訊
- `GET /api/health` — 確認 API 與 PostgreSQL 可連線
- `GET /api/tasks`、`GET /api/tasks/app` — 取得工單
- `PUT /api/tasks/:id` — 更新單筆工單
- `POST /api/tasks/initialize`、`POST /api/tasks/sync` — Web 工單同步

App 表單的 `formData` 不會由 API 保存或回傳。帳號密碼目前仍依測試版相容需求以明文保存，請使用測試專用密碼，不要與其他系統共用。

## 部署

Render Web Service 設定：

- Root Directory：`web/backend`
- Build Command：`npm ci`
- Start Command：`npm start`
- Environment：`NODE_ENV=production`、`DATABASE_URL`、`DB_POOL_SIZE=5`

服務會監聽 Render 注入的 `PORT` 並綁定 `0.0.0.0`。部署後以 `/api/health` 確認連線。

目前 API 尚未加入登入 Token 或逐使用者授權，因此仍屬測試用途；正式對外使用前應加入 API 身分驗證與存取控制，並將明文密碼改成安全雜湊。
