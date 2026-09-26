const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LINE_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const STAFF_GROUP_ID = process.env.STAFF_GROUP_ID || '';
const CUSTOMER_GROUP_ID = process.env.CUSTOMER_GROUP_ID || '';
const EMPLOYEE_REGISTRATION_CODE = process.env.EMPLOYEE_REGISTRATION_CODE || '';

let firestore = null;
try {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (serviceAccountJson) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(serviceAccountJson)) });
    firestore = admin.firestore();
    console.log('Firebase Admin 已連線');
  } else {
    console.warn('尚未設定 FIREBASE_SERVICE_ACCOUNT_JSON，員工註冊 API 將停用');
  }
} catch (error) {
  console.error('Firebase Admin 初始化失敗:', error.message);
}

const registrationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '嘗試次數過多，請 15 分鐘後再試' }
});

function safeCodeEqual(input, expected) {
  const left = Buffer.from(String(input || ''), 'utf8');
  const right = Buffer.from(String(expected || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function cleanString(value, maxLength) {
  return String(value || '').replace(/[<>\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);
}

// ── 發送 LINE 訊息 ──
async function sendLineMsg(to, text) {
  if (!LINE_TOKEN || !to) return;
  try {
    await axios.post('https://api.line.me/v2/bot/message/push', {
      to,
      messages: [{ type: 'text', text }]
    }, {
      headers: {
        'Authorization': `Bearer ${LINE_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (e) {
    console.error('LINE 發送失敗:', e.response?.data || e.message);
  }
}

// ── 健康檢查 ──
app.get('/', (req, res) => res.json({ status: 'ok', service: '元氣堂預約系統後端' }));

// ── 員工註冊（註冊碼只存在 Render 環境變數）──
app.post('/api/register/employee', registrationLimiter, async (req, res) => {
  if (!firestore || !EMPLOYEE_REGISTRATION_CODE) {
    return res.status(503).json({ error: '員工註冊服務尚未完成設定，請聯絡老闆' });
  }

  const name = cleanString(req.body.name, 80);
  const id = cleanString(req.body.id, 50);
  const lineId = cleanString(req.body.lineId, 80);
  const password = String(req.body.password || '');
  const registrationCode = String(req.body.registrationCode || '');

  if (!name || !id || !password || !registrationCode) {
    return res.status(400).json({ error: '請填寫完整資料與員工註冊碼' });
  }
  if (!/^[A-Za-z0-9_-]{3,50}$/.test(id)) {
    return res.status(400).json({ error: '員工帳號限 3–50 位英文字母、數字、底線或連字號' });
  }
  if (password.length < 6 || password.length > 128) {
    return res.status(400).json({ error: '密碼長度需為 6–128 位' });
  }
  if (!safeCodeEqual(registrationCode, EMPLOYEE_REGISTRATION_CODE)) {
    return res.status(403).json({ error: '員工註冊碼錯誤' });
  }

  try {
    const ref = firestore.collection('employees').doc(id);
    await firestore.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (snapshot.exists) {
        const error = new Error('EMPLOYEE_EXISTS');
        error.code = 'employee-exists';
        throw error;
      }
      transaction.create(ref, {
        id,
        name,
        pw: password,
        role: 'staff',
        lineId,
        cases: [],
        clockIn: null,
        clockOut: null,
        clockLog: [],
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdVia: 'registration-code'
      });
    });

    return res.status(201).json({
      ok: true,
      employee: { id, name, pw: password, role: 'staff', lineId, cases: [], clockIn: null, clockOut: null, clockLog: [] }
    });
  } catch (error) {
    if (error.code === 'employee-exists') {
      return res.status(409).json({ error: '此員工帳號已被使用' });
    }
    console.error('員工註冊失敗:', error.message);
    return res.status(500).json({ error: '員工帳號建立失敗，請稍後再試' });
  }
});

// ── 客人預約通知 ──
app.post('/api/notify/new-booking', async (req, res) => {
  const { name, phone, svc, dur, date, time, price, note } = req.body;
  const now = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });

  const staffMsg = `【元氣堂】新預約通知 ${now} 📋
━━━━━━━━━━━━━
客人：${name}
電話：${phone}
療程：${svc} ${dur}
日期：${date} ${time}
費用：NT$${price}
${note ? '備註：' + note : ''}
━━━━━━━━━━━━━
請登入系統接案 👆`;

  const custMsg = `【元氣堂】預約成功！✅
━━━━━━━━━━━━━
療程：${svc} ${dur}
日期：${date} ${time}
費用：NT$${price}
━━━━━━━━━━━━━
我們會盡快確認，敬請稍候
如需修改請來電：0987-450-468`;

  await Promise.all([
    sendLineMsg(STAFF_GROUP_ID, staffMsg),
    sendLineMsg(CUSTOMER_GROUP_ID, custMsg)
  ]);

  res.json({ ok: true });
});

// ── 員工接案通知 ──
app.post('/api/notify/accepted', async (req, res) => {
  const { empId, empName, name, phone, svc, dur, date, time, price, note } = req.body;
  const now = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });

  const staffMsg = `【元氣堂後台】接案確認 ${now} ✅
━━━━━━━━━━━━━
員工：${empName}（${empId}）已接案
客人：${name} ／ ${phone}
療程：${svc} ${dur}
日期：${date} ${time}
費用：NT$${price}
━━━━━━━━━━━━━`;

  const custMsg = `【元氣堂】您的預約已確認 🎉
━━━━━━━━━━━━━
療程：${svc} ${dur}
日期：${date} ${time}
費用：NT$${price}
接待師傅：${empName}
━━━━━━━━━━━━━
請準時到場，期待為您服務！
如有疑問：0987-450-468`;

  await Promise.all([
    sendLineMsg(STAFF_GROUP_ID, staffMsg),
    sendLineMsg(CUSTOMER_GROUP_ID, custMsg)
  ]);

  res.json({ ok: true });
});

// ── LINE Webhook（拿 Group ID 用）──
app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  const events = req.body.events || [];
  events.forEach(event => {
    const src = event.source;
    if (src.type === 'group') {
      console.log('GROUP ID:', src.groupId);
    }
    if (src.type === 'room') {
      console.log('ROOM ID:', src.roomId);
    }
  });
});

// ── 查詢 Group ID（給老闆用）──
app.get('/api/check-groups', (req, res) => {
  res.json({
    staffGroupId: STAFF_GROUP_ID || '尚未設定',
    customerGroupId: CUSTOMER_GROUP_ID || '尚未設定',
    tokenSet: !!LINE_TOKEN
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`元氣堂後端啟動 port ${PORT}`));
