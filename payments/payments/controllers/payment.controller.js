const gateway = require('../gateway');
const config = require('../config');
const payments = require('../services/payment.service');
const Payment = require('../models/Payment');
const AppError = require('../utils/AppError');
const { asyncHandler, sendOk, assertObjectId } = require('../utils/helpers');

exports.quote = asyncHandler(async (req, res) => {
  assertObjectId(req.params.bookingId, 'bookingId');
  sendOk(res, await payments.getQuote(req.params.bookingId, req.user));
});

exports.checkout = asyncHandler(async (req, res) => {
  const { bookingId, method } = req.body || {};
  assertObjectId(bookingId, 'bookingId');
  sendOk(res, await payments.createCheckout(req.user, { bookingId, method }), 201);
});

exports.topup = asyncHandler(async (req, res) => {
  sendOk(res, await payments.createTopup(req.user, { amount: req.body?.amount }), 201);
});

exports.verify = asyncHandler(async (req, res) => {
  sendOk(res, await payments.verifyByReference(req.params.reference, req.user));
});

exports.getOne = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'payment id');
  sendOk(res, await payments.getPayment(req.params.id, req.user));
});

exports.mine = asyncHandler(async (req, res) => {
  const { items, meta } = await payments.listMyPayments(req.user, req.query);
  sendOk(res, items, 200, meta);
});

/** Demo-provider only, non-production only: simulate the gateway confirming a payment. */
exports.demoConfirm = asyncHandler(async (req, res) => {
  if (config.provider !== 'demo' || process.env.NODE_ENV === 'production') {
    throw new AppError('Not available', 404, 'NOT_FOUND');
  }
  assertObjectId(req.params.id, 'payment id');
  const p = await payments.getPayment(req.params.id, req.user);
  sendOk(res, await payments.confirmByReference(p.reference));
});

/** Gateway -> us. Public, secured by HMAC signature over the raw body. */
exports.webhook = asyncHandler(async (req, res) => {
  const signature = req.get('x-paystack-signature') || req.get('x-signature');
  if (!gateway.verifyWebhookSignature(req.rawBody, signature)) {
    throw new AppError('Invalid signature', 401, 'INVALID_SIGNATURE');
  }
  const evt = gateway.parseWebhook(req.body);
  if (evt.event === 'charge.success' && evt.reference) {
    try {
      await payments.confirmByReference(evt.reference, { gatewayAmount: evt.amount });
    } catch (err) {
      // Always 200 for unknown refs / mismatches so the gateway does not retry forever; we logged state on the payment
      if (!['PAYMENT_NOT_FOUND', 'AMOUNT_MISMATCH'].includes(err.code)) throw err;
    }
  }
  res.status(200).json({ received: true });
});

/** Called by the Booking module (or admin) when a rental is completed. */
exports.releaseEarnings = asyncHandler(async (req, res) => {
  assertObjectId(req.params.bookingId, 'bookingId');
  const p = await Payment.findOne({ booking: req.params.bookingId });
  if (!p) throw new AppError('Payment not found', 404, 'PAYMENT_NOT_FOUND');
  sendOk(res, await payments.releaseEarnings(req.params.bookingId));
});

exports.adminSummary = asyncHandler(async (_req, res) => sendOk(res, await payments.adminSummary()));
