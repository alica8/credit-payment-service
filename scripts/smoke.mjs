import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.BASE_URL || 'http://localhost:3000';
const apiKey = process.env.API_KEY;
if (!apiKey) throw new Error('Set API_KEY or copy .env.example to .env');
const prefix = `smoke-${randomUUID()}`;
async function request(path, { method = 'GET', body, key, expected = 200 } = {}) {
  const response = await fetch(base + '/api/' + path, {
    method,
    headers: {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  assert.equal(response.status, expected, JSON.stringify(result));
  return result;
}
async function wait(id) {
  const until = Date.now() + 45000;
  while (Date.now() < until) {
    const p = await request('payments/' + id);
    if (p.status === 'SUCCEEDED' || (p.status === 'FAILED' && !p.nextAttemptAt)) return p;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Timed out waiting for ' + id);
}
const unauth = await fetch(base + '/api/users');
assert.equal(unauth.status, 401);
const user = await request('users', { method: 'POST', body: { name: prefix }, expected: 201 });
await request(`users/${user.id}/credits`, {
  method: 'POST',
  body: { amount: '1000', reference: prefix },
  key: prefix + '-credit',
  expected: 201,
});
const submit = (amount, reference, key = reference) =>
  request('payments', {
    method: 'POST',
    body: { userId: user.id, amount, reference, description: 'End-to-end smoke test' },
    key,
    expected: 202,
  });
const first = await submit('300', prefix + '-ok');
const duplicate = await submit('300', prefix + '-ok');
assert.equal(first.id, duplicate.id);
await request('payments', {
  method: 'POST',
  body: {
    userId: user.id,
    amount: '301',
    reference: prefix + '-ok',
    description: 'End-to-end smoke test',
  },
  key: prefix + '-ok',
  expected: 409,
});
assert.equal((await wait(first.id)).status, 'SUCCEEDED');
const transient = await submit('100', 'RETRY-ONCE-' + prefix);
const insufficient = await submit('9999', prefix + '-insufficient');
const forced = await submit('50', 'FAIL-' + prefix);
const [retried, noFunds, failed] = await Promise.all([
  wait(transient.id),
  wait(insufficient.id),
  wait(forced.id),
]);
assert.equal(retried.status, 'SUCCEEDED');
assert.equal(retried.attempts, 2);
assert.equal(noFunds.failureCode, 'INSUFFICIENT_FUNDS');
assert.equal(noFunds.attempts, 1);
assert.equal(failed.status, 'FAILED');
assert.equal(failed.attempts, Number(process.env.MAX_ATTEMPTS || 3));
const balance = await request(`users/${user.id}/balance`);
assert.equal(balance.balance, '600');
const events = await request(`payments/${transient.id}/events`);
assert.ok(events.items.some((e) => e.type === 'RETRY_TRIGGERED'));
await request('payments', {
  method: 'POST',
  body: { userId: user.id, amount: '-1', reference: 'invalid', description: '' },
  key: prefix + '-invalid',
  expected: 400,
});
const report = await request('admin/reports?period=month');
assert.ok(BigInt(report.totals.debits) >= 400n);
console.log(
  JSON.stringify(
    {
      status: 'PASS',
      userId: user.id,
      balance: balance.balance,
      success: first.id,
      retried: transient.id,
      insufficient: insufficient.id,
      forced: forced.id,
    },
    null,
    2,
  ),
);
console.log('Smoke data is intentionally retained for inspection in /admin/.');
