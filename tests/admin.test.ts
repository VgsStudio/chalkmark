import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAdmin, summarize } from '../services/admin.ts';

test('isAdmin: só o grupo admin, no formato do API Gateway', () => {
  assert.equal(isAdmin({ 'cognito:groups': '[admin]' }), true);
  assert.equal(isAdmin({ 'cognito:groups': '[beta admin]' }), true);
  assert.equal(isAdmin({ 'cognito:groups': '[admins]' }), false);
  assert.equal(isAdmin({}), false);
  assert.equal(isAdmin(undefined), false);
});

test('summarize: último acesso, notificação e retenção por semana de cadastro', () => {
  const now = new Date('2026-11-16T12:00:00Z');
  const items = [
    { pk: 'USER#a', sk: 'PROFILE', handle: 'ana', name: 'Ana' },
    { pk: 'USER#a', sk: 'SETTINGS', lastSeenAt: '2026-11-15T10:00:00Z', pushOn: true },
    { pk: 'USER#a', sk: 'PUSH#1' }, { pk: 'USER#a', sk: 'PUSH#2' },
    { pk: 'USER#a', sk: 'SESSION#1', startedAt: '2026-10-20T10:00:00Z' },
    { pk: 'USER#a', sk: 'SESSION#2', startedAt: '2026-11-10T10:00:00Z' },
    { pk: 'USER#a', sk: 'CLIMB#1', result: 'sent', createdAt: '2026-11-10T10:05:00Z' },
    { pk: 'USER#b', sk: 'SESSION#1', startedAt: '2026-10-21T10:00:00Z' },
    { pk: 'USER#b', sk: 'SETTINGS', pushOn: false }, { pk: 'USER#b', sk: 'PUSH#1' },
    { pk: 'FEEDBACK', sk: '2026-11-01#a', stars: 5, comment: 'top', createdAt: '2026-11-01T00:00:00Z' },
    { pk: 'NOTIFY#10', sk: 'a' },
  ];
  const r = summarize(items, [{ sub: 'a', email: 'a@x', createdAt: '2026-10-20T09:00:00Z' }, { sub: 'b', createdAt: '2026-10-21T09:00:00Z' }], now);
  assert.equal(r.totals.users, 2);
  assert.equal(r.totals.active7, 1);
  assert.equal(r.totals.withPush, 1); // b desligou
  assert.equal(r.totals.devices, 3);
  const a = r.users[0];
  assert.equal(a.handle, 'ana');
  assert.equal(a.lastAccess, '2026-11-15T10:00:00Z');
  assert.equal(a.climbs, 1); assert.equal(a.sends, 1);
  assert.equal(r.retention.length, 1);
  assert.deepEqual(r.retention[0], { week: '2026-10-19', users: 2, w1: [1, 2], w2: [1, 2], w4: [0, 0] });
  assert.equal(r.feedback[0].sub, 'a');
});
