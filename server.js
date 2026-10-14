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
const BOSS_RECOVERY_CODE = process.env.BOSS_RECOVERY_CODE || '';
const LOG_LINE_SOURCE_IDS = process.env.LOG_LINE_SOURCE_IDS === 'true';
const THERAPIST_IDENTITIES = Object.freeze({
  T_GUO: '郭老師', T_HON: '洪老師', T031: '31號',
  T026: '26號', T043: '43號', T007: '7號'
});

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

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '店長管理操作過於頻繁，請稍後再試' }
});

const couponLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '優惠券操作過於頻繁，請 15 分鐘後再試' }
});

const DEFAULT_COUPON_CAMPAIGNS = Object.freeze({
  NEW_MEMBER_BOWL90: {
    code: 'NEW_MEMBER_BOWL90',
    name: '頌缽音波課程 9 折體驗券',
    description: '新會員限定；僅限頌缽音波課程，每個手機限領一張，領券後 60 天內使用',
    type: 'percent', value: 10, minSpend: 0, maxDiscount: 0,
    eligibility: 'new_member', serviceScope: 'selected_services',
    applicableServiceIds: [20], applicableServiceNames: ['頌缽音波課程（一對一）'],
    scopeLabel: '指定服務：頌缽音波課程（一對一）',
    validDays: 60, autoIssue: true, active: true
  },
  YUANQI100: {
    code: 'YUANQI100', name: '元氣堂折抵 100 元', description: '消費滿 100 元折抵 100 元',
    type: 'fixed', value: 100, minSpend: 100, maxDiscount: 0, eligibility: 'all'
  },
  NEW200: {
    code: 'NEW200', name: '新客首次預約折抵 200 元', description: '新客首次預約限用一次',
    type: 'fixed', value: 200, minSpend: 200, maxDiscount: 0, eligibility: 'first_booking'
  },
  VIP10: {
    code: 'VIP10', name: '九折優惠', description: '本次消費享 9 折優惠',
    type: 'percent', value: 10, minSpend: 0, maxDiscount: 0, eligibility: 'all'
  }
});

function safeCodeEqual(input, expected) {
  const left = Buffer.from(String(input || ''), 'utf8');
  const right = Buffer.from(String(expected || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function cleanString(value, maxLength) {
  return String(value || '').replace(/[<>\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);
}

function cleanDocumentId(value, maxLength = 100) {
  const id = cleanString(value, maxLength);
  return id && id !== '.' && id !== '..' && !id.includes('/') ? id : '';
}

function cleanCouponCode(value) {
  return cleanString(value, 30).toUpperCase().replace(/\s+/g, '');
}

function normalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('8869') && digits.length === 12) digits = `0${digits.slice(3)}`;
  if (digits.startsWith('9') && digits.length === 9) digits = `0${digits}`;
  return digits;
}

function couponClaimDocumentId(code, phone) {
  const hash = crypto.createHash('sha256').update(`${code}|${phone}`, 'utf8').digest('hex');
  return `${code}_${hash.slice(0, 40)}`;
}

function validDateKey(value) {
  if (value === '') return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function taipeiDateKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function dateKeyAfterDays(days) {
  const value = Math.max(0, Number(days) || 0);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(Date.now() + value * 86400000));
}

function normalizeCampaignInput(body = {}) {
  const code = cleanCouponCode(body.code);
  const name = cleanString(body.name, 80);
  const description = cleanString(body.description || body.name, 160);
  const type = cleanString(body.type, 20);
  const value = Number(body.value);
  const minSpend = Number(body.minSpend || 0);
  const maxDiscount = Number(body.maxDiscount || 0);
  const totalLimit = Number(body.totalLimit || 0);
  const validDays = Number(body.validDays || 0);
  const eligibility = cleanString(body.eligibility || 'all', 30);
  const rawServiceScope = cleanString(body.serviceScope || 'all', 40);
  const serviceScope = rawServiceScope === 'singing_bowl_course' ? 'selected_services' : rawServiceScope;
  const rawServiceIds = rawServiceScope === 'singing_bowl_course' ? [20] : (Array.isArray(body.applicableServiceIds) ? body.applicableServiceIds : []);
  const applicableServiceIds = [...new Set(rawServiceIds.map(Number).filter(id => Number.isInteger(id) && id > 0 && id <= 1000000))].slice(0, 100);
  const rawServiceNames = rawServiceScope === 'singing_bowl_course' ? ['頌缽音波課程（一對一）'] : (Array.isArray(body.applicableServiceNames) ? body.applicableServiceNames : []);
  const applicableServiceNames = [...new Set(rawServiceNames.map(nameValue => cleanString(nameValue, 100)).filter(Boolean))].slice(0, 100);
  const validFrom = cleanString(body.validFrom, 10);
  const validUntil = cleanString(body.validUntil, 10);
  if (!/^[A-Z0-9_-]{3,30}$/.test(code)) throw Object.assign(new Error('COUPON_CODE_INVALID'), { status: 400, publicMessage: '優惠碼限 3–30 位大寫英文、數字、底線或連字號' });
  if (!name) throw Object.assign(new Error('COUPON_NAME_REQUIRED'), { status: 400, publicMessage: '請填寫優惠券名稱' });
  if (!['fixed', 'percent'].includes(type)) throw Object.assign(new Error('COUPON_TYPE_INVALID'), { status: 400, publicMessage: '優惠類型不正確' });
  if (!Number.isInteger(value) || value <= 0 || (type === 'percent' && value > 100) || (type === 'fixed' && value > 1000000)) {
    throw Object.assign(new Error('COUPON_VALUE_INVALID'), { status: 400, publicMessage: type === 'percent' ? '折扣百分比需為 1–100' : '折抵金額需為 1–1000000 的整數' });
  }
  if (!Number.isInteger(minSpend) || minSpend < 0 || minSpend > 1000000) throw Object.assign(new Error('MIN_SPEND_INVALID'), { status: 400, publicMessage: '最低消費金額不正確' });
  if (!Number.isInteger(maxDiscount) || maxDiscount < 0 || maxDiscount > 1000000) throw Object.assign(new Error('MAX_DISCOUNT_INVALID'), { status: 400, publicMessage: '最高折抵金額不正確' });
  if (!Number.isInteger(totalLimit) || totalLimit < 0 || totalLimit > 1000000) throw Object.assign(new Error('TOTAL_LIMIT_INVALID'), { status: 400, publicMessage: '發行上限不正確' });
  if (!Number.isInteger(validDays) || validDays < 0 || validDays > 3650) throw Object.assign(new Error('VALID_DAYS_INVALID'), { status: 400, publicMessage: '領券後有效天數需為 0–3650 天' });
  if (!['all', 'first_booking', 'returning', 'new_member'].includes(eligibility)) throw Object.assign(new Error('ELIGIBILITY_INVALID'), { status: 400, publicMessage: '使用對象不正確' });
  if (!['all', 'selected_services'].includes(serviceScope)) throw Object.assign(new Error('SERVICE_SCOPE_INVALID'), { status: 400, publicMessage: '優惠券適用服務不正確' });
  if (serviceScope === 'selected_services' && applicableServiceIds.length === 0) throw Object.assign(new Error('SERVICE_REQUIRED'), { status: 400, publicMessage: '指定服務優惠券至少要勾選一個適用項目' });
  if (!validDateKey(validFrom) || !validDateKey(validUntil) || (validFrom && validUntil && validFrom > validUntil)) {
    throw Object.assign(new Error('COUPON_DATE_INVALID'), { status: 400, publicMessage: '優惠券有效日期不正確' });
  }
  return {
    code, name, description, type, value, minSpend,
    maxDiscount: type === 'percent' ? maxDiscount : 0,
    totalLimit, perCustomerLimit: 1, eligibility, validFrom, validUntil, validDays,
    serviceScope,
    applicableServiceIds: serviceScope === 'selected_services' ? applicableServiceIds : [],
    applicableServiceNames: serviceScope === 'selected_services' ? applicableServiceNames : [],
    scopeLabel: serviceScope === 'selected_services'
      ? cleanString(`指定服務：${applicableServiceNames.length ? applicableServiceNames.join('、') : `${applicableServiceIds.length} 個項目`}`, 300)
      : '全部服務項目',
    active: body.active !== false
  };
}

function campaignClaimable(campaign) {
  if (!campaign || campaign.active === false) return { ok: false, message: '此優惠券活動已停用' };
  const today = taipeiDateKey();
  if (campaign.validFrom && today < campaign.validFrom) return { ok: false, message: '此優惠券活動尚未開始' };
  if (campaign.validUntil && today > campaign.validUntil) return { ok: false, message: '此優惠券已過期' };
  const limit = Number(campaign.totalLimit) || 0;
  const issued = Number(campaign.issuedCount) || 0;
  if (limit > 0 && issued >= limit) return { ok: false, message: '此優惠券已領完' };
  return { ok: true };
}

function buildCouponInstance(campaign, source, issuedBy) {
  const nowIso = new Date().toISOString();
  const rollingDays = Math.max(0, Number(campaign.validDays) || 0);
  const validFrom = campaign.validFrom || (rollingDays ? taipeiDateKey() : '');
  const validUntil = campaign.validUntil || (rollingDays ? dateKeyAfterDays(rollingDays) : '');
  return {
    id: `CP_${Date.now().toString(36).toUpperCase()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
    campaignId: campaign.code,
    code: campaign.code,
    name: campaign.name,
    desc: campaign.description || campaign.name,
    description: campaign.description || campaign.name,
    type: campaign.type,
    value: Number(campaign.value) || 0,
    minSpend: Number(campaign.minSpend) || 0,
    maxDiscount: Number(campaign.maxDiscount) || 0,
    eligibility: campaign.eligibility || 'all',
    validFrom,
    validUntil,
    validDays: rollingDays,
    serviceScope: campaign.serviceScope === 'singing_bowl_course' ? 'selected_services' : (campaign.serviceScope || 'all'),
    applicableServiceIds: Array.isArray(campaign.applicableServiceIds) ? campaign.applicableServiceIds.map(Number).filter(Number.isInteger) : [],
    applicableServiceNames: Array.isArray(campaign.applicableServiceNames) ? campaign.applicableServiceNames.map(value => cleanString(value, 100)).filter(Boolean) : [],
    scopeLabel: campaign.scopeLabel || ((campaign.serviceScope === 'selected_services' || campaign.serviceScope === 'singing_bowl_course')
      ? `指定服務：${Array.isArray(campaign.applicableServiceNames) && campaign.applicableServiceNames.length ? campaign.applicableServiceNames.join('、') : `${Array.isArray(campaign.applicableServiceIds) ? campaign.applicableServiceIds.length : 0} 個項目`}`
      : '全部服務項目'),
    status: 'available',
    used: false,
    claimedAt: nowIso,
    source: source || 'promo_code',
    issuedBy: cleanString(issuedBy, 80)
  };
}

async function issueCouponToCustomer({ customerId, code, source, issuedBy, password, requireRecentMember = false, allowAutoIssue = false }) {
  const safeCustomerId = cleanDocumentId(customerId);
  const safeCode = cleanCouponCode(code);
  if (!safeCustomerId || !safeCode) throw Object.assign(new Error('INVALID_COUPON_REQUEST'), { status: 400, publicMessage: '優惠券資料不完整' });
  const customerRef = firestore.collection('customers').doc(safeCustomerId);
  const campaignRef = firestore.collection('couponCampaigns').doc(safeCode);
  const result = await firestore.runTransaction(async transaction => {
    const customerSnapshot = await transaction.get(customerRef);
    const campaignSnapshot = await transaction.get(campaignRef);
    if (!customerSnapshot.exists) throw Object.assign(new Error('CUSTOMER_NOT_FOUND'), { status: 404, publicMessage: '找不到此客人帳號' });
    if (!campaignSnapshot.exists) throw Object.assign(new Error('COUPON_NOT_FOUND'), { status: 404, publicMessage: '優惠碼無效' });
    const customer = customerSnapshot.data();
    if (password !== undefined && (!customer.pw || !safeCodeEqual(password, customer.pw))) {
      throw Object.assign(new Error('CUSTOMER_AUTH_FAILED'), { status: 403, publicMessage: '客人帳號驗證失敗，請重新登入' });
    }
    const phone = normalizePhone(customer.phone);
    if (!/^09\d{8}$/.test(phone)) {
      throw Object.assign(new Error('CUSTOMER_PHONE_INVALID'), { status: 409, publicMessage: '此帳號沒有正確手機號碼，請聯絡店家更正後再領取' });
    }
    const claimRef = firestore.collection('couponClaims').doc(couponClaimDocumentId(safeCode, phone));
    const claimSnapshot = await transaction.get(claimRef);
    if (claimSnapshot.exists) {
      throw Object.assign(new Error('COUPON_ALREADY_CLAIMED'), { status: 409, publicMessage: '此手機號碼已領取過這個活動，每人限領一張' });
    }
    const campaign = { code: safeCode, ...campaignSnapshot.data() };
    if (campaign.autoIssue === true && !allowAutoIssue) {
      throw Object.assign(new Error('AUTO_ISSUE_ONLY'), { status: 409, publicMessage: '此券由系統在符合資格時自動發送，不能用活動碼另外領取' });
    }
    if (campaign.eligibility === 'new_member' && customer.isMember !== true) {
      throw Object.assign(new Error('MEMBER_REQUIRED'), { status: 409, publicMessage: '此優惠券只提供給已完成登記的會員' });
    }
    if (requireRecentMember) {
      const memberSince = Date.parse(String(customer.memberSince || ''));
      const recentWindowMs = 24 * 60 * 60 * 1000;
      if (customer.isMember !== true || !Number.isFinite(memberSince) || memberSince > Date.now() + 5 * 60 * 1000 || Date.now() - memberSince > recentWindowMs) {
        throw Object.assign(new Error('RECENT_MEMBER_REQUIRED'), { status: 409, publicMessage: '此體驗券會在新會員完成登記時自動發送' });
      }
    }
    const claimable = campaignClaimable(campaign);
    if (!claimable.ok) throw Object.assign(new Error('COUPON_NOT_CLAIMABLE'), { status: 409, publicMessage: claimable.message });
    const wallet = Array.isArray(customer.coupons) ? customer.coupons.slice(0, 100) : [];
    const alreadyIssued = wallet.some(item => String(item && (item.campaignId || item.code) || '').toUpperCase() === safeCode && item.status !== 'void');
    if (alreadyIssued) {
      // 舊版錢包可能沒有 couponClaims：補寫雜湊領取紀錄後仍回報重複。
      transaction.set(claimRef, {
        campaignId: safeCode,
        customerId: safeCustomerId,
        phoneHash: claimRef.id.slice(safeCode.length + 1),
        claimedAt: FieldValue.serverTimestamp(),
        source: 'legacy_wallet_migration'
      });
      return { alreadyClaimed: true };
    }
    if (wallet.length >= 100) throw Object.assign(new Error('COUPON_WALLET_FULL'), { status: 409, publicMessage: '優惠券數量已達上限，請聯絡店家整理' });
    const coupon = buildCouponInstance(campaign, source, issuedBy);
    transaction.update(customerRef, { coupons: [...wallet, coupon], couponUpdatedAt: FieldValue.serverTimestamp() });
    transaction.set(campaignRef, {
      issuedCount: (Number(campaign.issuedCount) || 0) + 1,
      lastIssuedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.set(claimRef, {
      campaignId: safeCode,
      customerId: safeCustomerId,
      phoneHash: claimRef.id.slice(safeCode.length + 1),
      claimedAt: FieldValue.serverTimestamp(),
      source: source || 'promo_code'
    });
    return { coupon };
  });
  if (result && result.alreadyClaimed) {
    throw Object.assign(new Error('COUPON_ALREADY_CLAIMED'), { status: 409, publicMessage: '每位客人限領一張，你已領取過此優惠券' });
  }
  return result.coupon;
}

async function ensureDefaultCouponCampaigns() {
  if (!firestore) return;
  for (const [code, seed] of Object.entries(DEFAULT_COUPON_CAMPAIGNS)) {
    const ref = firestore.collection('couponCampaigns').doc(code);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      await ref.set({
        // 舊版三組測試碼保持停用；新會員體驗券依活動設定自動啟用。
        ...seed, active: seed.active === true, validFrom: seed.validFrom || '', validUntil: seed.validUntil || '', totalLimit: Number(seed.totalLimit) || 0,
        validDays: Number(seed.validDays) || 0,
        serviceScope: seed.serviceScope || 'all',
        applicableServiceIds: Array.isArray(seed.applicableServiceIds) ? seed.applicableServiceIds : [],
        applicableServiceNames: Array.isArray(seed.applicableServiceNames) ? seed.applicableServiceNames : [],
        scopeLabel: seed.scopeLabel || '全部服務項目',
        autoIssue: seed.autoIssue === true,
        perCustomerLimit: 1, issuedCount: 0, systemDefault: true,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
      });
    }
  }
}

ensureDefaultCouponCampaigns().catch(error => {
  console.error('建立預設優惠券活動失敗:', error.message);
});

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
app.get('/', (req, res) => res.json({ status: 'ok', service: '元氣堂預約系統後端', version: '2.1.6' }));

// ── 員工註冊（註冊碼只存在 Render 環境變數）──
app.post('/api/register/employee', registrationLimiter, async (req, res) => {
  if (!firestore || !EMPLOYEE_REGISTRATION_CODE) {
    return res.status(503).json({ error: '員工註冊服務尚未完成設定，請聯絡店長' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const name = cleanString(body.name, 80);
  const id = cleanString(body.id, 50);
  const lineId = cleanString(body.lineId, 80);
  const therapistId = cleanString(body.therapistId, 20);
  const password = String(body.password || '');
  const registrationCode = String(body.registrationCode || '');

  if (!name || !therapistId || !id || !password || !registrationCode) {
    return res.status(400).json({ error: '請填寫完整資料、班表身分與員工註冊碼' });
  }
  if (!THERAPIST_IDENTITIES[therapistId]) {
    return res.status(400).json({ error: '班表身分無效，請重新選擇' });
  }
  if (!/^[A-Za-z0-9_-]{2,50}$/.test(id)) {
    return res.status(400).json({ error: '員工帳號限 2–50 位英文字母、數字、底線或連字號' });
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
      const linked = await transaction.get(
        firestore.collection('employees').where('therapistId', '==', therapistId).limit(1)
      );
      const legacyLinked = await transaction.get(
        firestore.collection('employees').where('name', '==', THERAPIST_IDENTITIES[therapistId]).limit(1)
      );
      if (snapshot.exists) {
        const error = new Error('EMPLOYEE_EXISTS');
        error.code = 'employee-exists';
        throw error;
      }
      if (!linked.empty || !legacyLinked.empty) {
        const error = new Error('THERAPIST_TAKEN');
        error.code = 'therapist-taken';
        throw error;
      }
      transaction.create(ref, {
        id,
        name,
        therapistId,
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
      employee: { id, name, therapistId, role: 'staff', lineId, cases: [], clockIn: null, clockOut: null, clockLog: [] }
    });
  } catch (error) {
    if (error.code === 'employee-exists') {
      return res.status(409).json({ error: '此員工帳號已被使用' });
    }
    if (error.code === 'therapist-taken') {
      return res.status(409).json({ error: '此班表身分已綁定其他員工帳號，請聯絡店長' });
    }
    console.error('員工註冊失敗:', error.message);
    return res.status(500).json({ error: '員工帳號建立失敗，請稍後再試' });
  }
});

// ── 店長刪除指定員工帳號（保留預約、報表、班表與打卡歷史）──
app.post('/api/admin/delete-employee', registrationLimiter, async (req, res) => {
  if (!firestore || !BOSS_RECOVERY_CODE) {
    return res.status(503).json({ error: '員工管理功能尚未完成設定，請先在 Render 設定 BOSS_RECOVERY_CODE' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const recoveryCode = String(body.recoveryCode || '');
  const employeeId = cleanString(body.employeeId, 50);
  if (!safeCodeEqual(recoveryCode, BOSS_RECOVERY_CODE)) {
    return res.status(403).json({ error: '店長救援碼錯誤' });
  }
  if (!/^[A-Za-z0-9_-]{2,50}$/.test(employeeId)) {
    return res.status(400).json({ error: '員工帳號格式不正確' });
  }
  try {
    const ref = firestore.collection('employees').doc(employeeId);
    const snapshot = await ref.get();
    if (!snapshot.exists) return res.status(404).json({ error: '找不到此員工帳號，可能已被刪除' });
    const employee = snapshot.data();
    if (employee.role === 'boss') {
      return res.status(403).json({ error: '店長帳號受保護，不可刪除' });
    }
    await ref.delete();
    return res.json({ ok: true, employeeId, employeeName: cleanString(employee.name, 80) });
  } catch (error) {
    console.error('刪除指定員工失敗:', error.message);
    return res.status(500).json({ error: '員工帳號刪除失敗，請稍後再試' });
  }
});

// ── 店長調整預約管理權限（boss 本身永遠不會被變更）──
app.post('/api/admin/set-employee-role', registrationLimiter, async (req, res) => {
  if (!firestore || !BOSS_RECOVERY_CODE) {
    return res.status(503).json({ error: '權限管理功能尚未完成設定，請先在 Render 設定 BOSS_RECOVERY_CODE' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const recoveryCode = String(body.recoveryCode || '');
  const employeeId = cleanString(body.employeeId, 50);
  const role = cleanString(body.role, 20);
  if (!safeCodeEqual(recoveryCode, BOSS_RECOVERY_CODE)) {
    return res.status(403).json({ error: '店長救援碼錯誤' });
  }
  if (!/^[A-Za-z0-9_-]{2,50}$/.test(employeeId)) {
    return res.status(400).json({ error: '員工帳號格式不正確' });
  }
  if (role !== 'manager' && role !== 'staff') {
    return res.status(400).json({ error: '權限類型只能是管理人員或一般員工' });
  }
  try {
    const ref = firestore.collection('employees').doc(employeeId);
    const snapshot = await ref.get();
    if (!snapshot.exists) return res.status(404).json({ error: '找不到此員工帳號' });
    if (snapshot.data().role === 'boss') {
      return res.status(403).json({ error: '不可變更店長帳號權限' });
    }
    await ref.update({ role, roleUpdatedAt: FieldValue.serverTimestamp() });
    return res.json({ ok: true, employeeId, role });
  } catch (error) {
    console.error('更新員工權限失敗:', error.message);
    return res.status(500).json({ error: '員工權限更新失敗，請稍後再試' });
  }
});

// ── 店長刪除指定客人登入帳號（保留預約、消費與報表歷史）──
app.post('/api/admin/delete-customer', adminLimiter, async (req, res) => {
  if (!firestore || !BOSS_RECOVERY_CODE) {
    return res.status(503).json({ error: '客人帳號管理尚未完成設定，請先在 Render 設定 BOSS_RECOVERY_CODE' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const recoveryCode = String(body.recoveryCode || '');
  const customerId = cleanDocumentId(body.customerId);
  if (!safeCodeEqual(recoveryCode, BOSS_RECOVERY_CODE)) {
    return res.status(403).json({ error: '店長救援碼錯誤' });
  }
  if (!customerId) return res.status(400).json({ error: '客人帳號格式不正確' });
  try {
    const ref = firestore.collection('customers').doc(customerId);
    const snapshot = await ref.get();
    if (!snapshot.exists) return res.status(404).json({ error: '找不到此客人帳號，可能已被刪除' });
    const customer = snapshot.data();
    const phone = normalizePhone(customer.phone);
    const wallet = Array.isArray(customer.coupons) ? customer.coupons : [];
    const claimedCodes = [...new Set(wallet.map(item => cleanCouponCode(item && (item.campaignId || item.code))).filter(code => /^[A-Z0-9_-]{3,30}$/.test(code)))];
    const batch = firestore.batch();
    if (/^09\d{8}$/.test(phone)) {
      claimedCodes.forEach(code => {
        const claimRef = firestore.collection('couponClaims').doc(couponClaimDocumentId(code, phone));
        batch.set(claimRef, {
          campaignId: code,
          customerId,
          phoneHash: claimRef.id.slice(code.length + 1),
          claimedAt: FieldValue.serverTimestamp(),
          source: 'account_deletion_migration'
        }, { merge: true });
      });
    }
    batch.delete(ref);
    await batch.commit();
    return res.json({
      ok: true,
      customerId,
      customerName: cleanString(customer.name, 80),
      historyPreserved: true
    });
  } catch (error) {
    console.error('刪除指定客人帳號失敗:', error.message);
    return res.status(500).json({ error: '客人帳號刪除失敗，請稍後再試' });
  }
});

// ── 店長建立或修改優惠券活動──
app.post('/api/admin/upsert-coupon-campaign', couponLimiter, async (req, res) => {
  if (!firestore || !BOSS_RECOVERY_CODE) {
    return res.status(503).json({ error: '優惠券管理尚未完成設定，請先在 Render 設定 BOSS_RECOVERY_CODE' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (!safeCodeEqual(String(body.recoveryCode || ''), BOSS_RECOVERY_CODE)) {
    return res.status(403).json({ error: '店長救援碼錯誤' });
  }
  let campaign;
  try {
    campaign = normalizeCampaignInput(body);
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.publicMessage || '優惠券資料不正確' });
  }
  try {
    const ref = firestore.collection('couponCampaigns').doc(campaign.code);
    const snapshot = await ref.get();
    const existing = snapshot.exists ? snapshot.data() : {};
    await ref.set({
      ...campaign,
      issuedCount: Number(existing.issuedCount) || 0,
      systemDefault: existing.systemDefault === true,
      autoIssue: existing.autoIssue === true,
      createdAt: existing.createdAt || FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    return res.json({ ok: true, campaign: { ...campaign, issuedCount: Number(existing.issuedCount) || 0 } });
  } catch (error) {
    console.error('儲存優惠券活動失敗:', error.message);
    return res.status(500).json({ error: '優惠券活動儲存失敗，請稍後再試' });
  }
});

// ── 店長啟用／停用優惠券活動，不刪除歷史資料──
app.post('/api/admin/set-coupon-campaign-active', couponLimiter, async (req, res) => {
  if (!firestore || !BOSS_RECOVERY_CODE) {
    return res.status(503).json({ error: '優惠券管理尚未完成設定' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (!safeCodeEqual(String(body.recoveryCode || ''), BOSS_RECOVERY_CODE)) {
    return res.status(403).json({ error: '店長救援碼錯誤' });
  }
  const code = cleanCouponCode(body.code);
  if (!/^[A-Z0-9_-]{3,30}$/.test(code) || typeof body.active !== 'boolean') {
    return res.status(400).json({ error: '優惠券資料不正確' });
  }
  try {
    const ref = firestore.collection('couponCampaigns').doc(code);
    const snapshot = await ref.get();
    if (!snapshot.exists) return res.status(404).json({ error: '找不到此優惠券活動' });
    await ref.update({ active: body.active, updatedAt: FieldValue.serverTimestamp() });
    return res.json({ ok: true, code, active: body.active });
  } catch (error) {
    console.error('更新優惠券狀態失敗:', error.message);
    return res.status(500).json({ error: '優惠券狀態更新失敗' });
  }
});

// ── 店長指定發券給客人──
app.post('/api/admin/issue-coupon', couponLimiter, async (req, res) => {
  if (!firestore || !BOSS_RECOVERY_CODE) {
    return res.status(503).json({ error: '優惠券管理尚未完成設定' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (!safeCodeEqual(String(body.recoveryCode || ''), BOSS_RECOVERY_CODE)) {
    return res.status(403).json({ error: '店長救援碼錯誤' });
  }
  try {
    const coupon = await issueCouponToCustomer({
      customerId: body.customerId,
      code: body.code,
      source: 'boss_issue',
      issuedBy: cleanString(body.issuedBy || 'boss', 80),
      allowAutoIssue: true
    });
    return res.json({ ok: true, coupon });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.publicMessage || '發券失敗' });
    console.error('指定發券失敗:', error.message);
    return res.status(500).json({ error: '優惠券發送失敗，請稍後再試' });
  }
});

// ── 店長批量發券：一次發給全部會員或全部有有效手機的客人──
app.post('/api/admin/issue-coupon-bulk', couponLimiter, async (req, res) => {
  if (!firestore || !BOSS_RECOVERY_CODE) {
    return res.status(503).json({ error: '優惠券管理尚未完成設定' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (!safeCodeEqual(String(body.recoveryCode || ''), BOSS_RECOVERY_CODE)) {
    return res.status(403).json({ error: '店長救援碼錯誤' });
  }
  const code = cleanCouponCode(body.code);
  const target = body.target === 'all' ? 'all' : 'members';
  if (!/^[A-Z0-9_-]{3,30}$/.test(code)) return res.status(400).json({ error: '請選擇正確的優惠券活動' });
  try {
    const campaignSnapshot = await firestore.collection('couponCampaigns').doc(code).get();
    if (!campaignSnapshot.exists) return res.status(404).json({ error: '找不到此優惠券活動' });
    const campaign = { code, ...campaignSnapshot.data() };
    if (campaign.autoIssue === true) {
      return res.status(409).json({ error: '系統自動發送的優惠券不能批量發放，避免舊會員誤領' });
    }
    const claimable = campaignClaimable(campaign);
    if (!claimable.ok) return res.status(409).json({ error: claimable.message });

    const customerSnapshot = await firestore.collection('customers').get();
    const candidates = customerSnapshot.docs
      .map(snapshot => ({ id: snapshot.id, ...snapshot.data() }))
      .filter(customer => /^09\d{8}$/.test(normalizePhone(customer.phone)))
      .filter(customer => target === 'all' || customer.isMember === true)
      .slice(0, 500);
    let issued = 0;
    let skipped = 0;
    let failed = 0;
    const skipCodes = new Set(['COUPON_ALREADY_CLAIMED', 'MEMBER_REQUIRED', 'CUSTOMER_PHONE_INVALID', 'COUPON_WALLET_FULL', 'COUPON_NOT_CLAIMABLE']);
    for (const customer of candidates) {
      try {
        await issueCouponToCustomer({
          customerId: customer.id,
          code,
          source: 'boss_bulk_issue',
          issuedBy: cleanString(body.issuedBy || 'boss', 80)
        });
        issued += 1;
      } catch (error) {
        if (skipCodes.has(error && error.message)) skipped += 1;
        else {
          failed += 1;
          console.error(`批量發券失敗 [${customer.id}]:`, error && error.message ? error.message : error);
        }
      }
    }
    return res.json({
      ok: true,
      code,
      target,
      issued,
      skipped,
      failed,
      considered: candidates.length,
      truncated: customerSnapshot.size > 500
    });
  } catch (error) {
    console.error('批量發券失敗:', error.message);
    return res.status(500).json({ error: '批量發券失敗，請稍後再試' });
  }
});

// ── 客人以活動碼領取優惠券：後端驗證帳號與每人限領一張──
app.post('/api/coupons/claim', couponLimiter, async (req, res) => {
  if (!firestore) return res.status(503).json({ error: '優惠券服務暫時無法使用' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const password = String(body.password || '');
  if (!password) return res.status(400).json({ error: '請重新登入後再領取優惠券' });
  try {
    const coupon = await issueCouponToCustomer({
      customerId: body.customerId,
      code: body.code,
      source: 'promo_code',
      issuedBy: 'customer',
      password
    });
    return res.json({ ok: true, coupon });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.publicMessage || '優惠券領取失敗' });
    console.error('客人領取優惠券失敗:', error.message);
    return res.status(500).json({ error: '優惠券領取失敗，請稍後再試' });
  }
});

// ── 新會員完成登記後自動發送頌缽音波課程體驗券──
app.post('/api/coupons/welcome-member', couponLimiter, async (req, res) => {
  if (!firestore) return res.status(503).json({ error: '優惠券服務暫時無法使用' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    // 確保首次部署時活動已建立，再執行發券交易。
    await ensureDefaultCouponCampaigns();
    const coupon = await issueCouponToCustomer({
      customerId: body.customerId,
      code: 'NEW_MEMBER_BOWL90',
      source: 'new_member_auto',
      issuedBy: 'system',
      requireRecentMember: true,
      allowAutoIssue: true
    });
    return res.json({ ok: true, coupon, alreadyIssued: false });
  } catch (error) {
    if (error && error.message === 'COUPON_ALREADY_CLAIMED') {
      return res.json({ ok: true, coupon: null, alreadyIssued: true });
    }
    if (error.status) return res.status(error.status).json({ error: error.publicMessage || '新會員體驗券發送失敗' });
    console.error('新會員體驗券發送失敗:', error.message);
    return res.status(500).json({ error: '新會員體驗券發送失敗，請稍後再試' });
  }
});

// ── 店長帳號救援：使用獨立救援碼重設密碼並取回帳號 ID ──
app.post('/api/admin/reset-boss-password', registrationLimiter, async (req, res) => {
  if (!firestore || !BOSS_RECOVERY_CODE) {
    return res.status(503).json({ error: '店長帳號救援功能尚未設定，請先在 Render 設定 BOSS_RECOVERY_CODE' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const recoveryCode = String(body.recoveryCode || '');
  const password = String(body.password || '');
  const requestedId = cleanString(body.employeeId, 50);
  if (!safeCodeEqual(recoveryCode, BOSS_RECOVERY_CODE)) {
    return res.status(403).json({ error: '店長救援碼錯誤' });
  }
  if (password.length < 6 || password.length > 128) {
    return res.status(400).json({ error: '新密碼長度需為 6–128 位' });
  }
  try {
    let bossDoc = null;
    if (requestedId) {
      const snapshot = await firestore.collection('employees').doc(requestedId).get();
      if (snapshot.exists && snapshot.data().role === 'boss') bossDoc = snapshot;
      else if (snapshot.exists) return res.status(409).json({ error: '此帳號存在，但不是店長帳號' });
      else {
        const bosses = await firestore.collection('employees').where('role', '==', 'boss').limit(2).get();
        if (bosses.size === 1) bossDoc = bosses.docs[0];
        else if (bosses.size > 1) return res.status(409).json({ error: '找到多個店長帳號，請填寫正確的店長帳號 ID' });
      }
    } else {
      const snapshot = await firestore.collection('employees').where('role', '==', 'boss').limit(2).get();
      if (snapshot.size === 1) bossDoc = snapshot.docs[0];
      else if (snapshot.size > 1) return res.status(409).json({ error: '找到多個店長帳號，請填寫店長帳號 ID' });
    }
    if (bossDoc) {
      await bossDoc.ref.update({ pw: password, passwordResetAt: FieldValue.serverTimestamp() });
      return res.json({ ok: true, bossId: bossDoc.id, created: false });
    }
    const bossId = requestedId || 'boss';
    if (!/^[A-Za-z0-9_-]{2,50}$/.test(bossId)) {
      return res.status(400).json({ error: '店長帳號格式不正確' });
    }
    await firestore.collection('employees').doc(bossId).set({
      id: bossId,
      name: '老闆',
      pw: password,
      role: 'boss',
      lineId: '',
      therapistId: null,
      createdAt: FieldValue.serverTimestamp(),
      passwordResetAt: FieldValue.serverTimestamp()
    });
    return res.json({ ok: true, bossId, created: true });
  } catch (error) {
    console.error('店長密碼重設失敗:', error.message);
    return res.status(500).json({ error: '店長密碼重設失敗，請稍後再試' });
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
