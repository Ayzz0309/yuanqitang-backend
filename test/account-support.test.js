'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createAccountSupportService, installAccountSupportRoutes } = require('../account-support-api');

const code = 'test-management-only';
const boss = { id: 'owner', password: 'test-boss-only' };
const employee = { id: 'angel0920', pw: 'old-employee-password', role: 'staff', name: '測試員工', therapistId: 'T043', cases: ['B1'] };
const customer = { id: 'C1', name: '測試客人', phone: '0912345678', pw: 'old-customer-password', isMember: true,
  coupons: [{ id: 'CP1', status: 'used' }], memberSince: '2026-01-01' };

class MemoryDb {
  constructor(records = {}) {
    this.records = new Map(Object.entries({
      'employees/owner': { ...boss, pw: boss.password, role: 'boss', name: '測試店長' },
      'employees/angel0920': employee, 'employees/manager': { pw: 'test-manager-only', role: 'manager' },
      'customers/C1': customer, 'customers/ONSITE': { name: '現場客人', phone: '0987654321' },
      'bookings/B1': { custId: 'C1', finalPrice: 800, status: 'done' }, ...records
    }).map(([key, value]) => [key, structuredClone(value)]));
    this.lock = Promise.resolve();
  }
  snap(path) { const value = this.records.get(path); return { id: path.split('/').pop(), exists: value !== undefined, data: () => structuredClone(value) }; }
  query(ref) {
    let docs = [...this.records.keys()].filter(path => path.startsWith(ref.name + '/'));
    if (ref.field) docs = docs.filter(path => this.records.get(path)[ref.field] === ref.value);
    if (ref.limitCount) docs = docs.slice(0, ref.limitCount);
    return { docs: docs.map(path => this.snap(path)) };
  }
  collection(name) {
    const db = this;
    const query = { name, query: true, get: async () => db.query(query),
      where(field, op, value) { assert.equal(op, '=='); return { ...query, field, value, limit(limitCount) { return { ...this, limitCount }; } }; },
      doc(id) { const path = name + '/' + id; return { id, path, get: async () => db.snap(path) }; }
    };
    return query;
  }
  async runTransaction(action) {
    const prior = this.lock; let release; this.lock = new Promise(resolve => { release = resolve; }); await prior;
    const writes = [];
    try {
      const result = await action({
        get: async ref => { assert.equal(writes.length, 0, 'Firestore reads precede writes'); return ref.query ? this.query(ref) : this.snap(ref.path); },
        update: (ref, data) => { assert.ok(this.records.has(ref.path)); writes.push([ref.path, { ...this.records.get(ref.path), ...structuredClone(data) }]); },
        set: (ref, data) => writes.push([ref.path, structuredClone(data)])
      });
      writes.forEach(([path, value]) => this.records.set(path, value)); return result;
    } finally { release(); }
  }
}
function fixture(records = {}, managementCode = code) {
  const db = new MemoryDb(records);
  return { db, service: createAccountSupportService({ db, managementCode, clock: () => Date.parse('2026-10-28T01:00:00Z') }) };
}
function resetInput(patch = {}) {
  return { kind: 'customer', targetId: 'C1', actor: boss, recoveryCode: code,
    password: 'new-test-password', passwordConfirm: 'new-test-password', ...patch };
}

test('employee login uses the current database credential, accepts full-width account text, and excludes secrets', async () => {
  const f = fixture();
  const result = await f.service.login({ kind: 'employee', account: ' ａｎｇｅｌ０９２０ ', password: employee.pw });
  assert.equal(result.account.id, employee.id); assert.equal(result.account.role, 'staff');
  assert.ok(!('pw' in result.account)); assert.ok(!JSON.stringify(result).includes(employee.pw));
  f.db.records.get('employees/angel0920').pw = 'fresh-only-password';
  await assert.rejects(f.service.login({ kind: 'employee', account: employee.id, password: employee.pw }), error => error.status === 401);
  assert.equal((await f.service.login({ kind: 'employee', account: employee.id, password: 'fresh-only-password' })).account.id, employee.id);
});
test('login normalizes customer phone formats, keeps password spaces significant, and never guesses between duplicate accounts', async () => {
  const f = fixture({ 'customers/C1': { ...customer, pw: ' padded password ' } });
  assert.equal((await f.service.login({ kind: 'customer', account: '+886 912-345-678', password: ' padded password ' })).account.id, 'C1');
  await assert.rejects(f.service.login({ kind: 'customer', account: customer.phone, password: 'padded password' }), error => error.status === 401);
  f.db.records.set('customers/C2', { ...customer, pw: 'other-password' });
  await assert.rejects(f.service.login({ kind: 'customer', account: customer.phone, password: ' padded password ' }), error => error.message === 'ACCOUNT_AMBIGUOUS');
});
test('registered old customers without phones can log in by unique name; history-only records cannot', async () => {
  const f = fixture({ 'customers/OLD': { name: '舊會員', pw: 'test-old-only' } });
  assert.equal((await f.service.login({ kind: 'customer', account: '舊會員', password: 'test-old-only' })).account.id, 'OLD');
  await assert.rejects(f.service.login({ kind: 'customer', account: '現場客人', password: 'anything' }), error => error.status === 401);
});
test('customer password reset preserves coupons, membership, bookings and receipts, invalidates the old password and audits no secrets', async () => {
  const f = fixture(), before = structuredClone(f.db.records.get('customers/C1'));
  const bookingBefore = structuredClone(f.db.records.get('bookings/B1'));
  const result = await f.service.reset(resetInput()); assert.equal(result.targetId, 'C1');
  const after = f.db.records.get('customers/C1');
  assert.deepEqual(after.coupons, before.coupons); assert.equal(after.memberSince, before.memberSince); assert.equal(after.isMember, true);
  assert.deepEqual(f.db.records.get('bookings/B1'), bookingBefore);
  await assert.rejects(f.service.login({ kind: 'customer', account: customer.phone, password: customer.pw }), error => error.status === 401);
  assert.equal((await f.service.login({ kind: 'customer', account: customer.phone, password: 'new-test-password' })).account.id, 'C1');
  const audit = [...f.db.records].find(([path]) => path.startsWith('accountResets/'))[1];
  assert.deepEqual(Object.keys(audit).sort(), ['at', 'byId', 'kind', 'revision', 'targetId']);
  for (const secret of [code, boss.password, customer.pw, 'new-test-password']) assert.ok(!JSON.stringify({ result, audit }).includes(secret));
});
test('staff reset fixes login without changing role, assigned therapist or case history', async () => {
  const f = fixture();
  await f.service.reset(resetInput({ kind: 'employee', targetId: employee.id }));
  const after = f.db.records.get('employees/' + employee.id);
  assert.equal(after.role, 'staff'); assert.equal(after.therapistId, employee.therapistId); assert.deepEqual(after.cases, employee.cases);
  assert.equal((await f.service.login({ kind: 'employee', account: employee.id, password: 'new-test-password' })).account.id, employee.id);
  await assert.rejects(f.service.login({ kind: 'employee', account: employee.id, password: employee.pw }), error => error.status === 401);
});
test('reset requires BOTH the live boss credential and the private management code; denied attempts write nothing', async () => {
  const f = fixture(), before = JSON.stringify([...f.db.records]);
  for (const patch of [
    { actor: undefined }, { actor: { id: 'owner', password: 'wrong' } },
    { actor: { id: 'manager', password: 'test-manager-only', role: 'boss' } },
    { actor: { id: employee.id, password: employee.pw } }, { recoveryCode: 'wrong' }, { recoveryCode: '' }
  ]) await assert.rejects(f.service.reset(resetInput(patch)), error => error.status === 403);
  assert.equal(JSON.stringify([...f.db.records]), before);
  const missing = fixture({}, ''); await assert.rejects(missing.service.reset(resetInput()), error => error.status === 503);
});
test('reset rejects malformed inputs, history-only data, nonexistent targets and boss accounts', async () => {
  const f = fixture(), before = JSON.stringify([...f.db.records]);
  for (const patch of [
    { kind: 'bookings' }, { targetId: '../C1' }, { password: 'short' }, { passwordConfirm: 'different' },
    { password: 'x'.repeat(129) }, { targetId: 'ONSITE' }, { targetId: 'MISSING' }, { kind: 'employee', targetId: 'owner' }
  ]) await assert.rejects(f.service.reset(resetInput(patch)), error => [400, 404, 409].includes(error.status));
  assert.equal(JSON.stringify([...f.db.records]), before);
});
test('boss recovery cannot turn an employee into boss, create a typo account or silently reset another existing boss', async () => {
  const f = fixture(), before = JSON.stringify([...f.db.records]);
  for (const employeeId of ['angell0920', employee.id, 'missing-owner']) {
    await assert.rejects(f.service.recoverBoss({ employeeId, recoveryCode: code, password: 'test-new-owner', passwordConfirm: 'test-new-owner' }), error => [404, 409].includes(error.status));
  }
  assert.equal(JSON.stringify([...f.db.records]), before);
  f.db.records.set('employees/owner2', { pw: 'other-boss-password', role: 'boss' });
  await assert.rejects(f.service.recoverBoss({ recoveryCode: code, password: 'test-new-owner', passwordConfirm: 'test-new-owner' }), error => error.message === 'BOSS_ID_REQUIRED');
});
test('boss recovery of a unique existing account requires confirmation and preserves its role', async () => {
  const f = fixture();
  await assert.rejects(f.service.recoverBoss({ recoveryCode: code, password: 'test-new-owner', passwordConfirm: 'mismatch' }), error => error.status === 400);
  const result = await f.service.recoverBoss({ recoveryCode: code, password: 'test-new-owner', passwordConfirm: 'test-new-owner' });
  assert.equal(result.bossId, 'owner'); assert.equal(result.created, false);
  assert.equal(f.db.records.get('employees/owner').role, 'boss');
  await assert.rejects(f.service.login({ kind: 'employee', account: 'owner', password: boss.password }), error => error.status === 401);
});
test('HTTP login, reset and recovery routes enforce permissions and suppress internal errors and password fields', async () => {
  const f = fixture(), app = express(); app.use(express.json());
  const pass = (req, res, next) => next();
  installAccountSupportRoutes({ app, service: f.service, loginLimiter: pass, adminLimiter: pass, recoveryLimiter: pass });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const post = (path, body) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const login = await post('/api/auth/login', { kind: 'employee', account: employee.id, password: employee.pw });
    assert.equal(login.status, 200); assert.equal(login.headers.get('cache-control'), 'no-store');
    const data = await login.json(); assert.equal(data.account.id, employee.id); assert.ok(!('pw' in data.account));
    const denied = await post('/api/admin/reset-account-password', resetInput({ recoveryCode: 'wrong' })); assert.equal(denied.status, 403);
    const ok = await post('/api/admin/reset-account-password', resetInput()); assert.equal(ok.status, 200);
    assert.ok(!JSON.stringify(await ok.json()).includes('new-test-password'));
    const recover = await post('/api/admin/reset-boss-password', { employeeId: employee.id, recoveryCode: code, password: 'test-new-owner', passwordConfirm: 'test-new-owner' });
    assert.equal(recover.status, 409);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
