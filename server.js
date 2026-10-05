const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://ayzz0309.github.io')
  .split(',')
  .map(value => value.trim().replace(/\/$/, ''))
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || origin === 'null' || allowedOrigins.includes(origin.replace(/\/$/, ''))) {
      return callback(null, true);
    }
    const error = new Error('CORS_ORIGIN_DENIED');
    error.status = 403;
    return callback(error);
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'X-Line-Signature'],
  maxAge: 86400
}));
app.use(express.json({
  limit: '32kb',
  verify(req, res, buffer) {
    req.rawBody = Buffer.from(buffer);
  }
}));

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LINE_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const STAFF_GROUP_ID = process.env.STAFF_GROUP_ID || '';
const CUSTOMER_GROUP_ID = process.env.CUSTOMER_GROUP_ID || '';
const EMPLOYEE_REGISTRATION_CODE = process.env.EMPLOYEE_REGISTRATION_CODE || '';
const LOG_LINE_SOURCE_IDS = process.env.LOG_LINE_SOURCE_IDS === 'true';

let firestore = null;
try {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (serviceAccountJson) {
    initializeApp({ credential: cert(JSON.parse(serviceAccountJson)) });
    firestore = getFirestore();
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

const notificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '通知請求過於頻繁，請稍後再試' }
});

function safeCodeEqual(input, expected) {
  const left = Buffer.from(String(input || ''), 'utf8');
  const right = Buffer.from(String(expected || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function cleanString(value, maxLength) {
  return String(value || '').replace(/[<>\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);
}

function normalizeNotice(body = {}) {
  const price = Number(body.price);
  const notice = {
    name: cleanString(body.name, 80),
    phone: cleanString(body.phone, 30),
    svc: cleanString(body.svc, 300),
    dur: cleanString(body.dur, 40),
    date: cleanString(body.date, 30),
    time: cleanString(body.time, 20),
    note: cleanString(body.note, 500),
    empId: cleanString(body.empId, 50),
    empName: cleanString(body.empName, 80),
    price: Number.isFinite(price) && price >= 0 && price <= 1000000 ? Math.round(price) : null
  };
  if (!notice.name || !notice.svc || !notice.date || !notice.time || notice.price === null) {
    const error = new Error('INVALID_NOTICE');
    error.status = 400;
    throw error;
  }
  return notice;
}

function validLineSignature(req) {
  if (!LINE_SECRET || !req.rawBody) return false;
  const received = String(req.get('x-line-signature') || '');
  const expected = crypto.createHmac('sha256', LINE_SECRET).update(req.rawBody).digest('base64');
  const left = Buffer.from(received, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// ── 發送 LINE 訊息 ──
async function sendLineMsg(to, text) {
  if (!LINE_TOKEN || !to) return { sent: false, reason: 'not-configured' };
  try {
    await axios.post('https://api.line.me/v2/bot/message/push', {
      to,
      messages: [{ type: 'text', text }]
    }, {
      headers: {
        'Authorization': `Bearer ${LINE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    return { sent: true };
  } catch (e) {
    console.error('LINE 發送失敗:', e.response?.data || e.message);
    throw e;
  }
}

// ── 健康檢查 ──
app.get('/', (req, res) => res.json({ status: 'ok', service: '元氣堂預約系統後端', version: '2.1.3' }));

// ── 員工註冊（註冊碼只存在 Render 環境變數）──
app.post('/api/register/employee', registrationLimiter, async (req, res) => {
  if (!firestore || !EMPLOYEE_REGISTRATION_CODE) {
    return res.status(503).json({ error: '員工註冊服務尚未完成設定，請聯絡老闆' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const name = cleanString(body.name, 80);
  const id = cleanString(body.id, 50);
  const lineId = cleanString(body.lineId, 80);
  const password = String(body.password || '');
  const registrationCode = String(body.registrationCode || '');

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
        createdAt: FieldValue.serverTimestamp(),
        createdVia: 'registration-code'
      });
    });

    return res.status(201).json({
      ok: true,
      employee: { id, name, role: 'staff', lineId, cases: [], clockIn: null, clockOut: null, clockLog: [] }
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
app.post('/api/notify/new-booking', notificationLimiter, async (req, res) => {
  let notice;
  try {
    notice = normalizeNotice(req.body);
  } catch (error) {
    return res.status(error.status || 400).json({ error: '通知資料格式不完整或超出限制' });
  }
  const { name, phone, svc, dur, date, time, price, note } = notice;
  const sentAt = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei' });

  const staffMsg = `【元氣堂】新預約通知 ${sentAt} 📋
━━━━━━━━━━━━━
客人：${name}
電話：${phone}
服務項目：${svc} ${dur}
日期：${date} ${time}
費用：NT$${price}
${note ? '備註：' + note : ''}
━━━━━━━━━━━━━
請登入系統接案 👆`;

  const custMsg = `【元氣堂】預約成功！✅
━━━━━━━━━━━━━
服務項目：${svc} ${dur}
日期：${date} ${time}
費用：NT$${price}
━━━━━━━━━━━━━
我們會盡快確認，敬請稍候
如需修改請來電：0987-450-468`;

  try {
    const results = await Promise.all([
      sendLineMsg(STAFF_GROUP_ID, staffMsg),
      sendLineMsg(CUSTOMER_GROUP_ID, custMsg)
    ]);
    return res.json({ ok: true, sent: results.filter(result => result.sent).length });
  } catch (error) {
    return res.status(502).json({ error: 'LINE 通知傳送失敗，預約資料不受影響' });
  }
});

// ── 員工接案通知 ──
app.post('/api/notify/accepted', notificationLimiter, async (req, res) => {
  let notice;
  try {
    notice = normalizeNotice(req.body);
    if (!notice.empId || !notice.empName) throw Object.assign(new Error('INVALID_EMPLOYEE'), { status: 400 });
  } catch (error) {
    return res.status(error.status || 400).json({ error: '通知資料格式不完整或超出限制' });
  }
  const { empId, empName, name, phone, svc, dur, date, time, price } = notice;
  const sentAt = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei' });

  const staffMsg = `【元氣堂後台】接案確認 ${sentAt} ✅
━━━━━━━━━━━━━
員工：${empName}（${empId}）已接案
客人：${name} ／ ${phone}
服務項目：${svc} ${dur}
日期：${date} ${time}
費用：NT$${price}
━━━━━━━━━━━━━`;

  const custMsg = `【元氣堂】您的預約已確認 🎉
━━━━━━━━━━━━━
服務項目：${svc} ${dur}
日期：${date} ${time}
費用：NT$${price}
接待師傅：${empName}
━━━━━━━━━━━━━
請準時到場，期待為您服務！
如有疑問：0987-450-468`;

  try {
    const results = await Promise.all([
      sendLineMsg(STAFF_GROUP_ID, staffMsg),
      sendLineMsg(CUSTOMER_GROUP_ID, custMsg)
    ]);
    return res.json({ ok: true, sent: results.filter(result => result.sent).length });
  } catch (error) {
    return res.status(502).json({ error: 'LINE 通知傳送失敗，接案資料不受影響' });
  }
});

// ── LINE Webhook（拿 Group ID 用）──
app.post('/webhook', (req, res) => {
  if (!LINE_SECRET) return res.status(503).json({ error: 'LINE_CHANNEL_SECRET 尚未設定' });
  if (!validLineSignature(req)) return res.status(401).json({ error: 'LINE 簽章驗證失敗' });
  res.sendStatus(200);
  const events = req.body && Array.isArray(req.body.events) ? req.body.events : [];
  events.forEach(event => {
    const src = event && event.source ? event.source : {};
    if (src.type === 'group') {
      console.log(LOG_LINE_SOURCE_IDS ? `GROUP ID: ${src.groupId}` : `收到群組事件（ID 尾碼：${String(src.groupId || '').slice(-6)}）`);
    }
    if (src.type === 'room') {
      console.log(LOG_LINE_SOURCE_IDS ? `ROOM ID: ${src.roomId}` : `收到聊天室事件（ID 尾碼：${String(src.roomId || '').slice(-6)}）`);
    }
  });
});

// ── 查詢 Group ID（給老闆用）──
app.get('/api/check-groups', (req, res) => {
  res.json({
    staffGroupConfigured: !!STAFF_GROUP_ID,
    customerGroupConfigured: !!CUSTOMER_GROUP_ID,
    tokenSet: !!LINE_TOKEN
  });
});

app.use((error, req, res, next) => {
  if (error && error.message === 'CORS_ORIGIN_DENIED') {
    return res.status(403).json({ error: '此網站來源未獲允許' });
  }
  if (error && error.type === 'entity.too.large') {
    return res.status(413).json({ error: '請求內容過大' });
  }
  console.error('未處理的伺服器錯誤:', error && error.message ? error.message : error);
  return res.status(500).json({ error: '伺服器暫時無法處理請求' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`元氣堂後端啟動 port ${PORT}`));
