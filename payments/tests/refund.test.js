const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers/harness');

const { refund, payment: pay, deposit: dep, payout } = h.svc;
const { Payment, Deposit, Refund } = h.models;
beforeEach(() => h.reset());

// Paid booking (₦50,000 rental + ₦20,000 deposit) that starts `startInHours` from now.
const paid = async (startInHours = 72, opts = {}) => {
  const renter = h.mkUser('renter');
  const owner = h.mkUser('owner');
  const booking = await h.mkBooking({ renter, owner, startInHours, ...opts });
  const payment = await h.payBooking(booking, renter);
  return { renter, owner, booking, payment };
};

test('renter cancels 72h ahead: everything comes back, the owner earns nothing', async () => {
  const { renter, owner, booking, payment } = await paid(72);
  await h.cancelBooking(booking);
  const r = await refund.refundCancelledBooking(booking._id, renter);
  assert.equal(r.status, 'processed');
  assert.equal(r.cancelledBy, 'renter');
  assert.equal(r.destination, 'wallet');
  assert.equal(r.rentalRefund, 5000000);
  assert.equal(r.depositRefund, 2000000);
  assert.equal(r.amount, 7000000);

  assert.deepEqual(await h.wallet(renter), { balance: 7000000, pending: 0 });
  assert.deepEqual(await h.wallet(owner), { balance: 0, pending: 0 });
  const p = await Payment.findById(payment._id);
  assert.equal(p.status, 'refunded');
  assert.equal(p.refundedAmount, 7000000);
  assert.equal(p.ownerEarningReversed, 4500000);
  assert.equal((await Deposit.findOne({ payment: payment._id })).status, 'released');
  assert.equal((await h.getBooking(booking)).paymentStatus, 'refunded');
});

test('renter cancels 30h ahead: half the rental plus the full deposit', async () => {
  const { renter, owner, booking, payment } = await paid(30);
  await h.cancelBooking(booking);
  const r = await refund.refundCancelledBooking(booking._id, renter);
  assert.equal(r.rentalRefund, 2500000);
  assert.equal(r.depositRefund, 2000000);
  assert.equal(r.amount, 4500000);
  assert.equal(r.ownerEarningReversal, 2250000);
  assert.equal(r.commissionReversal, 250000);
  assert.deepEqual(await h.wallet(renter), { balance: 4500000, pending: 0 });
  assert.deepEqual(await h.wallet(owner), { balance: 0, pending: 2250000 });
  assert.equal((await Payment.findById(payment._id)).status, 'partially_refunded');
});

test('renter cancels 5h ahead: only the deposit comes back, the owner keeps the full earning', async () => {
  const { renter, owner, booking, payment } = await paid(5);
  await h.cancelBooking(booking);
  const r = await refund.refundCancelledBooking(booking._id, renter);
  assert.equal(r.rentalRefund, 0);
  assert.equal(r.amount, 2000000);
  assert.deepEqual(await h.wallet(renter), { balance: 2000000, pending: 0 });
  assert.deepEqual(await h.wallet(owner), { balance: 0, pending: 4500000 });
  assert.equal((await Payment.findById(payment._id)).status, 'partially_refunded');
});

test('owner or admin cancelling late still gives the renter everything back', async () => {
  for (const who of ['owner', 'admin']) {
    h.reset();
    const { renter, owner, booking } = await paid(2);
    await h.cancelBooking(booking);
    const actor = who === 'owner' ? owner : h.mkUser('admin');
    const r = await refund.refundCancelledBooking(booking._id, actor);
    assert.equal(r.cancelledBy, who);
    assert.equal(r.amount, 7000000);
    assert.deepEqual(await h.wallet(renter), { balance: 7000000, pending: 0 });
    assert.deepEqual(await h.wallet(owner), { balance: 0, pending: 0 });
  }
});

test('cancelling after the rental has started refunds nothing and leaves the payment untouched', async () => {
  const { renter, owner, booking, payment } = await paid(-1, { hours: 24 });
  await h.cancelBooking(booking);
  const r = await refund.refundCancelledBooking(booking._id, renter);
  assert.equal(r.amount, 0);
  assert.deepEqual(await h.wallet(renter), { balance: 0, pending: 0 });
  assert.deepEqual(await h.wallet(owner), { balance: 0, pending: 4500000 });
  const p = await Payment.findById(payment._id);
  assert.equal(p.status, 'succeeded');
  assert.equal(p.refundedAmount, 0);
  assert.equal((await h.getBooking(booking)).paymentStatus, 'paid');
  assert.equal((await Deposit.findOne({ payment: payment._id })).status, 'held');
});

test('asking for the refund twice returns the same refund and pays once', async () => {
  const { renter, booking } = await paid(72);
  await h.cancelBooking(booking);
  const a = await refund.refundCancelledBooking(booking._id, renter);
  const b = await refund.refundCancelledBooking(booking._id, renter);
  assert.equal(String(a._id), String(b._id));
  assert.equal(await Refund.countDocuments({}), 1);
  assert.deepEqual(await h.wallet(renter), { balance: 7000000, pending: 0 });
});

test('both parties refunding at the same moment still pays once', async () => {
  const { renter, owner, booking } = await paid(72);
  await h.cancelBooking(booking);
  const results = await Promise.allSettled([
    refund.refundCancelledBooking(booking._id, renter),
    refund.refundCancelledBooking(booking._id, owner),
  ]);
  assert.ok(results.some((r) => r.status === 'fulfilled'));
  assert.deepEqual(await h.wallet(renter), { balance: 7000000, pending: 0 });
  assert.equal(await Refund.countDocuments({}), 1);
});

test('refund is refused unless the booking is cancelled, and for strangers', async () => {
  const { renter, booking } = await paid(72);
  await h.expectErr(refund.refundCancelledBooking(booking._id, renter), 'BOOKING_NOT_CANCELLED', 409);
  await h.cancelBooking(booking);
  await h.expectErr(refund.refundCancelledBooking(booking._id, h.mkUser('renter')), 'FORBIDDEN', 403);
  await h.expectErr(refund.refundCancelledBooking(booking._id, renter, { destination: 'bitcoin' }), 'INVALID_DESTINATION', 400);
});

test('a cancelled booking that was never paid has nothing to refund', async () => {
  const renter = h.mkUser('renter');
  const booking = await h.mkBooking({ renter, owner: h.mkUser('owner'), status: 'cancelled' });
  await h.expectErr(refund.refundCancelledBooking(booking._id, renter), 'PAYMENT_NOT_FOUND', 404);
});

test('refund to the original card stays pending until an admin processes it', async () => {
  const { renter, owner, booking } = await paid(72);
  await h.cancelBooking(booking);
  const r = await refund.refundCancelledBooking(booking._id, renter, { destination: 'original' });
  assert.equal(r.status, 'pending');
  assert.equal(r.destination, 'original');
  assert.deepEqual(await h.wallet(renter), { balance: 0, pending: 0 });
  assert.deepEqual(await h.wallet(owner), { balance: 0, pending: 0 }); // earning already reversed

  const done = await refund.processGatewayRefund(r._id, h.mkUser('admin'));
  assert.equal(done.status, 'processed');
  assert.match(done.providerReference, /demo-refund/);
  assert.deepEqual(await h.wallet(renter), { balance: 0, pending: 0 }); // money went to the card, not the wallet
  const again = await refund.processGatewayRefund(r._id, h.mkUser('admin'));
  assert.equal(again.status, 'processed');
});

test('a gateway failure marks the refund failed and it can be retried', async () => {
  const { renter, booking } = await paid(72);
  await h.cancelBooking(booking);
  const r = await refund.refundCancelledBooking(booking._id, renter, { destination: 'original' });
  const original = h.gateway.refund;
  h.gateway.refund = async () => {
    throw new Error('bank unavailable');
  };
  try {
    const failed = await refund.processGatewayRefund(r._id, h.mkUser('admin'));
    assert.equal(failed.status, 'failed');
    assert.match(failed.failureReason, /bank unavailable/);
  } finally {
    h.gateway.refund = original;
  }
  assert.equal((await refund.processGatewayRefund(r._id, h.mkUser('admin'))).status, 'processed');
});

test('a wallet-funded payment is always refunded to the wallet', async () => {
  const renter = h.mkUser('renter');
  const owner = h.mkUser('owner');
  const booking = await h.mkBooking({ renter, owner });
  await h.seedBalance(renter, 7000000);
  await pay.createCheckout(renter, { bookingId: booking._id, method: 'wallet' });
  await h.cancelBooking(booking);
  const r = await refund.refundCancelledBooking(booking._id, renter, { destination: 'original' });
  assert.equal(r.destination, 'wallet');
  assert.deepEqual(await h.wallet(renter), { balance: 7000000, pending: 0 });
});

test('gateway processing only applies to card refunds', async () => {
  const { renter, booking } = await paid(72);
  await h.cancelBooking(booking);
  const r = await refund.refundCancelledBooking(booking._id, renter);
  const done = await refund.processGatewayRefund(r._id, h.mkUser('admin'));
  assert.equal(done.status, 'processed'); // already processed -> returned as is
  await h.expectErr(refund.processGatewayRefund(h.oid(), h.mkUser('admin')), 'REFUND_NOT_FOUND', 404);
});

test('cancelling after the deposit was already settled is refused', async () => {
  const { renter, owner, booking, payment } = await paid(72);
  const d = await Deposit.findOne({ payment: payment._id });
  await dep.confirmReturnAndRelease(d._id, owner);
  await h.cancelBooking(booking);
  await h.expectErr(refund.refundCancelledBooking(booking._id, renter), 'DEPOSIT_ALREADY_SETTLED', 409);
});

test('if earnings were already released, the reversal comes out of the owner available balance', async () => {
  const { owner, booking } = await paid(72);
  await pay.releaseEarnings(booking._id);
  await h.cancelBooking(booking);
  await refund.refundCancelledBooking(booking._id, h.mkUser('admin'));
  assert.deepEqual(await h.wallet(owner), { balance: 0, pending: 0 });
});

test('if the owner already withdrew the earning, the refund fails cleanly and nothing is half-done', async () => {
  const { renter, owner, booking, payment } = await paid(72);
  await pay.releaseEarnings(booking._id);
  await payout.requestPayout(owner, { amount: 4500000, bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Ada Obi' });
  await h.cancelBooking(booking);
  await h.expectErr(refund.refundCancelledBooking(booking._id, h.mkUser('admin')), 'INSUFFICIENT_FUNDS', 402);
  assert.equal(await Refund.countDocuments({}), 0);
  assert.deepEqual(await h.wallet(renter), { balance: 0, pending: 0 });
  assert.equal((await Deposit.findOne({ payment: payment._id })).status, 'held');
  assert.equal((await Payment.findById(payment._id)).status, 'succeeded');
  assert.equal((await h.getBooking(booking)).paymentStatus, 'paid');
});

test('preview matches what the real refund then pays', async () => {
  const { renter, booking } = await paid(30);
  const pv = await refund.previewCancellation(booking._id, renter);
  assert.equal(pv.cancelledBy, 'renter');
  assert.equal(pv.rate, 0.5);
  assert.equal(pv.refundTotal, 4500000);
  assert.ok(pv.reason);
  await h.cancelBooking(booking);
  const r = await refund.refundCancelledBooking(booking._id, renter);
  assert.equal(r.amount, pv.refundTotal);
  await h.expectErr(refund.previewCancellation(booking._id, h.mkUser('renter')), 'FORBIDDEN', 403);
});

test('refund lists show a renter their own and an admin everything', async () => {
  const a = await paid(72);
  const b = await paid(72);
  for (const x of [a, b]) {
    await h.cancelBooking(x.booking);
    await refund.refundCancelledBooking(x.booking._id, x.renter);
  }
  assert.equal((await refund.listRefunds(a.renter)).meta.total, 1);
  assert.equal((await refund.listRefunds(h.mkUser('admin'))).meta.total, 2);
  assert.equal((await refund.listRefunds(h.mkUser('admin'), { status: 'pending' })).meta.total, 0);
});

test('admin summary nets refunds out of commission and owner earnings', async () => {
  const full = await paid(72);
  const half = await paid(30);
  await paid(72); // untouched booking
  for (const x of [full, half]) {
    await h.cancelBooking(x.booking);
    await refund.refundCancelledBooking(x.booking._id, x.renter);
  }
  const s = await pay.adminSummary();
  assert.equal(s.refunded, 7000000 + 4500000);
  assert.equal(s.platformCommission, 500000 + 250000); // untouched booking + half of the 30h one
  assert.equal(s.ownerEarnings, 4500000 + 2250000);
});

test('earnings released after a partial refund only release what is left', async () => {
  const { owner, booking, renter } = await paid(30);
  await h.cancelBooking(booking);
  await refund.refundCancelledBooking(booking._id, renter);
  await pay.releaseEarnings(booking._id);
  assert.deepEqual(await h.wallet(owner), { balance: 2250000, pending: 0 });
});
