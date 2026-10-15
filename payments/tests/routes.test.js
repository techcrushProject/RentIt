const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers/harness');

const { Payment } = h.models;
const users = {};
const as = (u) => {
  users[String(u._id)] = u;
  return String(u._id);
};
// Stand-in for the team's JWT middleware: identifies the caller from a header
const protect = (req, res, next) => {
  const u = users[req.get('x-user')];
  if (!u) return res.status(401).json({ success: false, error: { code: 'UNAUTHENTICATED', message: 'Login required' } });
  req.user = u;
  next();
};
const router = h.mod.createPaymentsRouter({ protect });
const call = (user, method, url, body, extra = {}) =>
  router.dispatch({ method, url, body, headers: user ? { 'x-user': as(user) } : {}, ...extra });

beforeEach(() => h.reset());

const world = async (opts = {}) => {
  const renter = h.mkUser('renter');
  const owner = h.mkUser('owner');
  const admin = h.mkUser('admin');
  const booking = await h.mkBooking({ renter, owner, ...opts });
  return { renter, owner, admin, booking };
};
const sign = (body, secret = h.config.webhookSecret) => {
  const rawBody = Buffer.from(JSON.stringify(body));
  return { rawBody, signature: crypto.createHmac('sha512', secret).update(rawBody).digest('hex') };
};

test('the router needs the existing auth middleware', () => {
  assert.throws(() => h.mod.createPaymentsRouter({}), /protect/);
  assert.throws(() => h.mod.createPaymentsRouter(), /protect/);
});

test('every documented endpoint exists', () => {
  const routes = router.routes();
  const expected = [
    'POST /payments/webhook', 'GET /payments/quote/:bookingId', 'POST /payments/checkout', 'GET /payments/verify/:reference',
    'GET /payments/my', 'GET /payments/admin/summary', 'POST /payments/booking/:bookingId/release-earnings',
    'POST /payments/:id/demo-confirm', 'GET /payments/:id', 'GET /wallet', 'GET /wallet/transactions', 'POST /wallet/topup',
    'POST /deposits/auto-release/run', 'GET /deposits/booking/:bookingId', 'GET /deposits/:id', 'POST /deposits/:id/release',
    'POST /deposits/:id/deduct', 'GET /refunds', 'GET /refunds/preview/:bookingId', 'POST /refunds/booking/:bookingId',
    'POST /refunds/:id/process', 'POST /payouts', 'GET /payouts', 'GET /payouts/:id', 'PATCH /payouts/:id/approve',
    'PATCH /payouts/:id/mark-paid', 'PATCH /payouts/:id/reject',
  ];
  for (const r of expected) assert.ok(routes.includes(r), `missing route ${r}`);
  assert.equal(routes.length, expected.length);
});

test('requests without a login get 401, but the webhook is public', async () => {
  for (const [m, u] of [['GET', '/wallet'], ['POST', '/payments/checkout'], ['GET', '/payouts'], ['GET', '/refunds']]) {
    const res = await call(null, m, u, {});
    assert.equal(res.status, 401, `${m} ${u}`);
    assert.equal(res.body.success, false);
  }
  const res = await call(null, 'POST', '/payments/webhook', {}, { rawBody: Buffer.from('{}') });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'INVALID_SIGNATURE'); // reached the handler, not the login wall
});

test('full renter journey over HTTP: quote, pay, owner releases deposit, wallets update', async () => {
  const { renter, owner, booking } = await world();

  const quote = await call(renter, 'GET', `/payments/quote/${booking._id}`);
  assert.equal(quote.status, 200);
  assert.equal(quote.body.success, true);
  assert.equal(quote.body.data.totalAmount, 7000000);

  const checkout = await call(renter, 'POST', '/payments/checkout', { bookingId: String(booking._id), method: 'card' });
  assert.equal(checkout.status, 201);
  assert.equal(checkout.body.data.status, 'pending');
  assert.ok(checkout.body.data.checkoutUrl);

  const verify = await call(renter, 'GET', `/payments/verify/${checkout.body.data.reference}`);
  assert.equal(verify.body.data.status, 'succeeded');

  const ownerWallet = await call(owner, 'GET', '/wallet');
  assert.deepEqual([ownerWallet.body.data.balance, ownerWallet.body.data.pendingBalance], [0, 4500000]);

  const dep = await call(renter, 'GET', `/deposits/booking/${booking._id}`);
  assert.equal(dep.body.data.status, 'held');
  assert.equal(dep.body.data.amount, 2000000);

  const rel = await call(owner, 'POST', `/deposits/${dep.body.data._id}/release`);
  assert.equal(rel.status, 200);
  assert.equal(rel.body.data.status, 'released');

  const renterWallet = await call(renter, 'GET', '/wallet');
  assert.equal(renterWallet.body.data.balance, 2000000);
  const tx = await call(renter, 'GET', '/wallet/transactions?limit=1');
  assert.equal(tx.body.data.length, 1);
  assert.equal(tx.body.meta.total, 1);
});

test('demo-confirm lets the frontend finish a demo payment, and is switched off in production', async () => {
  const { renter, booking } = await world();
  const c = await call(renter, 'POST', '/payments/checkout', { bookingId: String(booking._id) });
  const done = await call(renter, 'POST', `/payments/${c.body.data._id}/demo-confirm`);
  assert.equal(done.status, 200);
  assert.equal(done.body.data.status, 'succeeded');

  const second = await world();
  const c2 = await call(second.renter, 'POST', '/payments/checkout', { bookingId: String(second.booking._id) });
  process.env.NODE_ENV = 'production';
  try {
    const blocked = await call(second.renter, 'POST', `/payments/${c2.body.data._id}/demo-confirm`);
    assert.equal(blocked.status, 404);
  } finally {
    delete process.env.NODE_ENV;
  }
});

test('role guards: each action is limited to the right role, whatever spelling the auth module uses', async () => {
  const { renter, owner, admin, booking } = await world();
  const bid = String(booking._id);
  const anyId = String(h.oid());
  const denied = [
    [owner, 'POST', '/payments/checkout', { bookingId: bid }],
    [renter, 'POST', '/payouts', {}],
    [owner, 'PATCH', `/payouts/${anyId}/approve`, {}],
    [renter, 'PATCH', `/payouts/${anyId}/mark-paid`, {}],
    [renter, 'PATCH', `/payouts/${anyId}/reject`, {}],
    [renter, 'POST', `/deposits/${anyId}/release`, {}],
    [owner, 'POST', `/deposits/${anyId}/deduct`, {}],
    [owner, 'GET', '/payments/admin/summary'],
    [renter, 'POST', '/deposits/auto-release/run', {}],
    [renter, 'POST', `/refunds/${anyId}/process`, {}],
    [owner, 'POST', `/payments/booking/${bid}/release-earnings`, {}],
    [owner, 'POST', '/wallet/topup', { amount: 100000 }],
  ];
  for (const [u, m, url, body] of denied) {
    const res = await call(u, m, url, body);
    assert.equal(res.status, 403, `${m} ${url} as ${u.role}`);
    assert.equal(res.body.error.code, 'FORBIDDEN');
  }
  assert.equal((await call(admin, 'GET', '/payments/admin/summary')).status, 200);

  // different spellings of the same roles
  const R = h.mkUser('Renter');
  const O = h.mkUser('EquipmentOwner');
  const A = h.mkUser('ADMIN');
  assert.equal((await call(R, 'GET', `/payments/quote/${bid}`)).status, 403); // renter role ok, just not THIS booking
  assert.equal((await call(O, 'GET', '/payouts')).status, 200);
  assert.equal((await call(A, 'GET', '/payments/admin/summary')).status, 200);
  assert.equal((await call(A, 'POST', '/payments/checkout', { bookingId: bid })).status, 403); // admin passes the role guard, then service says not the renter
});

test('static paths are not swallowed by :id routes', async () => {
  const { renter, admin } = await world();
  const mine = await call(renter, 'GET', '/payments/my');
  assert.equal(mine.status, 200);
  assert.ok(Array.isArray(mine.body.data));
  assert.equal((await call(admin, 'GET', '/payments/admin/summary')).status, 200);
  assert.equal((await call(admin, 'POST', '/deposits/auto-release/run', {})).body.data.released, 0);
  assert.equal((await call(renter, 'GET', '/refunds')).status, 200);
});

test('malformed ids and bodies give clear 400s, unknown things give 404', async () => {
  const { renter } = await world();
  let res = await call(renter, 'GET', '/payments/not-an-id');
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'INVALID_ID');
  res = await call(renter, 'POST', '/payments/checkout', { bookingId: 'abc' });
  assert.equal(res.status, 400);
  res = await call(renter, 'POST', '/payments/checkout', undefined);
  assert.equal(res.status, 400);
  res = await call(renter, 'GET', `/payments/${h.oid()}`);
  assert.equal(res.status, 404);
  assert.deepEqual(Object.keys(res.body), ['success', 'error']);
  assert.deepEqual(Object.keys(res.body.error).sort(), ['code', 'message']);
  assert.equal(res.body.error.code, 'PAYMENT_NOT_FOUND');
  res = await call(renter, 'GET', '/no/such/route');
  assert.equal(res.status, 404);
});

test('wallet top-up over HTTP validates the amount and returns a checkout link', async () => {
  const { renter } = await world();
  assert.equal((await call(renter, 'POST', '/wallet/topup', { amount: 10 })).status, 400);
  assert.equal((await call(renter, 'POST', '/wallet/topup', {})).status, 400);
  const ok = await call(renter, 'POST', '/wallet/topup', { amount: 500000 });
  assert.equal(ok.status, 201);
  assert.ok(ok.body.data.checkoutUrl);
});

/* -------------------------------- webhook -------------------------------- */

const webhookFor = (payment, over = {}) => ({
  event: 'charge.success',
  data: { reference: payment.reference, amount: payment.totalAmount, status: 'success', ...over },
});

test('a correctly signed webhook settles the payment, and replays change nothing', async () => {
  const { renter, owner, booking } = await world();
  const p = await h.svc.payment.createCheckout(renter, { bookingId: booking._id, method: 'card' });
  const { rawBody, signature } = sign(webhookFor(p));
  const send = () =>
    call(null, 'POST', '/payments/webhook', JSON.parse(rawBody), { rawBody, headers: { 'x-paystack-signature': signature } });
  for (let i = 0; i < 3; i++) {
    const res = await send();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { received: true });
  }
  assert.equal((await Payment.findById(p._id)).status, 'succeeded');
  assert.deepEqual(await h.wallet(owner), { balance: 0, pending: 4500000 });
});

test('webhooks with a bad, missing or wrongly-keyed signature are rejected and change nothing', async () => {
  const { renter, booking } = await world();
  const p = await h.svc.payment.createCheckout(renter, { bookingId: booking._id, method: 'card' });
  const body = webhookFor(p);
  const good = sign(body);
  const wrongKey = sign(body, 'attacker-secret');
  const tampered = Buffer.from(JSON.stringify(webhookFor(p, { amount: 1 })));
  const attempts = [
    { rawBody: good.rawBody, headers: {} },
    { rawBody: good.rawBody, headers: { 'x-paystack-signature': 'deadbeef' } },
    { rawBody: wrongKey.rawBody, headers: { 'x-paystack-signature': wrongKey.signature } },
    { rawBody: tampered, headers: { 'x-paystack-signature': good.signature } }, // valid signature, altered body
  ];
  for (const a of attempts) {
    const res = await call(null, 'POST', '/payments/webhook', body, a);
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'INVALID_SIGNATURE');
  }
  assert.equal((await Payment.findById(p._id)).status, 'pending');
});

test('a webhook with the wrong amount fails the payment but still gets a 200 so the gateway stops retrying', async () => {
  const { renter, owner, booking } = await world();
  const p = await h.svc.payment.createCheckout(renter, { bookingId: booking._id, method: 'card' });
  const body = webhookFor(p, { amount: 5000 });
  const { rawBody, signature } = sign(body);
  const res = await call(null, 'POST', '/payments/webhook', body, { rawBody, headers: { 'x-paystack-signature': signature } });
  assert.equal(res.status, 200);
  assert.equal((await Payment.findById(p._id)).status, 'failed');
  assert.deepEqual(await h.wallet(owner), { balance: 0, pending: 0 });
});

test('unknown references and unrelated events are acknowledged and ignored', async () => {
  for (const body of [
    { event: 'charge.success', data: { reference: 'NOPE', amount: 100, status: 'success' } },
    { event: 'transfer.success', data: { reference: 'X' } },
    { event: 'charge.failed', data: {} },
  ]) {
    const { rawBody, signature } = sign(body);
    const res = await call(null, 'POST', '/payments/webhook', body, { rawBody, headers: { 'x-paystack-signature': signature } });
    assert.equal(res.status, 200, JSON.stringify(body));
  }
});

test('forgetting the rawBody setup in app.js is reported loudly instead of silently accepting webhooks', async () => {
  const res = await call(null, 'POST', '/payments/webhook', {}, { headers: { 'x-paystack-signature': 'x' } });
  assert.equal(res.status, 500);
  assert.equal(res.body.error.code, 'RAW_BODY_MISSING');
});

/* ----------------------------- refunds / payouts ----------------------------- */

test('cancellation refund over HTTP: preview, refund, admin gateway processing', async () => {
  const { renter, admin, booking } = await world({ startInHours: 30 });
  await h.payBooking(booking, renter);
  const pv = await call(renter, 'GET', `/refunds/preview/${booking._id}`);
  assert.equal(pv.body.data.refundTotal, 4500000);
  assert.equal((await call(renter, 'POST', `/refunds/booking/${booking._id}`, {})).status, 409); // not cancelled yet

  await h.cancelBooking(booking);
  const r = await call(renter, 'POST', `/refunds/booking/${booking._id}`, { destination: 'original' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.status, 'pending');
  const list = await call(renter, 'GET', '/refunds');
  assert.equal(list.body.meta.total, 1);
  const processed = await call(admin, 'POST', `/refunds/${r.body.data._id}/process`, {});
  assert.equal(processed.body.data.status, 'processed');
});

test('payout lifecycle over HTTP, with the account number masked in every response', async () => {
  const { owner, admin } = await world();
  await h.seedBalance(owner, 5000000);
  const bank = { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Ada Obi' };

  assert.equal((await call(owner, 'POST', '/payouts', { amount: 10, ...bank })).status, 400);
  assert.equal((await call(owner, 'POST', '/payouts', { amount: 99999999, ...bank })).status, 402);

  const made = await call(owner, 'POST', '/payouts', { amount: 2000000, ...bank });
  assert.equal(made.status, 201);
  assert.equal(made.body.data.bank.accountNumber, '******6789');
  const id = made.body.data._id;

  assert.equal((await call(admin, 'PATCH', `/payouts/${id}/approve`, {})).body.data.status, 'approved');
  assert.equal((await call(admin, 'PATCH', `/payouts/${id}/mark-paid`, {})).status, 400); // reference required
  const paid = await call(admin, 'PATCH', `/payouts/${id}/mark-paid`, { transferReference: 'TRF-9' });
  assert.equal(paid.body.data.status, 'paid');
  assert.equal(paid.body.data.bank.accountNumber, '******6789');
  assert.equal((await call(admin, 'PATCH', `/payouts/${id}/reject`, { reason: 'x' })).status, 409);

  const mine = await call(owner, 'GET', '/payouts');
  assert.equal(mine.body.meta.total, 1);
  assert.equal((await call(owner, 'GET', `/payouts/${id}`)).body.data.amount, 2000000);
  assert.equal((await call(h.mkUser('owner'), 'GET', `/payouts/${id}`)).status, 403);
});

test('admin can release owner earnings through the API', async () => {
  const { renter, owner, admin, booking } = await world();
  await h.payBooking(booking, renter);
  const res = await call(admin, 'POST', `/payments/booking/${booking._id}/release-earnings`, {});
  assert.equal(res.status, 200);
  assert.deepEqual(await h.wallet(owner), { balance: 4500000, pending: 0 });
  const none = await call(admin, 'POST', `/payments/booking/${h.oid()}/release-earnings`, {});
  assert.equal(none.status, 404);
});

test('unexpected crashes return a generic 500 and never leak internal details', async () => {
  const { renter } = await world();
  const original = h.svc.payment.listMyPayments;
  const originalErr = console.error;
  h.svc.payment.listMyPayments = async () => {
    throw new Error('mongodb://admin:SECRET@host/db exploded');
  };
  console.error = () => {};
  try {
    const res = await call(renter, 'GET', '/payments/my');
    assert.equal(res.status, 500);
    assert.equal(res.body.error.code, 'SERVER_ERROR');
    assert.equal(res.body.error.message, 'Internal server error');
    assert.ok(!JSON.stringify(res.body).includes('SECRET'));
  } finally {
    h.svc.payment.listMyPayments = original;
    console.error = originalErr;
  }
});

test('database validation and duplicate-key errors become clean 400/409 responses', async () => {
  const { renter } = await world();
  const original = h.svc.payment.listMyPayments;
  try {
    h.svc.payment.listMyPayments = async () => {
      const e = new Error('dup');
      e.code = 11000;
      throw e;
    };
    assert.equal((await call(renter, 'GET', '/payments/my')).status, 409);
    h.svc.payment.listMyPayments = async () => {
      const e = new Error('amount is required');
      e.name = 'ValidationError';
      throw e;
    };
    const res = await call(renter, 'GET', '/payments/my');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  } finally {
    h.svc.payment.listMyPayments = original;
  }
});
