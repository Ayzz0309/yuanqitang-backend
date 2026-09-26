# yuanqitang-backend

## v2.1.1 員工註冊碼設定

Render 環境變數：

- `EMPLOYEE_REGISTRATION_CODE`：店內員工註冊碼
- `FIREBASE_SERVICE_ACCOUNT_JSON`：Firebase 服務帳戶 JSON 的完整內容

部署後，請在 Firebase Console 發布本專案的 `firestore.rules`。這會禁止瀏覽器直接建立員工文件，員工註冊只能經由後端驗證註冊碼。
