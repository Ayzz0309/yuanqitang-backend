# yuanqitang-backend

## v2.1.3 穩定強化版

這個版本包含完整前端 `index.html`、Render 後端與 Firestore 規則。

### 本版重點

- 客人可一次複選多個服務項目，總時間、金額、師傅排班及床位衝突會一併檢查。
- 移除多出的 40 分鐘項目，並統一預約介面的服務名稱用語。
- 內建 2026 年 10 月紙本班表，支援 `16:30`、`20:30` 等半小時班別。
- 接案、建立預約、打卡、公休日與班表改用 Firestore 交易，降低多裝置同時操作造成的覆蓋或重複資料。
- 倒數到期停在 `00:00` 並只提醒一次；服務仍須由承接人、管理人員或店長確認切單，避免系統自動結帳造成金額錯誤。
- 實際開始、結束與加時會同步床位占用；跨午夜服務與打卡改用時間戳計算。
- 客人預約狀態與可預約時段會即時同步，並避免即時更新清掉尚未送出的手動預約表單。
- LINE Webhook 增加簽章驗證，通知 API 增加限流、輸入限制、逾時與來源限制。

### 店長權限與月報功能

- 界面中的管理者稱號改為「店長」，程式內部角色值仍保留 `boss` 以相容舊資料。
- 新增 `manager` 管理人員角色：可建立、安排、接受、修改與取消預約。
- 一般員工可查看所有待確認預約並截圖詢問，但不能接受、婉拒、指派或修改。
- 已安排案件只由店長、管理人員與實際承接員工執行開始、加時與切單。
- 報表支援按月份切換，歷史預約保留在 Firestore，可隨時回看各月營收、案件與員工業績。
- 報表、員工權限、班表編輯與系統設定仍只有店長可修改。
- 店長可在「員工」頁將帳號設為管理人員，操作時使用現有 `BOSS_RECOVERY_CODE` 確認，無需新增環境變數。
- 店長可在每個員工帳號旁指定刪除單一帳號，不再從畫面一次刪除全部員工；店長帳號永遠不能刪除。
- 刪除員工只移除登入帳號，已有預約、報表、班表與打卡歷史保留，原班表身分可重新註冊。

### Render 環境變數

- `EMPLOYEE_REGISTRATION_CODE`：店內員工註冊碼。
- `BOSS_RECOVERY_CODE`：店長帳號救援與員工權限管理碼，必須與員工註冊碼不同且不可提供給員工。
- `FIREBASE_SERVICE_ACCOUNT_JSON`：Firebase 服務帳戶 JSON 的完整內容。
- `LINE_CHANNEL_ACCESS_TOKEN`：LINE Messaging API Channel Access Token。
- `LINE_CHANNEL_SECRET`：LINE Messaging API Channel Secret；Webhook 驗章必填。
- `STAFF_GROUP_ID`：員工通知群組 ID。
- `CUSTOMER_GROUP_ID`：客人通知群組 ID。
- `ALLOWED_ORIGINS`：允許呼叫後端的網站來源，多個來源用逗號分隔。預設為 `https://ayzz0309.github.io`。
- `LOG_LINE_SOURCE_IDS`：只有在取得 LINE 群組 ID 時暫時設成 `true`，完成後請改回 `false` 或刪除。

## v2.1.3 員工權限修正

- 員工註冊時必須選擇對應班表身分，同一身分不可重複綁定。
- 一般員工可看所有待確認預約，但只會看到自己的已接預約與今日案件。
- 一般員工只能替自己打卡，且不會看到手動預約功能。
- 管理人員可管理預約；報表、客人名單、LINE 紀錄、員工管理、公休與班表修改僅限店長。
- 店長可在報表的完成紀錄中修正實收金額。
- Firestore 過渡規則禁止員工帳號自行更改 `role` 或帳號 ID。
- 忘記店長帳號或密碼時，可透過獨立 `BOSS_RECOVERY_CODE` 重設並取回帳號 ID。

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
