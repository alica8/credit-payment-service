import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PaymentDto } from '../src/dto';
import { failureProbability, retryDelay, simulateFailure } from '../src/policy';
import { jsonSafe } from '../src/database';
import { idempotencyKey } from '../src/ledger.service';

test('failure probability increases with amount and is capped', () => {
  assert.ok(failureProbability(100n, 100000) < failureProbability(10000n, 100000));
  assert.equal(failureProbability(1000000n, 100000), 0.5);
  assert.equal(
    simulateFailure('invoice', 100000n, 1, { enabled: true, scale: 100000 }, () => 0.1)?.retryable,
    true,
  );
  assert.equal(
    simulateFailure('invoice', 100000n, 1, { enabled: false, scale: 100000 }, () => 0),
    null,
  );
});
test('forced failure and transient fixture are deterministic', () => {
  assert.equal(
    simulateFailure('INV-fail-1', 1n, 3, { enabled: false, scale: 100000 })?.code,
    'SIMULATED_TECHNICAL',
  );
  assert.ok(simulateFailure('RETRY-ONCE-demo', 1n, 1, { enabled: false, scale: 100000 }));
  assert.equal(simulateFailure('RETRY-ONCE-demo', 1n, 2, { enabled: false, scale: 100000 }), null);
  assert.deepEqual(
    [1, 2, 3, 50].map((a) => retryDelay(a, 1000)),
    [1000, 2000, 4000, 60000],
  );
});
test('money remains exact during JSON serialization', () => {
  assert.deepEqual(jsonSafe({ balance: 9007199254740993n }), { balance: '9007199254740993' });
});
test('amount validation rejects floats, signed, numeric and oversized values', async () => {
  for (const amount of ['0', '-1', '1.5', '01', '1000000000000000', 100, '1e3']) {
    const dto = plainToInstance(PaymentDto, {
      amount,
      reference: 'INV',
      description: '',
      userId: '11111111-1111-4111-8111-111111111111',
    });
    assert.ok((await validate(dto)).some((e) => e.property === 'amount'));
  }
  const valid = plainToInstance(PaymentDto, {
    amount: '300',
    reference: 'INV',
    description: '',
    userId: '11111111-1111-4111-8111-111111111111',
  });
  assert.equal((await validate(valid)).length, 0);
});
test('idempotency key is bounded and required', () => {
  for (const key of [undefined, '', 'has space', 'x'.repeat(101)])
    assert.throws(() => idempotencyKey(key));
  assert.equal(idempotencyKey('invoice:001'), 'invoice:001');
});
