const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers/harness');

const { payment: pay, deposit: dep, refund, payout } = h.svc;
const { Payment, Deposit } = h.models;
beforeEach(() => h.reset());

const bank = { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Ada Obi' };

/**
 * Where did every kobo the renter paid end up? Wallets (available + pending), money still held as a deposit,
 * the platform's commission (net of refunds) and payouts sent/queued. The sum must equal what the renter paid.
 */
async function accountFor(paymentId, { renter, owner }) {
  const p = await Payment.findById(paymentId);
  const d = await Deposit.findOne({ payment: p._id });
  const r = await h.wallet(renter);
  const o = await h.wallet(owner);
  const payouts = (await h.models.Payout.find({ owner: owner._id })).reduce((s, x) => (x.status === 'rejected' ? s : s + x.amount), 0);
  // a rejected payout was credited back to the wallet already, so it must not be counted twice
  return {
    paid: p.totalAmount,
    renterWallet: r.balance + r.pending,
    ownerWallet: o.balance + o.pending,
    heldDeposit: d && d.status === 'held' ? d.amount - d.deductedAmount - d.releasedAmount : 0,
    commission: p.commissionAmount - p.commissionReversed,
    payouts,
  };
}
const total = (a) => a.renterWallet + a.ownerWallet + a.heldDeposit + a.commission + a.payouts;

test('normal rental: pay, complete, deposit back, owner withdraws - every kobo accounted for', async () => {
  const renter = h.mkUser('renter');
  const owner = h.mkUser('owner');
  const admin = h.mkUser('admin');
  const booking = await h.mkBooking({ renter, owner });
  const payment = await h.payBooking(booking, renter);

  await pay.releaseEarnings(booking._id);
  const d = await Deposit.findOne({ payment: payment._id });
  await dep.confirmReturnAndRelease(d._id, owner);
  const po = await payout.requestPayout(owner, { amount: 4500000, ...bank });
  await payout.approvePayout(po._id, admin);
  await payout.markPayoutPaid(po._id, admin, { transferReference: 'TRF-1' });

  const a = await accountFor(payment._id, { renter, owner });
  assert.deepEqual(a, { paid: 7000000, renterWallet: 2000000, ownerWallet: 0, heldDeposit: 0, commission: 500000, payouts: 4500000 });
  assert.equal(total(a), a.paid);
});

test('damage claim: deposit split between owner and renter, nothing lost', async () => {
  const renter = h.mkUser('renter');
  const owner = h.mkUser('owner');
  const booking = await h.mkBooking({ renter, owner });
  const payment = await h.payBooking(booking, renter);
  const d = await Deposit.findOne({ payment: payment._id });
  const claimId = h.oid();
  await dep.lockForClaim(d._id, claimId);
  await dep.resolveClaim(d._id, { claimId, approvedAmount: 750000, reason: 'Broken handle' });
  await pay.releaseEarnings(booking._id);

  const a = await accountFor(payment._id, { renter, owner });
  assert.equal(a.renterWallet, 1250000);
  assert.equal(a.ownerWallet, 4500000 + 750000);
  assert.equal(total(a), a.paid);
});

test('cancellation 30h before start: refund, owner reversal and commission give-back balance out', async () => {
  const renter = h.mkUser('renter');
  const owner = h.mkUser('owner');
  const booking = await h.mkBooking({ renter, owner, startInHours: 30 });
  const payment = await h.payBooking(booking, renter);
  await h.cancelBooking(booking);
  await refund.refundCancelledBooking(booking._id, renter);

  const a = await accountFor(payment._id, { renter, owner });
  assert.deepEqual(a, { paid: 7000000, renterWallet: 4500000, ownerWallet: 2250000, heldDeposit: 0, commission: 250000, payouts: 0 });
  assert.equal(total(a), a.paid);
});

test('payout rejected: money is back in the wallet and still balances', async () => {
  const renter = h.mkUser('renter');
  const owner = h.mkUser('owner');
  const booking = await h.mkBooking({ renter, owner });
  const payment = await h.payBooking(booking, renter);
  await pay.releaseEarnings(booking._id);
  const po = await payout.requestPayout(owner, { amount: 1000000, ...bank });
  await payout.rejectPayout(po._id, h.mkUser('admin'), { reason: 'bad account' });
  const a = await accountFor(payment._id, { renter, owner });
  assert.equal(a.ownerWallet, 4500000);
  assert.equal(a.payouts, 0);
  assert.equal(total(a), a.paid);
});

// Small deterministic random generator so a failure can be replayed
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('200 random rentals (random prices, timings, cancellations, claims): money is never created or lost', async () => {
  const rand = rng(20261005);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const log = [];
  for (let i = 0; i < 200; i++) {
    const renter = h.mkUser('renter');
    const owner = h.mkUser('owner');
    const price = Math.round(rand() * 5000000) / 100 + 1; // up to ~₦50,000.00 with kobo
    const deposit = pick([0, 0, Math.round(rand() * price * 100) / 100]);
    const startInHours = Math.round(rand() * 200 - 30);
    const hours = 1 + Math.round(rand() * 120);
    const action = pick(['complete', 'complete-and-release', 'cancel', 'cancel-by-owner', 'claim', 'claim-zero', 'nothing']);
    const scenario = { i, price, deposit, startInHours, hours, action };
    log.push(scenario);
    try {
      const booking = await h.mkBooking({ renter, owner, price, deposit, startInHours, hours });
      const payment = await h.payBooking(booking, renter);
      const d = await Deposit.findOne({ payment: payment._id });

      if (action === 'complete' || action === 'complete-and-release') {
        await pay.releaseEarnings(booking._id);
        if (action === 'complete-and-release' && d) await dep.confirmReturnAndRelease(d._id, owner);
      } else if (action === 'cancel' || action === 'cancel-by-owner') {
        await h.cancelBooking(booking);
        await refund.refundCancelledBooking(booking._id, action === 'cancel' ? renter : owner);
      } else if ((action === 'claim' || action === 'claim-zero') && d) {
        const claimId = h.oid();
        await dep.lockForClaim(d._id, claimId);
        const approved = action === 'claim' ? Math.floor(rand() * (d.amount + 1)) : 0;
        await dep.resolveClaim(d._id, { claimId, approvedAmount: approved, reason: 'r' });
        await pay.releaseEarnings(booking._id);
      }

      const a = await accountFor(payment._id, { renter, owner });
      assert.equal(total(a), a.paid, `scenario ${JSON.stringify(scenario)} -> ${JSON.stringify(a)}`);
      for (const v of [a.renterWallet, a.ownerWallet, a.heldDeposit, a.commission]) assert.ok(v >= 0 && Number.isInteger(v), JSON.stringify(scenario));
    } catch (err) {
      err.message = `scenario ${JSON.stringify(scenario)}: ${err.message}`;
      throw err;
    }
  }
  assert.equal(log.length, 200);
});
