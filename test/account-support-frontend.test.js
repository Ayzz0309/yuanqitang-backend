'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const ui = fs.readFileSync(path.join(__dirname, '../account-support-ui.js'), 'utf8');
function source(name) {
  const match = new RegExp('^(?:async )?function ' + name + '\\(', 'm').exec(html);
  assert.ok(match); return html.slice(match.index, html.indexOf('\n}', match.index) + 2);
}
test('employee forgot-password help defaults to employee instructions rather than the boss recovery form', () => {
  const states = new Map();
  const nodes = Object.fromEntries(['fp-id', 'fp-code', 'fp-newpw', 'fp-newpw2', 'fp-err', 'forgot-employee-help', 'forgot-step1', 'forgot-description', 'forgot-modal'].map(id => [id, {
    value: 'old-sensitive-input', textContent: '', classList: { add: value => states.set(id + ':' + value, true), remove: value => states.set(id + ':' + value, false) }
  }]));
  const context = vm.createContext({ document: { getElementById: id => nodes[id] } });
  vm.runInContext(source('showForgotPw'), context); context.showForgotPw('emp');
  assert.equal(states.get('forgot-step1:hidden'), true); assert.equal(states.get('forgot-employee-help:hidden'), false);
  assert.match(nodes['forgot-description'].textContent, /員工不需要管理碼/);
  assert.equal(nodes['fp-code'].value, ''); assert.equal(nodes['fp-newpw'].value, '');
});
test('realtime employee and customer updates revoke a session when the password changes', () => {
  for (const type of ['emp', 'cust']) {
    const callbacks = {}, messages = [];
    const context = vm.createContext({
      cur: { type, user: { id: 'ACCOUNT', pw: 'old-password', passwordRevision: 0 } },
      fbListen: (collection, callback) => { callbacks[collection] = callback; }, stopRealtimeSync() {},
      alert: message => messages.push(message), logout() { context.cur = { type: null, user: null }; }
    });
    vm.runInContext(source('startRealtimeSync'), context);
    context.startRealtimeSync(); callbacks[type === 'emp' ? 'employees' : 'customers']([{ id: 'ACCOUNT', pw: 'new-password', passwordRevision: 1 }]);
    assert.equal(context.cur.type, null); assert.match(messages[0], /重新登入/);
  }
});
test('data refresh includes the current boss record and clears employees deleted since the previous load', async () => {
  const records = { employees: [{ id: 'boss', pw: 'fresh-password', role: 'boss' }] };
  const context = vm.createContext({
    employees: [{ id: 'boss', pw: 'stale-password' }], console: { log() {}, error() {}, warn() {} },
    fbGetAll: async name => records[name] || [], fbGet: async () => null, clearDbError() {},
    migrateBookingInMemory: row => row, customSvcs: [], window: {},
    scheduleDocParts: () => null
  });
  vm.runInContext(source('loadAllData'), context); await context.loadAllData();
  assert.equal(context.employees.length, 1); assert.equal(context.employees[0].pw, 'fresh-password');
  records.employees = []; await context.loadAllData(); assert.equal(context.employees.length, 0);
});
test('API error messages distinguish a missing account from an old backend without the new route', async () => {
  let response;
  const context = vm.createContext({ document: { addEventListener() {} }, LINE_CONFIG: { backendUrl: 'https://example.invalid' }, fetch: async () => response });
  vm.runInContext(ui, context);
  response = { status: 404, ok: false, json: async () => ({ code: 'ACCOUNT_NOT_FOUND', error: '找不到此帳號' }) };
  await assert.rejects(context.accountSupportRequest('/test', {}), /找不到此帳號/);
  response = { status: 404, ok: false, json: async () => { throw new Error('not json'); } };
  await assert.rejects(context.accountSupportRequest('/test', {}), /後端部署/);
});
test('staff profile updates merge without rewriting credentials or deleting reset metadata', async () => {
  let write;
  const context = vm.createContext({ db: async () => ({}), fs: () => ({
    doc: (db, col, id) => ({ col, id }), setDoc: async (ref, data, options) => { write = { ref, data, options }; }
  }) });
  vm.runInContext(source('saveEmployee'), context);
  await context.saveEmployee({ id: 'staff', pw: 'private-password', therapistId: 'T043', passwordRevision: 1, passwordResetAt: 'yesterday', passwordResetBy: 'owner' });
  assert.equal(write.ref.id, 'staff'); assert.equal(write.data.therapistId, 'T043'); assert.equal(write.options.merge, true);
  for (const key of ['pw', 'passwordRevision', 'passwordResetAt', 'passwordResetBy']) assert.ok(!(key in write.data));
});
test('account reset and history buttons encode unusual IDs rather than injecting executable text', () => {
  const context = vm.createContext({ document: { addEventListener() {} }, esc: value => String(value).replace(/</g, '&lt;').replace(/>/g, '&gt;') });
  vm.runInContext(ui, context);
  const attack = "x');alert(1)//";
  for (const output of [context.accountResetButtonHtml('customer', attack), context.customerAccountHelpButtonHtml(attack, '連結')]) {
    assert.ok(!output.includes(attack)); assert.match(output, /%27/);
  }
});
