const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers/harness');

const { wallet } = h.svc;
beforeEach(() => h.reset());

test('credit then debit updates balance and writes ledger rows with balanceAfter', async () => {
  const u = h.mkUser('renter');
  await wallet.credit({ userId: u._id, amount: 1000, type: 'topup', idempotencyKey: 'a' });
  await wallet.debit({ userId: u._id, amount: 400, type: 'payout', idempotencyKey: 'b' });
  assert.deepEqual(await h.wallet(u), { balance: 600, pending: 0 });
  const { items } = await wallet.listTransactions(u._id);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((t) => [t.direction, t.amount, t.balanceAfter]).sort(), [
    ['credit', 1000, 1000],
    ['debit', 400, 600],
  ]);
});

test('the same idempotencyKey never applies twice', async () => {
  const u = h.mkUser('renter');
  const first = await wallet.credit({ userId: u._id, amount: 500, type: 'topup', idempotencyKey: 'dup' });
  const second = await wallet.credit({ userId: u._id, amount: 500, type: 'topup', idempotencyKey: 'dup' });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.deepEqual(await h.wallet(u), { balance: 500, pending: 0 });
  assert.equal((await wallet.listTransactions(u._id)).meta.total, 1);
});

test('a debit larger than the balance is refused and changes nothing', async () => {
  const u = h.mkUser('renter');
  await h.seedBalance(u, 1000);
  await h.expectErr(wallet.debit({ userId: u._id, amount: 1001, type: 'payout', idempotencyKey: 'x' }), 'INSUFFICIENT_FUNDS', 402);
  assert.deepEqual(await h.wallet(u), { balance: 1000, pending: 0 });
  assert.equal((await wallet.listTransactions(u._id)).meta.total, 1); // only the seed
});

test('a debit from an empty wallet is refused', async () => {
  const u = h.mkUser('renter');
  await h.expectErr(wallet.debit({ userId: u._id, amount: 1, type: 'payout', idempotencyKey: 'x' }), 'INSUFFICIENT_FUNDS');
});

test('non-integer, zero and negative amounts are rejected', async () => {
  const u = h.mkUser('renter');
  for (const amount of [10.5, 0, -5, '100', NaN]) {
    await h.expectErr(wallet.credit({ userId: u._id, amount, type: 'topup', idempotencyKey: `k${amount}` }), 'INVALID_AMOUNT', 400);
  }
  assert.deepEqual(await h.wallet(u), { balance: 0, pending: 0 });
});

test('pending and available buckets are independent', async () => {
  const u = h.mkUser('owner');
  await wallet.credit({ userId: u._id, amount: 700, bucket: 'pendingBalance', type: 'owner_earning', idempotencyKey: 'p' });
  await h.expectErr(wallet.debit({ userId: u._id, amount: 1, type: 'payout', idempotencyKey: 'q' }), 'INSUFFICIENT_FUNDS');
  assert.deepEqual(await h.wallet(u), { balance: 0, pending: 700 });
});

test('transaction history paginates newest first and can filter by type', async () => {
  const u = h.mkUser('renter');
  for (let i = 1; i <= 5; i++) await wallet.credit({ userId: u._id, amount: i * 100, type: 'topup', idempotencyKey: `t${i}` });
  await wallet.debit({ userId: u._id, amount: 50, type: 'payout', idempotencyKey: 'd' });
  const page1 = await wallet.listTransactions(u._id, { page: 1, limit: 4 });
  assert.equal(page1.items.length, 4);
  assert.deepEqual(page1.meta, { page: 1, limit: 4, total: 6, pages: 2 });
  assert.equal(page1.items[0].type, 'payout'); // newest first
  const page2 = await wallet.listTransactions(u._id, { page: 2, limit: 4 });
  assert.equal(page2.items.length, 2);
  const topups = await wallet.listTransactions(u._id, { type: 'topup' });
  assert.equal(topups.meta.total, 5);
});

test('wallets of different users never mix', async () => {
  const a = h.mkUser('renter');
  const b = h.mkUser('renter');
  await h.seedBalance(a, 900);
  assert.deepEqual(await h.wallet(b), { balance: 0, pending: 0 });
  assert.equal((await wallet.listTransactions(b._id)).meta.total, 0);
});
