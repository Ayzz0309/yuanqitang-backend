# yuanqitang-backend

## v2.1.3 穩定強化版

這個版本包含完整前端 `index.html`、Render 後端與 Firestore 規則。

### 本版重點

- 客人可一次複選多個服務項目，總時間、金額、師傅排班及床位衝突會一併檢查。
- 移除多出的 40 分鐘項目，並統一預約介面的服務名稱用語。
- 內建 2026 年 10 月紙本班表，支援 `16:30`、`20:30` 等半小時班別。
- 接案、建立預約、打卡、公休日與班表改用 Firestore 交易，降低多裝置同時操作造成的覆蓋或重複資料。
- 倒數到期停在 `00:00` 並只提醒一次；服務仍須由承接人或老闆確認切單，避免系統自動結帳造成金額錯誤。
- 實際開始、結束與加時會同步床位占用；跨午夜服務與打卡改用時間戳計算。
- 客人預約狀態與可預約時段會即時同步，並避免即時更新清掉尚未送出的手動預約表單。
- LINE Webhook 增加簽章驗證，通知 API 增加限流、輸入限制、逾時與來源限制。

### Render 環境變數

- `EMPLOYEE_REGISTRATION_CODE`：店內員工註冊碼。
- `FIREBASE_SERVICE_ACCOUNT_JSON`：Firebase 服務帳戶 JSON 的完整內容。
- `LINE_CHANNEL_ACCESS_TOKEN`：LINE Messaging API Channel Access Token。
- `LINE_CHANNEL_SECRET`：LINE Messaging API Channel Secret；Webhook 驗章必填。
- `STAFF_GROUP_ID`：員工通知群組 ID。
- `CUSTOMER_GROUP_ID`：客人通知群組 ID。
- `ALLOWED_ORIGINS`：允許呼叫後端的網站來源，多個來源用逗號分隔。預設為 `https://ayzz0309.github.io`。
- `LOG_LINE_SOURCE_IDS`：只有在取得 LINE 群組 ID 時暫時設成 `true`，完成後請改回 `false` 或刪除。

### 要上傳的完整檔案

- `index.html`
- `server.js`
- `package.json`
- `package-lock.json`
- `firestore.rules`
- `README.md`

部署後，請在 Firebase Console 檢查並發布本專案的 `firestore.rules`，並在 Render 重新部署後端。

### 尚未自動變更的安全架構

目前既有帳號仍使用舊版欄位登入，部分 Firestore 集合也仍需讓前端直接讀寫。全面改成 Firebase Authentication 需要搬移既有帳號與重新設計權限，這次未自動處理，以免造成現有客人及員工無法登入。正式長期使用前，建議另開版本完成 Firebase Auth 與最小權限規則遷移。
