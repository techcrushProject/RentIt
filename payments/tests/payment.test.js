const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers/harness');

const { payment: pay, wallet } = h.svc;
const { Payment, Deposit } = h.models;
beforeEach(() => h.reset());

const setup = async (opts = {}) => {
  const renter = h.mkUser('renter');
  const owner = h.mkUser('owner');
  const booking = await h.mkBooking({ renter, owner, ...opts });
  return { renter, owner, booking };
};

/* ---------------------------------- quote ---------------------------------- */

test('quote shows the full price breakdown in kobo', async () => {
  const { renter, booking } = await setup();
  const q = await pay.getQuote(booking._id, renter);
  assert.equal(q.rentalAmount, 5000000);
  assert.equal(q.depositAmount, 2000000);
  assert.equal(q.commissionAmount, 500000);
  assert.equal(q.ownerEarning, 4500000);
  assert.equal(q.totalAmount, 7000000);
});

test('only the renter of the booking can see the quote', async () => {
  const { booking } = await setup();
  await h.expectErr(pay.getQuote(booking._id, h.mkUser('renter')), 'FORBIDDEN', 403);
});

test('naira decimals are converted to whole kobo and the split still adds up', async () => {
  const { renter, booking } = await setup({ price: 1999.99, deposit: 0.5 });
  const q = await pay.getQuote(booking._id, renter);
  assert.equal(q.rentalAmount, 199999);
  assert.equal(q.depositAmount, 50);
  assert.equal(q.commissionAmount + q.ownerEarning, q.rentalAmount);
  assert.equal(q.totalAmount, 200049);
});

/* -------------------------------- checkout -------------------------------- */

test('card checkout creates a pending payment and a pending deposit', async () => {
  const { renter, owner, booking } = await setup();
  const p = await pay.createCheckout(renter, { bookingId: booking._id, method: 'card' });
  assert.equal(p.status, 'pending');
  assert.equal(p.method, 'card');
  assert.equal(p.totalAmount, 7000000);
  assert.match(p.checkoutUrl, /reference=/);
  const dep = await Deposit.findOne({ payment: p._id });
  assert.equal(dep.status, 'pending');
  assert.equal(dep.amount, 2000000);
  assert.deepEqual(await h.wallet(owner), { balance: 0, pending: 0 }); // nothing credited before payment
  assert.equal((await h.getBooking(booking)).paymentStatus, 'unpaid');
});

test('checkout is refused until the owner has approved the booking', async () => {
  for (const status of ['pending', 'rejected', 'cancelled', 'completed']) {
    const { renter, booking } = await setup({ status });
    await h.expectErr(pay.createCheckout(renter, { bookingId: booking._id }), 'BOOKING_NOT_PAYABLE', 409);
  }
});

test('only the booking renter can pay, not the owner or a stranger', async () => {
  const { owner, booking } = await setup();
  await h.expectErr(pay.createCheckout(owner, { bookingId: booking._id }), 'FORBIDDEN', 403);
  await h.expectErr(pay.createCheckout(h.mkUser('renter'), { bookingId: booking._id }), 'FORBIDDEN', 403);
  assert.equal(await Payment.countDocuments({}), 0);
});

test('invalid method, missing booking and zero-priced booking are rejected', async () => {
  const { renter, booking } = await setup();
  await h.expectErr(pay.createCheckout(renter, { bookingId: booking._id, method: 'crypto' }), 'INVALID_METHOD', 400);
  await h.expectErr(pay.createCheckout(renter, { bookingId: h.oid() }), 'BOOKING_NOT_FOUND', 404);
  const free = await setup({ price: 0 });
  await h.expectErr(pay.createCheckout(free.renter, { bookingId: free.booking._id }), 'INVALID_AMOUNT', 400);
});

test('asking twice for the same unpaid card checkout returns the same payment', async () => {
  const { renter, booking } = await setup();
  const a = await pay.createCheckout(renter, { bookingId: booking._id, method: 'card' });
  const b = await pay.createCheckout(renter, { bookingId: booking._id, method: 'card' });
  assert.equal(String(a._id), String(b._id));
  assert.equal(await Payment.countDocuments({}), 1);
  assert.equal(await Deposit.countDocuments({}), 1);
});

test('a stale pending checkout expires and is replaced, without leaving a duplicate deposit', async () => {
  const { renter, booking } = await setup();
  const a = await pay.createCheckout(renter, { bookingId: booking._id, method: 'card' });
  await Payment.updateOne({ _id: a._id }, { $set: { createdAt: new Date(Date.now() - 31 * 60000) } });
  const b = await pay.createCheckout(renter, { bookingId: booking._id, method: 'card' });
  assert.notEqual(String(a._id), String(b._id));
  assert.equal((await Payment.findById(a._id)).status, 'expired');
  assert.equal(await Deposit.countDocuments({}), 1);
  assert.equal(String((await Deposit.findOne({})).payment), String(b._id));
});

test('a booking with no deposit pays fine and creates no deposit record', async () => {
  const { renter, owner, booking } = await setup({ deposit: 0 });
  const p = await h.payBooking(booking, renter);
  assert.equal(p.totalAmount, 5000000);
  assert.equal(await Deposit.countDocuments({}), 0);
  assert.deepEqual(await h.wallet(owner), { balance: 0, pending: 4500000 });
});

/* --------------------------- verify / settlement --------------------------- */

test('verifying a card payment settles everything exactly once', async () => {
  const { renter, owner, booking } = await setup();
  const p = await pay.createCheckout(renter, { bookingId: booking._id, method: 'card' });
  const done = await pay.verifyByReference(p.reference, renter);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.isPaid, true);
  assert.ok(done.paidAt);

  const dep = await Deposit.findOne({ payment: p._id });
  assert.equal(dep.status, 'held');
  assert.equal(dep.releaseDueAt.getTime(), booking.endDate.getTime() + 48 * h.HOUR);

  assert.deepEqual(await h.wallet(owner), { balance: 0, pending: 4500000 });
  assert.equal((await h.getBooking(booking)).paymentStatus, 'paid');
  const earning = (await wallet.listTransactions(owner._id)).items;
  assert.equal(earning.length, 1);
  assert.equal(earning[0].type, 'owner_earning');
  assert.equal(earning[0].bucket, 'pendingBalance');
});

test('duplicate confirmations (webhook retries) never double-credit', async () => {
  const { renter, owner, booking } = await setup();
  const p = await pay.createCheckout(renter, { bookingId: booking._id, method: 'card' });
  await pay.confirmByReference(p.reference);
  await pay.confirmByReference(p.reference);
  await pay.verifyByReference(p.reference, renter);
  assert.deepEqual(await h.wallet(owner), { balance: 0, pending: 4500000 });
  assert.equal((await wallet.listTransactions(owner._id)).meta.total, 1);
});

test('confirmations arriving at the same moment still credit once', async () => {
  const { renter, owner, booking } = await setup();
  const p = await pay.createCheckout(renter, { bookingId: booking._id, method: 'card' });
  await Promise.all([pay.confirmByReference(p.reference), pay.confirmByReference(p.reference), pay.verifyByReference(p.reference, renter)]);
  assert.deepEqual(await h.wallet(owner), { balance: 0, pending: 4500000 });
  assert.equal((await wallet.listTransactions(owner._id)).meta.total, 1);
});

test('a gateway amount that differs from the price fails the payment and credits nobody', async () => {
  const { renter, owner, booking } = await setup();
  const p = await pay.createCheckout(renter, { bookingId: booking._id, method: 'card' });
  await h.expectErr(pay.confirmByReference(p.reference, { gatewayAmount: 100 }), 'AMOUNT_MISMATCH', 409);
  const after = await Payment.findById(p._id);
  assert.equal(after.status, 'failed');
  assert.match(after.failureReason, /amount_mismatch/);
  assert.deepEqual(await h.wallet(owner), { balance: 0, pending: 0 });
  assert.equal((await h.getBooking(booking)).paymentStatus, 'unpaid');
  // renter can try again with a fresh checkout
  const retry = await pay.createCheckout(renter, { bookingId: booking._id, method: 'card' });
  assert.notEqual(String(retry._id), String(p._id));
});

test('a failed gateway result marks the payment failed and allows a retry', async () => {
  const { renter, owner, booking } = await setup();
  const p = await pay.createCheckout(renter, { bookingId: booking._id, method: 'card' });
  const original = h.gateway.verify;
  h.gateway.verify = async () => ({ status: 'failed' });
  try {
    const res = await pay.verifyByReference(p.reference, renter);
    assert.equal(res.status, 'failed');
  } finally {
    h.gateway.verify = original;
  }
  assert.deepEqual(await h.wallet(owner), { balance: 0, pending: 0 });
  const retry = await h.payBooking(booking, renter);
  assert.equal(retry.status, 'succeeded');
});

test('a gateway that is down at checkout leaves a failed payment, not a stuck pending one', async () => {
  const { renter, booking } = await setup();
  const original = h.gateway.initialize;
  h.gateway.initialize = async () => {
    const e = new Error('gateway down');
    e.code = 'GATEWAY_ERROR';
    throw e;
  };
  try {
    await h.expectErr(pay.createCheckout(renter, { bookingId: booking._id, method: 'card' }), 'GATEWAY_ERROR');
  } finally {
    h.gateway.initialize = original;
  }
  assert.equal((await Payment.findOne({})).status, 'failed');
  const ok = await h.payBooking(booking, renter);
  assert.equal(ok.status, 'succeeded');
});

test('a booking cannot be paid twice', async () => {
  const { renter, booking } = await setup();
  await h.payBooking(booking, renter);
  await h.expectErr(pay.createCheckout(renter, { bookingId: booking._id, method: 'card' }), 'ALREADY_PAID', 409);
  await h.expectErr(pay.createCheckout(renter, { bookingId: booking._id, method: 'wallet' }), 'ALREADY_PAID', 409);
});

test('the database itself refuses a second paid rental payment for one booking', async () => {
  const { renter, booking } = await setup();
  const p = await h.payBooking(booking, renter);
  await assert.rejects(
    Payment.create({
      reference: 'FORCED-DUP',
      booking: booking._id,
      renter: renter._id,
      method: 'card',
      totalAmount: 100,
      isPaid: true,
      purpose: 'rental',
    }),
    (e) => e.code === 11000
  );
  assert.equal(p.status, 'succeeded');
});

test('only the payer or an admin can verify a payment', async () => {
  const { renter, booking } = await setup();
  const p = await pay.createCheckout(renter, { bookingId: booking._id, method: 'card' });
  await h.expectErr(pay.verifyByReference(p.reference, h.mkUser('renter')), 'FORBIDDEN', 403);
  const admin = h.mkUser('admin');
  assert.equal((await pay.verifyByReference(p.reference, admin)).status, 'succeeded');
  await h.expectErr(pay.verifyByReference('NOPE', renter), 'PAYMENT_NOT_FOUND', 404);
});

/* -------------------------------- wallet pay -------------------------------- */

test('top-up credits the wallet once and enforces limits', async () => {
  const renter = h.mkUser('renter');
  await h.expectErr(pay.createTopup(renter, { amount: 49999 }), 'INVALID_AMOUNT', 400);
  await h.expectErr(pay.createTopup(renter, { amount: 100000.5 }), 'INVALID_AMOUNT', 400);
  await h.expectErr(pay.createTopup(renter, { amount: 100000001 }), 'INVALID_AMOUNT', 400);
  await h.expectErr(pay.createTopup(renter, {}), 'INVALID_AMOUNT', 400);

  const t = await pay.createTopup(renter, { amount: 10000000 });
  assert.equal(t.status, 'pending');
  await pay.confirmByReference(t.reference);
  await pay.confirmByReference(t.reference);
  assert.deepEqual(await h.wallet(renter), { balance: 10000000, pending: 0 });
});

test('paying from the wallet succeeds immediately and moves the right amounts', async () => {
  const { renter, owner, booking } = await setup();
  await h.seedBalance(renter, 10000000);
  const p = await pay.createCheckout(renter, { bookingId: booking._id, method: 'wallet' });
  assert.equal(p.status, 'succeeded');
  assert.deepEqual(await h.wallet(renter), { balance: 3000000, pending: 0 });
  assert.deepEqual(await h.wallet(owner), { balance: 0, pending: 4500000 });
  assert.equal((await Deposit.findOne({ payment: p._id })).status, 'held');
  assert.equal((await h.getBooking(booking)).paymentStatus, 'paid');
});

test('wallet payment with too little money changes nothing, and the renter can top up and retry', async () => {
  const { renter, owner, booking } = await setup();
  await h.seedBalance(renter, 1000000);
  await h.expectErr(pay.createCheckout(renter, { bookingId: booking._id, method: 'wallet' }), 'INSUFFICIENT_FUNDS', 402);
  assert.deepEqual(await h.wallet(renter), { balance: 1000000, pending: 0 });
  assert.deepEqual(await h.wallet(owner), { balance: 0, pending: 0 });
  assert.equal((await h.getBooking(booking)).paymentStatus, 'unpaid');
  assert.equal(await Payment.countDocuments({ isPaid: true }), 0);

  await h.seedBalance(renter, 6000000);
  const p = await pay.createCheckout(renter, { bookingId: booking._id, method: 'wallet' });
  assert.equal(p.status, 'succeeded');
  assert.deepEqual(await h.wallet(renter), { balance: 0, pending: 0 });
  assert.equal(await Deposit.countDocuments({}), 1); // the abandoned attempt's pending deposit was cleaned up
});

/* ----------------------------- earnings release ----------------------------- */

test('owner earnings become withdrawable when the rental completes, and only once', async () => {
  const { renter, owner, booking } = await setup();
  await h.payBooking(booking, renter);
  await pay.releaseEarnings(booking._id);
  await pay.releaseEarnings(booking._id);
  assert.deepEqual(await h.wallet(owner), { balance: 4500000, pending: 0 });
});

test('releasing earnings for an unpaid booking is refused', async () => {
  const { booking } = await setup();
  await h.expectErr(pay.releaseEarnings(booking._id), 'PAYMENT_NOT_FOUND', 404);
});

/* ------------------------------- reads / admin ------------------------------- */

test('payments are visible to the renter, the owner and admins only', async () => {
  const { renter, owner, booking } = await setup();
  const p = await h.payBooking(booking, renter);
  assert.equal((await pay.getPayment(p._id, renter)).reference, p.reference);
  assert.equal((await pay.getPayment(p._id, owner)).reference, p.reference);
  assert.equal((await pay.getPayment(p._id, h.mkUser('Admin'))).reference, p.reference);
  await h.expectErr(pay.getPayment(p._id, h.mkUser('renter')), 'FORBIDDEN', 403);
  await h.expectErr(pay.getPayment(h.oid(), renter), 'PAYMENT_NOT_FOUND', 404);
});

test('my payments lists both sides and paginates', async () => {
  const owner = h.mkUser('owner');
  const renter = h.mkUser('renter');
  for (let i = 0; i < 3; i++) await h.payBooking(await h.mkBooking({ renter, owner }), renter);
  assert.equal((await pay.listMyPayments(renter, { limit: 2 })).items.length, 2);
  assert.equal((await pay.listMyPayments(owner)).meta.total, 3);
  assert.equal((await pay.listMyPayments(h.mkUser('renter'))).meta.total, 0);
});

test('admin summary totals paid rentals', async () => {
  const owner = h.mkUser('owner');
  const renter = h.mkUser('renter');
  await h.payBooking(await h.mkBooking({ renter, owner }), renter);
  await h.payBooking(await h.mkBooking({ renter, owner }), renter);
  const s = await pay.adminSummary();
  assert.equal(s.payments, 2);
  assert.equal(s.grossRentals, 10000000);
  assert.equal(s.depositsCollected, 4000000);
  assert.equal(s.platformCommission, 1000000);
  assert.equal(s.ownerEarnings, 9000000);
  assert.equal(s.refunded, 0);
});

test('admin summary on an empty system is all zeros', async () => {
  const s = await pay.adminSummary();
  assert.deepEqual(s, { payments: 0, grossRentals: 0, depositsCollected: 0, platformCommission: 0, ownerEarnings: 0, refunded: 0 });
});

/* --------------------------- local mongod fallback --------------------------- */

test('on a MongoDB without transaction support the flow still works', async () => {
  h.fake.mongoose.__txUnsupported = true;
  const { renter, owner, booking } = await setup();
  const p = await h.payBooking(booking, renter);
  assert.equal(p.status, 'succeeded');
  assert.deepEqual(await h.wallet(owner), { balance: 0, pending: 4500000 });
});

test('a custom commission rate flows through to the owner earning', async () => {
  h.config.commissionRate = 0.15;
  try {
    const { renter, owner, booking } = await setup();
    const q = await pay.getQuote(booking._id, renter);
    assert.equal(q.commissionAmount, 750000);
    await h.payBooking(booking, renter);
    assert.deepEqual(await h.wallet(owner), { balance: 0, pending: 4250000 });
  } finally {
    h.config.commissionRate = 0.1;
  }
});
