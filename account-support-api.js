'use strict';
const crypto = require('node:crypto');

function fail(status, code, message) {
  return Object.assign(new Error(code), { status, publicMessage: message });
}
function equal(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !right) return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function accountId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : '';
}
function phoneKey(value) {
  const digits = String(value || '').normalize('NFKC').replace(/\D/g, '');
  return digits.startsWith('8869') ? '0' + digits.slice(3) : digits;
}
function publicAccount(snapshot) {
  // Only return fields needed by the app; passwords and reset metadata stay on the server.
  const data = snapshot.data(), keys = [
    'name', 'phone', 'role', 'therapistId', 'lineId', 'cases', 'clockIn', 'clockOut',
    'clockLog', 'coupons', 'isMember', 'memberSince', 'accountType', 'registeredAt',
    'createdAt', 'phoneVerified', 'phoneCompletedAt', 'passwordRevision'
  ];
  const result = { id: snapshot.id };
  for (const key of keys) if (data[key] !== undefined) result[key] = data[key];
  return result;
}

function createAccountSupportService({ db, managementCode, clock = Date.now }) {
  function ready() {
    if (!db) throw fail(503, 'DATABASE_UNAVAILABLE', '帳號服務尚未連線，請聯絡網站管理者');
  }
  function checkCode(code) {
    if (!managementCode) throw fail(503, 'MANAGEMENT_NOT_CONFIGURED', '店長管理碼尚未設定，請聯絡網站管理者設定後再操作');
    if (!equal(code, managementCode)) throw fail(403, 'MANAGEMENT_CODE_INVALID', '店長管理碼不正確；請使用網站管理者提供的管理碼');
  }
  async function bossIn(tx, body) {
    checkCode(body.recoveryCode);
    const actor = body.actor || {};
    if (!accountId(actor.id) || typeof actor.password !== 'string' || actor.password.length > 128) {
      throw fail(403, 'BOSS_REQUIRED', '請重新登入店長帳號後再操作');
    }
    const snapshot = await tx.get(db.collection('employees').doc(actor.id));
    if (!snapshot.exists || snapshot.data().role !== 'boss' || !equal(actor.password, snapshot.data().pw)) {
      throw fail(403, 'BOSS_REQUIRED', '店長登入已失效，請重新登入後再操作');
    }
    return snapshot;
  }
  async function login(body) {
    ready();
    const account = typeof body.account === 'string' ? body.account.normalize('NFKC').trim() : '';
    const password = body.password;
    if (!account || account.length > 100 || typeof password !== 'string' || !password || password.length > 128) {
      throw fail(400, 'LOGIN_INPUT_INVALID', '請填寫帳號與密碼');
    }
    let snapshot;
    if (body.kind === 'employee') {
      if (!accountId(account)) throw fail(401, 'LOGIN_FAILED', '員工帳號或密碼錯誤，請確認使用員工登入');
      snapshot = await db.collection('employees').doc(account).get();
      if (!snapshot.exists || !equal(password, snapshot.data().pw)) {
        throw fail(401, 'LOGIN_FAILED', '員工帳號或密碼錯誤；忘記密碼請由店長協助重設');
      }
    } else if (body.kind === 'customer') {
      const phone = phoneKey(account), isPhone = /^09\d{8}$/.test(phone);
      const all = await db.collection('customers').get();
      const candidates = all.docs.filter(doc => {
        const row = doc.data();
        if (!row.pw) return false;
        return isPhone ? phoneKey(row.phone) === phone :
          !/^09\d{8}$/.test(phoneKey(row.phone)) && (doc.id === account || row.name === account);
      });
      if (candidates.length > 1) throw fail(409, 'ACCOUNT_AMBIGUOUS', '有多筆相同帳號資料，請聯絡店長核對後再登入');
      snapshot = candidates[0];
      if (!snapshot || !equal(password, snapshot.data().pw)) {
        throw fail(401, 'LOGIN_FAILED', '手機號碼／舊會員姓名或密碼錯誤；忘記密碼請聯絡店家');
      }
    } else throw fail(400, 'ACCOUNT_TYPE_INVALID', '請選擇客人或員工登入');
    return { account: publicAccount(snapshot) };
  }
  async function reset(body) {
    ready();
    const collection = body.kind === 'customer' ? 'customers' : body.kind === 'employee' ? 'employees' : '';
    const targetId = accountId(body.targetId), password = body.password;
    if (!collection || !targetId) throw fail(400, 'TARGET_INVALID', '請從客人或員工名單選擇要重設的帳號');
    if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
      throw fail(400, 'PASSWORD_INVALID', '新密碼長度需為 6–128 位');
    }
    if (password !== body.passwordConfirm) throw fail(400, 'PASSWORD_MISMATCH', '兩次新密碼不一致');
    return db.runTransaction(async tx => {
      const boss = await bossIn(tx, body);
      const ref = db.collection(collection).doc(targetId), target = await tx.get(ref);
      if (!target.exists) throw fail(404, 'ACCOUNT_NOT_FOUND', '找不到此帳號，可能已刪除；請重新整理名單');
      const current = target.data();
      if (collection === 'employees' && current.role === 'boss') {
        throw fail(409, 'BOSS_RECOVERY_REQUIRED', '店長帳號請使用登入頁的「店長帳號救援」重設');
      }
      if (!current.pw) throw fail(409, 'NO_LOGIN_ACCOUNT', '這筆只有現場或歷史資料，尚未建立登入帳號，請先完成註冊或資料連結');
      const at = new Date(clock()).toISOString();
      const revision = (Number(current.passwordRevision) || 0) + 1;
      // Update only credentials. Coupons, membership, staff assignment and history are untouched.
      tx.update(ref, { pw: password, passwordRevision: revision, passwordResetAt: at, passwordResetBy: boss.id });
      tx.set(db.collection('accountResets').doc(crypto.randomUUID()), {
        kind: body.kind, targetId, byId: boss.id, at, revision
      });
      return { targetId, name: String(current.name || targetId), passwordRevision: revision };
    });
  }
  async function recoverBoss(body) {
    ready(); checkCode(body.recoveryCode);
    const requestedId = typeof body.employeeId === 'string' ? body.employeeId.normalize('NFKC').trim() : '';
    if (requestedId && !accountId(requestedId)) throw fail(400, 'ACCOUNT_ID_INVALID', '請輸入正確的店長帳號');
    const password = body.password;
    if (typeof password !== 'string' || password.length < 6 || password.length > 128) throw fail(400, 'PASSWORD_INVALID', '新密碼長度需為 6–128 位');
    if (password !== body.passwordConfirm) throw fail(400, 'PASSWORD_MISMATCH', '兩次新密碼不一致');
    return db.runTransaction(async tx => {
      let target;
      if (requestedId) {
        target = await tx.get(db.collection('employees').doc(requestedId));
        if (!target.exists) throw fail(404, 'ACCOUNT_NOT_FOUND', '找不到這個店長帳號，請核對帳號；不會自動建立新帳號');
        if (target.data().role !== 'boss') throw fail(409, 'NOT_BOSS', '這是員工帳號，請由店長登入「員工帳號管理」協助重設');
      } else {
        const bosses = await tx.get(db.collection('employees').where('role', '==', 'boss').limit(2));
        if (bosses.docs.length !== 1) throw fail(409, 'BOSS_ID_REQUIRED', '無法確認唯一的店長帳號，請填寫正確帳號或聯絡網站管理者');
        target = bosses.docs[0];
      }
      const at = new Date(clock()).toISOString(), revision = (Number(target.data().passwordRevision) || 0) + 1;
      tx.update(db.collection('employees').doc(target.id), { pw: password, passwordRevision: revision, passwordResetAt: at, passwordResetBy: 'boss_recovery' });
      tx.set(db.collection('accountResets').doc(crypto.randomUUID()), { kind: 'boss', targetId: target.id, byId: 'boss_recovery', at, revision });
      return { bossId: target.id, created: false };
    });
  }
  return { login, reset, recoverBoss, authorizeBoss: bossIn };
}

function installAccountSupportRoutes({ app, service, loginLimiter, adminLimiter, recoveryLimiter }) {
  const route = action => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json({ ok: true, ...await action(req.body || {}) }); }
    catch (error) { res.status(error.status || 500).json({ error: error.publicMessage || '帳號服務暫時無法使用，請稍後再試', code: error.status ? error.message : 'ACCOUNT_SERVICE_FAILED' }); }
  };
  app.post('/api/auth/login', loginLimiter, route(service.login));
  app.post('/api/admin/reset-account-password', adminLimiter, route(service.reset));
  app.post('/api/admin/reset-boss-password', recoveryLimiter, route(service.recoverBoss));
}
module.exports = { createAccountSupportService, installAccountSupportRoutes, phoneKey };
