# Render 部署 API

## Render Web Service

- Root Directory：`web/backend`
- Runtime：Node
- Build Command：`npm ci`
- Start Command：`npm start`
- Health Check Path：`/api/health`

設定環境變數：

| Key | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Supabase Dashboard > Connect > Session pooler 顯示的完整 URI |
| `DB_POOL_SIZE` | `5` |
| `APP_COMPLETED_TASK_RETENTION_HOURS` | `0`（維持預設行為） |

連線 URI 只應放在 Render Environment Variables，不可提交至 Git、APK 或日誌。資料庫密碼如包含 URI 保留字，請使用 Supabase 顯示的完整 URI，不要自行拼接或修改。API 會強制使用 TLS 加密連線。

部署完成後開啟 `https://<Render 服務網址>/api/health`，期望看到 `status: ok` 和資料庫連線資訊。再把 Render 的 HTTPS 服務網址設為 App 的 API base URL，重新打包 APK 才能讓現場人員安裝連線。

## 注意事項

- API 使用 PostgreSQL 參數化查詢，Render 不需要 Access ODBC，也不需要 `.accdb` 檔案。
- Supabase 的 `users`、`work_orders` 不開放給 APK 直接存取；Render API 使用伺服器端 `DATABASE_URL` 連線。
- API 現階段沒有登入 Token 或逐使用者授權，僅適合受控測試。
- Render 免費 Web Service 閒置後可能休眠，喚醒時第一個請求會較慢。
