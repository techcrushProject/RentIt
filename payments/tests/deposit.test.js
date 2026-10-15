const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers/harness');

const { deposit: dep, wallet } = h.svc;
const { Deposit } = h.models;
beforeEach(() => h.reset());

// A paid booking with the deposit held. Returns everything a test needs.
const paid = async (opts = {}) => {
  const renter = h.mkUser('renter');
  const owner = h.mkUser('owner');
  const booking = await h.mkBooking({ renter, owner, ...opts });
  const payment = await h.payBooking(booking, renter);
  const deposit = await Deposit.findOne({ payment: payment._id });
  return { renter, owner, booking, payment, deposit };
};

test('a paid booking holds the deposit', async () => {
  const { deposit } = await paid();
  assert.equal(deposit.status, 'held');
  assert.equal(deposit.amount, 2000000);
  assert.equal(deposit.claimLock.locked, false);
});

test('owner confirming the return sends the whole deposit to the renter', async () => {
  const { renter, owner, deposit } = await paid();
  const d = await dep.confirmReturnAndRelease(deposit._id, owner);
  assert.equal(d.status, 'released');
  assert.equal(d.releasedAmount, 2000000);
  assert.deepEqual(await h.wallet(renter), { balance: 2000000, pending: 0 });
  assert.deepEqual(await h.wallet(owner), { balance: 0, pending: 4500000 }); // earnings untouched
});

test('a deposit can only be settled once', async () => {
  const { renter, owner, deposit } = await paid();
  await dep.confirmReturnAndRelease(deposit._id, owner);
  await h.expectErr(dep.confirmReturnAndRelease(deposit._id, owner), 'DEPOSIT_NOT_HELD', 409);
  await h.expectErr(dep.settleDeposit(deposit._id, { deductionAmount: 100 }), 'DEPOSIT_NOT_HELD', 409);
  assert.deepEqual(await h.wallet(renter), { balance: 2000000, pending: 0 });
});

test('the renter and strangers cannot release a deposit, an admin can', async () => {
  const { renter, deposit } = await paid();
  await h.expectErr(dep.confirmReturnAndRelease(deposit._id, renter), 'FORBIDDEN', 403);
  await h.expectErr(dep.confirmReturnAndRelease(deposit._id, h.mkUser('owner')), 'FORBIDDEN', 403);
  assert.equal((await dep.confirmReturnAndRelease(deposit._id, h.mkUser('admin'))).status, 'released');
});

test('deposit details are visible to the renter, owner and admin only', async () => {
  const { renter, owner, booking, deposit } = await paid();
  assert.equal((await dep.getDeposit(deposit._id, renter)).amount, 2000000);
  assert.equal((await dep.getDepositByBooking(booking._id, owner)).amount, 2000000);
  assert.equal((await dep.getDeposit(deposit._id, h.mkUser('admin'))).amount, 2000000);
  await h.expectErr(dep.getDeposit(deposit._id, h.mkUser('renter')), 'FORBIDDEN', 403);
  await h.expectErr(dep.getDepositByBooking(h.oid(), renter), 'DEPOSIT_NOT_FOUND', 404);
});

/* ------------------------------ damage claims ------------------------------ */

test('an open claim locks the deposit: no manual or automatic release', async () => {
  const { renter, owner, deposit } = await paid({ startInHours: -100, hours: 50 }); // already past its release time
  const claimId = h.oid();
  await dep.lockForClaim(deposit._id, claimId);
  await h.expectErr(dep.confirmReturnAndRelease(deposit._id, owner), 'DEPOSIT_LOCKED_BY_CLAIM', 409);
  assert.deepEqual(await dep.releaseDueDeposits(), { released: 0, failed: 0 });
  assert.deepEqual(await h.wallet(renter), { balance: 0, pending: 0 });
});

test('a second claim cannot lock a deposit another claim holds', async () => {
  const { deposit } = await paid();
  await dep.lockForClaim(deposit._id, h.oid());
  await h.expectErr(dep.lockForClaim(deposit._id, h.oid()), 'DEPOSIT_NOT_LOCKABLE', 409);
});

test('dropping a claim unlocks the deposit so it can be released normally', async () => {
  const { renter, owner, deposit } = await paid();
  const claimId = h.oid();
  await dep.lockForClaim(deposit._id, claimId);
  await h.expectErr(dep.unlockClaim(deposit._id, h.oid()), 'DEPOSIT_NOT_LOCKED', 409); // wrong claim
  await dep.unlockClaim(deposit._id, claimId);
  await dep.confirmReturnAndRelease(deposit._id, owner);
  assert.deepEqual(await h.wallet(renter), { balance: 2000000, pending: 0 });
});

test('a partial damage deduction pays the owner and returns the rest to the renter', async () => {
  const { renter, owner, deposit } = await paid();
  const claimId = h.oid();
  await dep.lockForClaim(deposit._id, claimId);
  const d = await dep.resolveClaim(deposit._id, { claimId, approvedAmount: 300000, reason: 'Cracked housing' });
  assert.equal(d.status, 'partially_deducted');
  assert.equal(d.deductedAmount, 300000);
  assert.equal(d.releasedAmount, 1700000);
  assert.equal(d.claimLock.locked, false);
  assert.equal(d.deductions.length, 1);
  assert.equal(d.deductions[0].reason, 'Cracked housing');
  assert.deepEqual(await h.wallet(renter), { balance: 1700000, pending: 0 });
  assert.deepEqual(await h.wallet(owner), { balance: 300000, pending: 4500000 });
});

test('resolving the same claim twice does not pay twice', async () => {
  const { renter, owner, deposit } = await paid();
  const claimId = h.oid();
  await dep.lockForClaim(deposit._id, claimId);
  await dep.resolveClaim(deposit._id, { claimId, approvedAmount: 300000, reason: 'x' });
  const again = await dep.resolveClaim(deposit._id, { claimId, approvedAmount: 300000, reason: 'x' });
  assert.equal(again.status, 'partially_deducted');
  assert.deepEqual(await h.wallet(renter), { balance: 1700000, pending: 0 });
  assert.equal((await h.wallet(owner)).balance, 300000);
});

test('deducting the whole deposit forfeits it to the owner and credits the renter nothing', async () => {
  const { renter, owner, deposit } = await paid();
  const claimId = h.oid();
  await dep.lockForClaim(deposit._id, claimId);
  const d = await dep.resolveClaim(deposit._id, { claimId, approvedAmount: 2000000, reason: 'Total loss' });
  assert.equal(d.status, 'forfeited');
  assert.deepEqual(await h.wallet(renter), { balance: 0, pending: 0 });
  assert.equal((await h.wallet(owner)).balance, 2000000);
  assert.equal((await wallet.listTransactions(renter._id)).meta.total, 0);
});

test('an approved amount of zero releases the full deposit', async () => {
  const { renter, deposit } = await paid();
  const claimId = h.oid();
  await dep.lockForClaim(deposit._id, claimId);
  const d = await dep.resolveClaim(deposit._id, { claimId, approvedAmount: 0 });
  assert.equal(d.status, 'released');
  assert.deepEqual(await h.wallet(renter), { balance: 2000000, pending: 0 });
});

test('deductions larger than the deposit, negative or fractional are refused with nothing moved', async () => {
  const { renter, owner, deposit } = await paid();
  await h.expectErr(dep.settleDeposit(deposit._id, { deductionAmount: 2000001 }), 'DEDUCTION_TOO_HIGH', 400);
  await h.expectErr(dep.settleDeposit(deposit._id, { deductionAmount: -1 }), 'INVALID_AMOUNT', 400);
  await h.expectErr(dep.settleDeposit(deposit._id, { deductionAmount: 10.5 }), 'INVALID_AMOUNT', 400);
  assert.equal((await Deposit.findById(deposit._id)).status, 'held');
  assert.deepEqual(await h.wallet(renter), { balance: 0, pending: 0 });
  assert.equal((await h.wallet(owner)).balance, 0);
});

test('an admin manual deduction (no claim id) works', async () => {
  const { renter, owner, deposit } = await paid();
  const d = await dep.settleDeposit(deposit._id, { deductionAmount: 500000, reason: 'Late return fee' });
  assert.equal(d.status, 'partially_deducted');
  assert.equal((await h.wallet(owner)).balance, 500000);
  assert.equal((await h.wallet(renter)).balance, 1500000);
});

test('a claim cannot be resolved by a different claim while locked', async () => {
  const { deposit } = await paid();
  await dep.lockForClaim(deposit._id, h.oid());
  await h.expectErr(dep.resolveClaim(deposit._id, { claimId: h.oid(), approvedAmount: 100 }), 'DEPOSIT_LOCKED_BY_CLAIM', 409);
});

/* ------------------------------ auto release ------------------------------ */

test('unclaimed deposits are released automatically once due, not before', async () => {
  const past = await paid({ startInHours: -100, hours: 50 }); // ended 50h ago -> due 2h ago
  const future = await paid({ startInHours: 24, hours: 24 }); // ends in 48h -> due in 96h
  const result = await dep.releaseDueDeposits();
  assert.deepEqual(result, { released: 1, failed: 0 });
  assert.equal((await Deposit.findById(past.deposit._id)).status, 'released');
  assert.equal((await Deposit.findById(future.deposit._id)).status, 'held');
  assert.deepEqual(await h.wallet(past.renter), { balance: 2000000, pending: 0 });
  assert.deepEqual(await h.wallet(future.renter), { balance: 0, pending: 0 });
  assert.deepEqual(await dep.releaseDueDeposits(), { released: 0, failed: 0 }); // running again is harmless
});

test('the scheduler can be started without keeping the process alive', () => {
  const t = dep.startDepositScheduler(60000);
  assert.ok(t);
  clearInterval(t);
});
