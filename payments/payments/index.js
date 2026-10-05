/**
 * RentIt - Payment & Deposit module entry point.
 *
 *   const { createPaymentsRouter, startDepositScheduler } = require('./payments');
 *   app.use('/api', createPaymentsRouter({ protect }));   // `protect` = existing JWT auth middleware
 *   startDepositScheduler();                              // optional auto-release of unclaimed deposits
 *
 * app.js must also capture the raw body for webhook signature checks:
 *   app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
 *
 * Service functions other modules call directly are re-exported below.
 */
const express = require('express');
const { requireRole, requireRawBody, errorHandler } = require('./middleware/guards');
const payment = require('./controllers/payment.controller');
const deposit = require('./controllers/deposit.controller');
const wallet = require('./controllers/wallet.controller');
const payout = require('./controllers/payout.controller');
const refund = require('./controllers/refund.controller');

function createPaymentsRouter({ protect } = {}) {
  if (typeof protect !== 'function') {
    throw new Error('createPaymentsRouter({ protect }) - pass your JWT auth middleware');
  }
  const r = express.Router();
  const renter = requireRole('renter', 'admin');
  const owner = requireRole('owner', 'admin');
  const admin = requireRole('admin');

  /* ---- Payments ---- */
  // Public: gateway webhook (signature-verified, not JWT)
  r.post('/payments/webhook', requireRawBody, payment.webhook);

  r.get('/payments/quote/:bookingId', protect, renter, payment.quote);
  r.post('/payments/checkout', protect, renter, payment.checkout);
  r.get('/payments/verify/:reference', protect, payment.verify);
  r.get('/payments/my', protect, payment.mine);
  r.get('/payments/admin/summary', protect, admin, payment.adminSummary);
  r.post('/payments/booking/:bookingId/release-earnings', protect, admin, payment.releaseEarnings);
  r.post('/payments/:id/demo-confirm', protect, payment.demoConfirm);
  r.get('/payments/:id', protect, payment.getOne);

  /* ---- Wallet ---- */
  r.get('/wallet', protect, wallet.me);
  r.get('/wallet/transactions', protect, wallet.transactions);
  r.post('/wallet/topup', protect, renter, payment.topup);

  /* ---- Security deposits ---- */
  r.post('/deposits/auto-release/run', protect, admin, deposit.runAutoRelease);
  r.get('/deposits/booking/:bookingId', protect, deposit.byBooking);
  r.get('/deposits/:id', protect, deposit.getOne);
  r.post('/deposits/:id/release', protect, owner, deposit.release);
  r.post('/deposits/:id/deduct', protect, admin, deposit.deduct);

  /* ---- Refunds ---- */
  r.get('/refunds', protect, refund.list);
  r.get('/refunds/preview/:bookingId', protect, refund.preview);
  r.post('/refunds/booking/:bookingId', protect, refund.refundBooking);
  r.post('/refunds/:id/process', protect, admin, refund.process);

  /* ---- Owner payouts ---- */
  r.post('/payouts', protect, owner, payout.request);
  r.get('/payouts', protect, payout.list);
  r.get('/payouts/:id', protect, payout.getOne);
  r.patch('/payouts/:id/approve', protect, admin, payout.approve);
  r.patch('/payouts/:id/mark-paid', protect, admin, payout.markPaid);
  r.patch('/payouts/:id/reject', protect, admin, payout.reject);

  r.use(errorHandler);
  return r;
}

const paymentService = require('./services/payment.service');
const depositService = require('./services/deposit.service');
const refundService = require('./services/refund.service');

module.exports = {
  createPaymentsRouter,
  startDepositScheduler: depositService.startDepositScheduler,

  // ---- Hooks for the Booking and Damage Claim modules ----
  onRentalCompleted: paymentService.releaseEarnings, // (bookingId) owner earning -> withdrawable
  refundCancelledBooking: refundService.refundCancelledBooking, // (bookingId, user, {destination})
  lockDepositForClaim: depositService.lockForClaim, // (depositId, claimId)
  unlockDepositClaim: depositService.unlockClaim, // (depositId, claimId)
  resolveDamageClaim: depositService.resolveClaim, // (depositId, {claimId, approvedAmount, reason})

  services: { paymentService, depositService, refundService },
  models: {
    Payment: require('./models/Payment'),
    Deposit: require('./models/Deposit'),
    Wallet: require('./models/Wallet'),
    WalletTransaction: require('./models/WalletTransaction'),
    Refund: require('./models/Refund'),
    Payout: require('./models/Payout'),
  },
};
