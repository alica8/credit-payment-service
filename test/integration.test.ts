import 'dotenv/config';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Database } from '../src/database';
import { LedgerService } from '../src/ledger.service';
import { PaymentProcessor } from '../src/processor';
import { QueueRuntime } from '../src/queue';
import { config } from '../src/config';
import { ConfirmChannel } from 'amqplib';

const db = new Database();
const ledger = new LedgerService(db);
const processor = new PaymentProcessor(db);
const users: string[] = [];
const marker = `test-${randomUUID()}`;
const key = () => `${marker}-${randomUUID()}`;

async function account(balance = '100') {
  const user = await ledger.createUser(marker);
  users.push(user.id);
  await ledger.credit(user.id, { amount: balance, reference: marker }, key());
  return user;
}
async function payment(userId: string, amount: string, reference = 'OK') {
  const result = await ledger.submit(
    { userId, amount, reference, description: 'integration' },
    key(),
  );
  const entry = result as { id: string };
  await db.paymentRequest.update({ where: { id: entry.id }, data: { status: 'QUEUED' } });
  return entry;
}
after(async () => {
  const ids = await db.paymentRequest.findMany({
    where: { userId: { in: users } },
    select: { id: true },
  });
  await db.$transaction([
    db.paymentEvent.deleteMany({ where: { paymentId: { in: ids.map((p) => p.id) } } }),
    db.transaction.deleteMany({ where: { userId: { in: users } } }),
    db.paymentRequest.deleteMany({ where: { userId: { in: users } } }),
    db.user.deleteMany({ where: { id: { in: users } } }),
  ]);
  await db.$disconnect();
});

test('concurrent different payments never overdraw the account', async () => {
  const user = await account();
  const requests = await Promise.all(Array.from({ length: 6 }, () => payment(user.id, '80')));
  await Promise.all(requests.map((p) => processor.process(p.id)));
  const states = await db.paymentRequest.findMany({ where: { userId: user.id } });
  assert.equal(states.filter((p) => p.status === 'SUCCEEDED').length, 1);
  assert.equal(
    states.filter(
      (p) => p.failureCode === 'INSUFFICIENT_FUNDS' && !p.retryable && p.nextAttemptAt === null,
    ).length,
    5,
  );
  assert.equal((await ledger.user(user.id)).balance, 20n);
  assert.equal(await db.transaction.count({ where: { userId: user.id, type: 'DEBIT' } }), 1);
});

test('duplicate worker deliveries produce exactly one debit', async () => {
  const user = await account();
  const p = await payment(user.id, '30');
  await Promise.all(Array.from({ length: 8 }, () => processor.process(p.id)));
  assert.equal((await ledger.user(user.id)).balance, 70n);
  assert.equal(await db.transaction.count({ where: { paymentId: p.id } }), 1);
  assert.equal((await ledger.payment(p.id)).attempts, 1);
});

test('concurrent API idempotency and credit idempotency', async () => {
  const user = await account();
  const creditKey = key();
  await Promise.all(
    Array.from({ length: 5 }, () =>
      ledger.credit(user.id, { amount: '20', reference: 'same' }, creditKey),
    ),
  );
  assert.equal((await ledger.user(user.id)).balance, 120n);
  await assert.rejects(
    ledger.credit(user.id, { amount: '21', reference: 'same' }, creditKey),
    /different credit data/,
  );
  const paymentKey = key();
  const body = { userId: user.id, amount: '20', reference: 'same', description: '' };
  const results = await Promise.all(
    Array.from({ length: 5 }, () => ledger.submit(body, paymentKey)),
  );
  assert.equal(new Set(results.map((p) => (p as { id: string }).id)).size, 1);
  await assert.rejects(
    ledger.submit({ ...body, amount: '21' }, paymentKey),
    /different payment data/,
  );
});

test('technical failure retries, business failure does not, max attempts is enforced', async () => {
  const user = await account();
  const transient = await payment(user.id, '20', 'RETRY-ONCE-test');
  await processor.process(transient.id);
  let state = await ledger.payment(transient.id);
  assert.equal(state.status, 'FAILED');
  assert.equal(state.attempts, 1);
  assert.ok(state.nextAttemptAt);
  assert.equal((await ledger.user(user.id)).balance, 100n);
  await db.paymentRequest.update({ where: { id: transient.id }, data: { status: 'QUEUED' } });
  await processor.process(transient.id);
  assert.equal((await ledger.payment(transient.id)).status, 'SUCCEEDED');
  assert.equal((await ledger.user(user.id)).balance, 80n);
  const permanent = await payment(user.id, '20', 'FAIL-test');
  for (let i = 0; i < config.maxAttempts; i++) {
    await db.paymentRequest.update({ where: { id: permanent.id }, data: { status: 'QUEUED' } });
    await processor.process(permanent.id);
  }
  state = await ledger.payment(permanent.id);
  assert.equal(state.status, 'FAILED');
  assert.equal(state.attempts, config.maxAttempts);
  assert.equal(state.nextAttemptAt, null);
  assert.equal((await ledger.user(user.id)).balance, 80n);
});

test('failure after balance UPDATE rolls back both debit and balance', async () => {
  const user = await account();
  const p = await payment(user.id, '20');
  // Install a narrowly scoped test trigger: a real PostgreSQL error occurs after the debit UPDATE.
  await db.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION test_reject_debit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.reference = 'ROLLBACK-${marker}' THEN RAISE EXCEPTION 'test rollback'; END IF; RETURN NEW; END $$`,
  );
  await db.$executeRawUnsafe(
    'CREATE TRIGGER test_reject_debit BEFORE INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION test_reject_debit()',
  );
  try {
    await db.paymentRequest.update({
      where: { id: p.id },
      data: { reference: `ROLLBACK-${marker}` },
    });
    await processor.process(p.id);
    assert.equal((await ledger.user(user.id)).balance, 100n);
    assert.equal(await db.transaction.count({ where: { paymentId: p.id } }), 0);
    assert.equal((await ledger.payment(p.id)).status, 'FAILED');
  } finally {
    await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_reject_debit ON transactions');
    await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_reject_debit()');
  }
});

test('dispatcher recovers a publish failure and stale queued request', async () => {
  const user = await account();
  const p = await payment(user.id, '10');
  const runtime = new QueueRuntime(db);
  const failedChannel = {
    sendToQueue: (_q: unknown, _b: unknown, _o: unknown, callback: (e: Error) => void) =>
      callback(new Error('test broker failure')),
  } as unknown as ConfirmChannel;
  await assert.rejects(runtime.dispatch(failedChannel), /test broker failure/);
  assert.equal((await ledger.payment(p.id)).status, 'QUEUED');
  await db.paymentRequest.update({ where: { id: p.id }, data: { lastPublishedAt: new Date(0) } });
  const published: string[] = [];
  const okChannel = {
    sendToQueue: (_q: unknown, body: Buffer, _o: unknown, callback: () => void) => {
      published.push(JSON.parse(body.toString()).paymentId);
      callback();
    },
  } as unknown as ConfirmChannel;
  await runtime.dispatch(okChannel);
  assert.ok(published.includes(p.id));
  await processor.process(p.id);
  assert.equal((await ledger.user(user.id)).balance, 90n);
});

test('usage reports include credits/debits and exclude failed payments', async () => {
  const user = await account('1000');
  const success = await payment(user.id, '300');
  const failure = await payment(user.id, '5000');
  await processor.process(success.id);
  await processor.process(failure.id);
  const query = {
    period: 'day' as const,
    from: new Date(Date.now() - 60000).toISOString(),
    to: new Date(Date.now() + 60000).toISOString(),
  };
  const usage = await ledger.usage(user.id, query);
  assert.equal(usage.credits, 1000n);
  assert.equal(usage.debits, 300n);
  assert.equal(usage.successfulPayments, 1);
  for (const period of ['day', 'month', 'year'] as const) {
    const report = await ledger.report({ ...query, period });
    assert.ok(report.totals.credits >= 1000n);
    assert.ok(report.totals.debits >= 300n);
  }
});

test('database constraints reject negative balances and duplicate debit records', async () => {
  const user = await account();
  await assert.rejects(db.user.update({ where: { id: user.id }, data: { balance: -1n } }));
  const p = await payment(user.id, '10');
  await processor.process(p.id);
  await assert.rejects(
    db.transaction.create({
      data: {
        userId: user.id,
        paymentId: p.id,
        type: 'DEBIT',
        amount: 10n,
        reference: 'duplicate',
      },
    }),
  );
});

test('UTC report boundaries include from, exclude to, and do not double count', async () => {
  const user = await account('100');
  const p = await payment(user.id, '30');
  await processor.process(p.id);
  const start = '2001-01-01T00:00:00.000Z';
  const boundary = '2001-02-01T00:00:00.000Z';
  await db.transaction.updateMany({
    where: { userId: user.id, type: 'CREDIT' },
    data: { createdAt: new Date(start) },
  });
  await db.transaction.updateMany({
    where: { userId: user.id, type: 'DEBIT' },
    data: { createdAt: new Date(boundary) },
  });
  const january = await ledger.report({ period: 'month', from: start, to: boundary });
  const february = await ledger.report({
    period: 'month',
    from: boundary,
    to: '2001-03-01T00:00:00.000Z',
  });
  assert.deepEqual(january.totals, { credits: 100n, debits: 0n });
  assert.deepEqual(february.totals, { credits: 0n, debits: 30n });
  await assert.rejects(
    ledger.report({ period: 'day', from: boundary, to: start }),
    /from must be before to/,
  );
});
