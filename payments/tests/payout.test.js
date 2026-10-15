const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers/harness');

const { payout, wallet } = h.svc;
const { Payout } = h.models;
beforeEach(() => h.reset());

const bank = { bankName: 'GTBank', bankCode: '058', accountNumber: '0123456789', accountName: 'Ada Obi' };
const richOwner = async (amount = 5000000) => {
  const owner = h.mkUser('owner');
  await h.seedBalance(owner, amount);
  return owner;
};

test('requesting a payout takes the money out of the wallet straight away', async () => {
  const owner = await richOwner(5000000);
  const po = await payout.requestPayout(owner, { amount: 2000000, ...bank });
  assert.equal(po.status, 'requested');
  assert.equal(po.amount, 2000000);
  assert.deepEqual(await h.wallet(owner), { balance: 3000000, pending: 0 });
  const rows = (await wallet.listTransactions(owner._id, { type: 'payout' })).items;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].direction, 'debit');
});

test('account numbers are masked whenever a payout is serialised', async () => {
  const owner = await richOwner();
  const po = await payout.requestPayout(owner, { amount: 1000000, ...bank });
  const json = JSON.parse(JSON.stringify(po));
  assert.equal(json.bank.accountNumber, '******6789');
  const stored = await Payout.findById(po._id);
  assert.equal(stored.bank.accountNumber, '0123456789'); // admin still has the real number in the database
  const listed = JSON.parse(JSON.stringify((await payout.listPayouts(owner)).items));
  assert.equal(listed[0].bank.accountNumber, '******6789');
});

test('amount below the minimum, fractional, or bad bank details are refused with the wallet untouched', async () => {
  const owner = await richOwner();
  await h.expectErr(payout.requestPayout(owner, { amount: 99999, ...bank }), 'INVALID_AMOUNT', 400);
  await h.expectErr(payout.requestPayout(owner, { amount: 150000.5, ...bank }), 'INVALID_AMOUNT', 400);
  await h.expectErr(payout.requestPayout(owner, { amount: 200000, bankName: 'GTBank' }), 'INVALID_BANK_DETAILS', 400);
  await h.expectErr(payout.requestPayout(owner, { amount: 200000, ...bank, accountNumber: '12345' }), 'INVALID_BANK_DETAILS', 400);
  await h.expectErr(payout.requestPayout(owner, { amount: 200000, ...bank, accountNumber: '01234abcde' }), 'INVALID_BANK_DETAILS', 400);
  assert.deepEqual(await h.wallet(owner), { balance: 5000000, pending: 0 });
  assert.equal(await Payout.countDocuments({}), 0);
});

test('cannot withdraw more than the available balance, and pending earnings do not count', async () => {
  const owner = h.mkUser('owner');
  await wallet.credit({ userId: owner._id, amount: 9000000, bucket: 'pendingBalance', type: 'owner_earning', idempotencyKey: 'p' });
  await h.seedBalance(owner, 300000);
  await h.expectErr(payout.requestPayout(owner, { amount: 300001, ...bank }), 'INSUFFICIENT_FUNDS', 402);
  assert.equal(await Payout.countDocuments({}), 0);
  assert.deepEqual(await h.wallet(owner), { balance: 300000, pending: 9000000 });
});

test('if saving the payout fails after the wallet was debited, the debit is rolled back', async () => {
  const owner = await richOwner(5000000);
  const original = Payout.create;
  Payout.create = async () => {
    throw new Error('database write failed');
  };
  try {
    await assert.rejects(payout.requestPayout(owner, { amount: 2000000, ...bank }), /database write failed/);
  } finally {
    Payout.create = original;
  }
  assert.deepEqual(await h.wallet(owner), { balance: 5000000, pending: 0 });
  assert.equal((await wallet.listTransactions(owner._id)).meta.total, 1); // only the seed, no orphan debit row
});

test('admin approves then marks paid with a transfer reference', async () => {
  const owner = await richOwner();
  const admin = h.mkUser('admin');
  const po = await payout.requestPayout(owner, { amount: 2000000, ...bank });
  const approved = await payout.approvePayout(po._id, admin);
  assert.equal(approved.status, 'approved');
  assert.ok(approved.approvedAt);
  await h.expectErr(payout.markPayoutPaid(po._id, admin, {}), 'INVALID_INPUT', 400);
  const paid = await payout.markPayoutPaid(po._id, admin, { transferReference: 'TRF-123' });
  assert.equal(paid.status, 'paid');
  assert.equal(paid.transferReference, 'TRF-123');
  assert.ok(paid.paidAt);
  assert.deepEqual(await h.wallet(owner), { balance: 3000000, pending: 0 }); // money stays gone
});

test('marking paid directly from requested is allowed', async () => {
  const owner = await richOwner();
  const po = await payout.requestPayout(owner, { amount: 1000000, ...bank });
  assert.equal((await payout.markPayoutPaid(po._id, h.mkUser('admin'), { transferReference: 'T' })).status, 'paid');
});

test('rejecting a payout returns the money to the wallet', async () => {
  const owner = await richOwner(5000000);
  const admin = h.mkUser('admin');
  const po = await payout.requestPayout(owner, { amount: 2000000, ...bank });
  await h.expectErr(payout.rejectPayout(po._id, admin, {}), 'INVALID_INPUT', 400);
  const rej = await payout.rejectPayout(po._id, admin, { reason: 'Name mismatch' });
  assert.equal(rej.status, 'rejected');
  assert.equal(rej.rejectionReason, 'Name mismatch');
  assert.deepEqual(await h.wallet(owner), { balance: 5000000, pending: 0 });
});

test('payouts cannot move backwards or be decided twice', async () => {
  const owner = await richOwner(9000000);
  const admin = h.mkUser('admin');
  const a = await payout.requestPayout(owner, { amount: 1000000, ...bank });
  await payout.markPayoutPaid(a._id, admin, { transferReference: 'T1' });
  await h.expectErr(payout.rejectPayout(a._id, admin, { reason: 'late' }), 'INVALID_STATE', 409); // would refund money already sent
  await h.expectErr(payout.approvePayout(a._id, admin), 'INVALID_STATE', 409);
  await h.expectErr(payout.markPayoutPaid(a._id, admin, { transferReference: 'T2' }), 'INVALID_STATE', 409);

  const b = await payout.requestPayout(owner, { amount: 1000000, ...bank });
  await payout.rejectPayout(b._id, admin, { reason: 'x' });
  await h.expectErr(payout.rejectPayout(b._id, admin, { reason: 'x' }), 'INVALID_STATE', 409); // no double refund
  await h.expectErr(payout.markPayoutPaid(b._id, admin, { transferReference: 'T3' }), 'INVALID_STATE', 409);
  await h.expectErr(payout.approvePayout(h.oid(), admin), 'PAYOUT_NOT_FOUND', 404);
  assert.equal((await h.wallet(owner)).balance, 9000000 - 1000000); // only payout A is gone
});

test('owners see only their own payouts, admins see all', async () => {
  const a = await richOwner();
  const b = await richOwner();
  const pa = await payout.requestPayout(a, { amount: 1000000, ...bank });
  await payout.requestPayout(b, { amount: 1000000, ...bank });
  assert.equal((await payout.listPayouts(a)).meta.total, 1);
  assert.equal((await payout.listPayouts(h.mkUser('admin'))).meta.total, 2);
  assert.equal((await payout.listPayouts(h.mkUser('admin'), { status: 'paid' })).meta.total, 0);
  assert.equal((await payout.getPayout(pa._id, a)).amount, 1000000);
  await h.expectErr(payout.getPayout(pa._id, b), 'FORBIDDEN', 403);
  assert.equal((await payout.getPayout(pa._id, h.mkUser('Admin'))).amount, 1000000);
});
