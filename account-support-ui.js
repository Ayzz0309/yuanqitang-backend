'use strict';
let accountSupportPendingCode = null;
let accountSupportTarget = null;
let accountSupportHistory = null;
let accountSupportSaving = false;

async function accountSupportRequest(path, payload) {
  const response = await fetch(LINE_CONFIG.backendUrl + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(response.status === 404 && !result.code && !result.error ? '帳號服務尚未更新，請先完成後端部署後再試' : result.error || '連線失敗，請稍後再試');
    error.code = result.code; throw error;
  }
  return result;
}

function accountSupportModal() {
  let modal = document.getElementById('account-support-modal');
  if (!modal) {
    modal = document.createElement('div'); modal.id = 'account-support-modal';
    modal.className = 'modal-overlay hidden'; modal.style.zIndex = '10200';
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'account-support-title');
    modal.innerHTML = '<div class="modal-box" id="account-support-body" style="animation:none;overscroll-behavior:contain"></div>';
    modal.addEventListener('click', event => { if (event.target === modal) closeAccountSupport(); });
    document.body.appendChild(modal);
  }
  return modal;
}
function managementCodeHelpHtml() {
  return '<div style="padding:10px 12px;background:var(--pu-pale);border-radius:10px;font-size:12px;line-height:1.8;margin-bottom:14px">'
    + '店長管理碼是網站管理者另外提供的一組管理用密碼，與登入密碼、員工註冊碼不同。<br>不知道管理碼時，請聯絡網站管理者確認或重設；不用輸入欄位名稱。</div>';
}
function accountSupportTitle(title) {
  return '<div class="modal-title"><span id="account-support-title">' + esc(title) + '</span><button class="modal-close" onclick="closeAccountSupport()">✕</button></div>';
}
function requestManagementCode(action) {
  if (accountSupportSaving) return Promise.resolve(null);
  if (!requireBoss(action)) return Promise.resolve(null);
  closeAccountSupport();
  const modal = accountSupportModal();
  document.getElementById('account-support-body').innerHTML = accountSupportTitle('確認' + action)
    + managementCodeHelpHtml()
    + '<form id="management-code-form" onsubmit="event.preventDefault();submitManagementCode()">'
    + '<div class="fg"><label class="flbl" for="management-code-input">店長管理碼</label><input id="management-code-input" class="finp" type="password" required autocomplete="off" placeholder="請輸入網站管理者提供的管理碼"></div>'
    + '<button type="submit" class="auth-submit">繼續</button></form>';
  modal.classList.remove('hidden');
  document.getElementById('account-support-body').scrollTop = 0;
  return new Promise(resolve => {
    accountSupportPendingCode = resolve;
    setTimeout(() => document.getElementById('management-code-input')?.focus(), 0);
  });
}
function submitManagementCode() {
  const code = document.getElementById('management-code-input').value;
  if (!code.trim()) return;
  const resolve = accountSupportPendingCode; accountSupportPendingCode = null;
  closeAccountSupport(); if (resolve) resolve(code);
}
function closeAccountSupport() {
  if (accountSupportSaving) return;
  const modal = document.getElementById('account-support-modal');
  if (modal) { modal.classList.add('hidden'); const body = document.getElementById('account-support-body'); body.scrollTop = 0; body.innerHTML = ''; }
  accountSupportTarget = null;
  accountSupportHistory = null;
  if (accountSupportPendingCode) { const resolve = accountSupportPendingCode; accountSupportPendingCode = null; resolve(null); }
}
function accountResetButtonHtml(kind, id) {
  const encoded = encodeURIComponent(String(id)).replace(/'/g, '%27');
  return '<button class="mini-btn" onclick="openAccountPasswordReset(\'' + kind + '\',decodeURIComponent(\'' + encoded + '\'))">重設密碼</button>';
}
function openAccountPasswordReset(kind, id) {
  if (accountSupportSaving) return;
  if (!requireBoss('重設密碼')) return;
  const target = (kind === 'customer' ? customers : employees).find(row => row.id === id);
  if (!target || !target.pw || (kind === 'employee' && target.role === 'boss')) { alert('請選擇已有登入帳號的客人或員工'); return; }
  closeAccountSupport(); accountSupportTarget = { kind, id };
  const modal = accountSupportModal(), label = kind === 'customer' ? '客人' : '員工';
  document.getElementById('account-support-body').innerHTML = accountSupportTitle('重設' + label + '密碼')
    + '<div style="font-size:13px;line-height:1.9;margin-bottom:14px"><strong>' + esc(target.name) + '</strong><br>登入帳號：' + esc(kind === 'customer' ? target.phone || target.name : target.id)
    + '<br>請先與本人核對帳號。儲存後請告知對方新密碼，原密碼將失效。</div>'
    + '<form onsubmit="event.preventDefault();submitAccountPasswordReset()">'
    + '<div class="fg"><label class="flbl" for="account-new-password">新密碼</label><input id="account-new-password" class="finp" type="password" required minlength="6" maxlength="128" autocomplete="new-password" placeholder="6–128 位"></div>'
    + '<div class="fg"><label class="flbl" for="account-new-password-confirm">再輸入一次新密碼</label><input id="account-new-password-confirm" class="finp" type="password" required minlength="6" maxlength="128" autocomplete="new-password"></div>'
    + managementCodeHelpHtml()
    + '<div class="fg"><label class="flbl" for="account-reset-code">店長管理碼</label><input id="account-reset-code" class="finp" type="password" required autocomplete="off" placeholder="網站管理者提供的管理碼"></div>'
    + '<div id="account-reset-error" role="alert" style="font-size:12px;color:var(--red);line-height:1.8;margin-bottom:12px"></div>'
    + '<button id="account-reset-save" type="submit" class="auth-submit">確認重設密碼</button></form>';
  modal.classList.remove('hidden');
  document.getElementById('account-support-body').scrollTop = 0;
  setTimeout(() => document.getElementById('account-new-password')?.focus(), 0);
}
async function submitAccountPasswordReset() {
  if (accountSupportSaving || !accountSupportTarget || !requireBoss('重設密碼')) return;
  const password = document.getElementById('account-new-password').value;
  const passwordConfirm = document.getElementById('account-new-password-confirm').value;
  const recoveryCode = document.getElementById('account-reset-code').value;
  const error = document.getElementById('account-reset-error');
  if (password.length < 6 || password.length > 128) { error.textContent = '新密碼長度需為 6–128 位'; return; }
  if (password !== passwordConfirm) { error.textContent = '兩次新密碼不一致'; return; }
  if (!recoveryCode.trim()) { error.textContent = '請輸入店長管理碼'; return; }
  const target = { ...accountSupportTarget }, button = document.getElementById('account-reset-save');
  accountSupportSaving = true; button.disabled = true; button.textContent = '儲存中…'; error.textContent = '';
  try {
    const result = await accountSupportRequest('/api/admin/reset-account-password', {
      kind: target.kind, targetId: target.id, password, passwordConfirm, recoveryCode,
      actor: { id: cur.user.id, password: cur.user.pw }
    });
    const row = (target.kind === 'customer' ? customers : employees).find(item => item.id === target.id);
    if (row) { row.pw = password; row.passwordRevision = result.passwordRevision; }
    accountSupportSaving = false; closeAccountSupport();
    toast('已重設「' + result.name + '」的密碼，請通知本人使用新密碼登入', 'sys', '密碼重設完成');
    renderStaffContent();
  } catch (err) { error.textContent = err.message || '連線失敗，請確認網路後再試'; }
  finally { accountSupportSaving = false; if (button.isConnected) { button.disabled = false; button.textContent = '確認重設密碼'; } }
}
function showBossRecoveryForm() {
  document.getElementById('forgot-employee-help').classList.add('hidden');
  document.getElementById('forgot-step1').classList.remove('hidden');
  document.getElementById('forgot-description').textContent = '僅供店長帳號救援。請填寫店長管理碼及兩次新密碼；不知道管理碼時，請聯絡網站管理者。';
}
function customerAccountHelpButtonHtml(key, label) {
  const encoded = encodeURIComponent(String(key)).replace(/'/g, '%27');
  return '<button class="mini-btn" onclick="openCustomerAccountHelp(decodeURIComponent(\'' + encoded + '\'))">' + esc(label) + '</button>';
}
async function openCustomerAccountHelp(key) {
  if (accountSupportSaving) return;
  if (!requireBoss('連結會員歷史紀錄')) return;
  const original = buildCustomerRows().find(row => row.key === key);
  if (!original) return;
  let rows;
  try { rows = await fbGetAll('customers'); }
  catch (error) { alert('會員名單讀取失敗，請確認網路後再試'); return; }
  closeAccountSupport();
  const phone = customerPhoneKey(original.phone);
  const candidates = rows.filter(row => row.pw && (customerPhoneKey(row.phone) === phone || !/^09\d{8}$/.test(customerPhoneKey(row.phone))));
  accountSupportHistory = { bookingIds: original.books.map(row => row.id) };
  const modal = accountSupportModal();
  document.getElementById('account-support-body').innerHTML = accountSupportTitle('會員帳號與歷史紀錄')
    + '<div style="font-size:13px;line-height:1.9;margin-bottom:14px"><strong>' + esc(original.name) + '</strong> ・ ' + esc(original.phone || '未留手機') + '<br>'
    + (original.account && original.account.pw ? '此客人已有登入帳號，可將尚未歸戶的紀錄連結到本人帳號。' : '這筆是現場或歷史資料，本身沒有登入密碼。請客人先使用本人手機完成註冊，再回到這裡連結歷史紀錄。')
    + '<br>連結只調整紀錄所屬帳號，不會更改消費金額，也不會自動發放優惠券。</div>'
    + (candidates.length ? '<form onsubmit="event.preventDefault();submitCustomerHistoryLink()"><div class="fg"><label class="flbl" for="account-history-target">核對要連結的會員帳號</label><select id="account-history-target" class="finp"><option value="">請選擇並核對本人帳號</option>'
      + candidates.map(row => '<option value="' + esc(row.id) + '">' + esc(row.name) + ' ・ ' + esc(row.phone || '未留手機') + ' ・ ' + esc(row.id) + '</option>').join('') + '</select></div>'
      + managementCodeHelpHtml() + '<div class="fg"><label class="flbl" for="account-history-code">店長管理碼</label><input id="account-history-code" class="finp" type="password" required autocomplete="off"></div>'
      + '<div id="account-history-error" role="alert" style="font-size:12px;color:var(--red);line-height:1.8;margin-bottom:12px"></div>'
      + '<button id="account-history-save" type="submit" class="auth-submit">確認連結歷史紀錄</button></form>'
      : '<div style="padding:12px;background:var(--pu-pale);font-size:13px;line-height:1.8;border-radius:10px">目前沒有可連結的本人登入帳號。請先完成註冊；勿刪除原有歷史紀錄。</div>');
  modal.classList.remove('hidden');
  document.getElementById('account-support-body').scrollTop = 0;
}
async function submitCustomerHistoryLink() {
  if (!requireBoss('連結歷史紀錄') || !accountSupportHistory || accountSupportSaving) return;
  const targetCustomerId = document.getElementById('account-history-target').value;
  const recoveryCode = document.getElementById('account-history-code').value;
  const error = document.getElementById('account-history-error');
  if (!targetCustomerId || !recoveryCode.trim()) { error.textContent = '請選擇本人帳號並輸入店長管理碼'; return; }
  const bookingIds = accountSupportHistory.bookingIds;
  if (bookingIds.length > 100) { error.textContent = '歷史紀錄超過單次上限 100 筆，請聯絡網站管理者分批處理'; return; }
  const button = document.getElementById('account-history-save');
  accountSupportSaving = true; button.disabled = true; button.textContent = '連結中…'; error.textContent = '';
  try {
    await accountSupportRequest('/api/admin/link-customer-history', {
      targetCustomerId, bookingIds, recoveryCode, actor: { id: cur.user.id, password: cur.user.pw }
    });
    accountSupportSaving = false; closeAccountSupport();
    toast('歷史紀錄已連結到會員帳號', 'sys', '連結完成');
    await loadAllData(); renderStaffContent();
  } catch (err) { if (error.isConnected) error.textContent = err.message || '連結失敗，請稍後再試'; else alert(err.message || '連結後讀取失敗，請重新整理'); }
  finally { accountSupportSaving = false; if (button.isConnected) { button.disabled = false; button.textContent = '確認連結歷史紀錄'; } }
}
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeAccountSupport(); });
