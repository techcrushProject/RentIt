const Payment = require('../models/Payment');
const Deposit = require('../models/Deposit');
const config = require('../config');
const gateway = require('../gateway');
const wallet = require('./wallet.service');
const bookings = require('./booking-adapter');
const AppError = require('../utils/AppError');
const { splitPayment } = require('../utils/calc');
const { newReference, assertPositiveInt, runInTransaction, normalizeRole } = require('../utils/helpers');
const {
  PAYMENT_STATUS: PS,
  PAYMENT_PURPOSE,
  PAYMENT_METHOD,
  DEPOSIT_STATUS,
  WALLET_TX_TYPE: TX,
  WALLET_BUCKET,
} = require('../constants');

/* ----------------------------- quote ----------------------------- */

/** Price breakdown the frontend shows before the renter pays. */
async function getQuote(bookingId, user) {
  const b = await bookings.load(bookingId);
  if (String(b.renterId) !== String(user._id || user.id)) {
    throw new AppError('Only the renter can view this quote', 403, 'FORBIDDEN');
  }
  return { bookingId: b.id, currency: config.currency, ...splitPayment(b) };
}

/* ---------------------------- checkout --------------------------- */

async function createCheckout(user, { bookingId, method = PAYMENT_METHOD.CARD }) {
  if (!Object.values(PAYMENT_METHOD).includes(method)) {
    throw new AppError('method must be "card" or "wallet"', 400, 'INVALID_METHOD');
  }
  const uid = String(user._id || user.id);
  const b = await bookings.load(bookingId);

  if (b.renterId !== uid) throw new AppError('Only the renter can pay for this booking', 403, 'FORBIDDEN');
  if (!bookings.isPayable(b)) {
    throw new AppError(`Booking is not payable (status: ${b.status}). It must be approved by the owner first.`, 409, 'BOOKING_NOT_PAYABLE');
  }
  assertPositiveInt(b.rentalAmount, 'booking rental amount');

  const paid = await Payment.findOne({ booking: b.id, purpose: PAYMENT_PURPOSE.RENTAL, isPaid: true });
  if (paid) throw new AppError('This booking has already been paid for', 409, 'ALREADY_PAID');

  // Reuse a recent pending card checkout instead of creating duplicates
  const pending = await Payment.findOne({ booking: b.id, purpose: PAYMENT_PURPOSE.RENTAL, status: PS.PENDING });
  if (pending) {
    const age = (Date.now() - pending.createdAt.getTime()) / 60000;
    if (method === PAYMENT_METHOD.CARD && pending.method === PAYMENT_METHOD.CARD && age < config.checkoutExpiryMinutes) {
      return pending;
    }
    pending.status = PS.EXPIRED;
    await pending.save();
    await Deposit.deleteOne({ payment: pending._id, status: DEPOSIT_STATUS.PENDING });
  }

  const split = splitPayment(b);
  let payment = await runInTransaction(async (session) => {
    const [p] = await Payment.create(
      [
        {
          reference: newReference('RENT'),
          purpose: PAYMENT_PURPOSE.RENTAL,
          booking: b.id,
          equipment: b.equipmentId,
          renter: uid,
          owner: b.ownerId,
          method,
          provider: method === PAYMENT_METHOD.CARD ? gateway.name : 'wallet',
          currency: config.currency,
          ...split,
          rentalStartDate: b.startDate,
          rentalEndDate: b.endDate,
        },
      ],
      { session: session || undefined }
    );
    if (split.depositAmount > 0) {
      await Deposit.create(
        [
          {
            payment: p._id,
            booking: b.id,
            equipment: b.equipmentId,
            renter: uid,
            owner: b.ownerId,
            amount: split.depositAmount,
            status: DEPOSIT_STATUS.PENDING,
          },
        ],
        { session: session || undefined }
      );
    }
    return p;
  });

  if (method === PAYMENT_METHOD.WALLET) {
    return payWithWallet(payment);
  }

  try {
    const init = await gateway.initialize({
      reference: payment.reference,
      amount: payment.totalAmount,
      email: user.email,
      metadata: { bookingId: b.id, paymentId: String(payment._id) },
    });
    payment.providerReference = init.providerReference;
    payment.checkoutUrl = init.checkoutUrl;
    await payment.save();
  } catch (err) {
    payment.status = PS.FAILED;
    payment.failureReason = err.message;
    await payment.save();
    throw err;
  }
  return payment;
}

async function payWithWallet(payment) {
  await runInTransaction(async (session) => {
    await wallet.debit(
      {
        userId: payment.renter,
        amount: payment.totalAmount,
        type: TX.RENTAL_PAYMENT,
        idempotencyKey: `pay:${payment._id}`,
        links: { payment: payment._id, booking: payment.booking },
        description: `Rental payment ${payment.reference}`,
      },
      session
    );
    await settleSuccess(payment._id, { providerReference: payment.reference }, session);
  });
  return Payment.findById(payment._id);
}

/* ---------------------------- wallet top-up ---------------------------- */

async function createTopup(user, { amount }) {
  if (!Number.isInteger(amount) || amount < config.minTopupAmount || amount > config.maxTopupAmount) {
    throw new AppError(
      `amount must be an integer in kobo between ${config.minTopupAmount} and ${config.maxTopupAmount}`,
      400,
      'INVALID_AMOUNT'
    );
  }
  const uid = String(user._id || user.id);
  const payment = await Payment.create({
    reference: newReference('TOPUP'),
    purpose: PAYMENT_PURPOSE.WALLET_TOPUP,
    renter: uid,
    method: PAYMENT_METHOD.CARD,
    provider: gateway.name,
    totalAmount: amount,
  });
  try {
    const init = await gateway.initialize({
      reference: payment.reference,
      amount,
      email: user.email,
      metadata: { paymentId: String(payment._id), purpose: 'wallet_topup' },
    });
    payment.providerReference = init.providerReference;
    payment.checkoutUrl = init.checkoutUrl;
    await payment.save();
  } catch (err) {
    payment.status = PS.FAILED;
    payment.failureReason = err.message;
    await payment.save();
    throw err;
  }
  return payment;
}

/* ------------------------- success / settlement ------------------------- */

/**
 * Marks a payment succeeded and moves the money. MUST be called inside a transaction session.
 * Idempotent: if the payment is no longer pending it returns it untouched.
 */
async function settleSuccess(paymentId, { providerReference } = {}, session) {
  const payment = await Payment.findOneAndUpdate(
    { _id: paymentId, status: PS.PENDING },
    { $set: { status: PS.SUCCEEDED, isPaid: true, paidAt: new Date(), ...(providerReference ? { providerReference } : {}) } },
    { new: true, session: session || undefined }
  );
  if (!payment) return Payment.findById(paymentId).session(session || null);

  if (payment.purpose === PAYMENT_PURPOSE.WALLET_TOPUP) {
    await wallet.credit(
      {
        userId: payment.renter,
        amount: payment.totalAmount,
        type: TX.TOPUP,
        idempotencyKey: `topup:${payment._id}`,
        links: { payment: payment._id },
        description: `Wallet top-up ${payment.reference}`,
      },
      session
    );
    return payment;
  }

  // Rental payment: hold deposit, park owner's earning as pending, flag booking as paid
  if (payment.depositAmount > 0) {
    const holdAt = new Date();
    const delayMs = config.deposit.autoReleaseDelayHours * 3600 * 1000;
    const end = payment.rentalEndDate ? new Date(payment.rentalEndDate).getTime() : holdAt.getTime();
    await Deposit.findOneAndUpdate(
      { payment: payment._id },
      { $set: { status: DEPOSIT_STATUS.HELD, heldAt: holdAt, releaseDueAt: new Date(end + delayMs) } },
      { session: session || undefined }
    );
  }
  if (payment.ownerEarning > 0) {
    await wallet.credit(
      {
        userId: payment.owner,
        amount: payment.ownerEarning,
        bucket: WALLET_BUCKET.PENDING,
        type: TX.OWNER_EARNING,
        idempotencyKey: `earning:${payment._id}`,
        links: { payment: payment._id, booking: payment.booking },
        description: `Earning for booking (after ${Math.round(payment.commissionRate * 100)}% commission)`,
      },
      session
    );
  }
  await bookings.markPaid(payment.booking, session);
  return payment;
}

/* ------------------------- gateway confirmation ------------------------- */

/**
 * Called by webhook and by the verify endpoint. Always re-checks amount; idempotent.
 */
async function confirmByReference(reference, { gatewayAmount } = {}) {
  const payment = await Payment.findOne({ reference });
  if (!payment) throw new AppError('Payment not found', 404, 'PAYMENT_NOT_FOUND');
  if (payment.status !== PS.PENDING) return payment; // already settled / failed / expired

  if (gatewayAmount !== undefined && gatewayAmount !== payment.totalAmount) {
    payment.status = PS.FAILED;
    payment.failureReason = `amount_mismatch: expected ${payment.totalAmount}, gateway reported ${gatewayAmount}`;
    await payment.save();
    throw new AppError('Payment amount mismatch', 409, 'AMOUNT_MISMATCH');
  }

  await runInTransaction((session) => settleSuccess(payment._id, { providerReference: payment.providerReference }, session));
  return Payment.findById(payment._id);
}

/** Frontend calls this after the gateway redirects back. Asks the gateway, then settles. */
async function verifyByReference(reference, user) {
  const payment = await Payment.findOne({ reference });
  if (!payment) throw new AppError('Payment not found', 404, 'PAYMENT_NOT_FOUND');
  if (user && String(payment.renter) !== String(user._id || user.id) && normalizeRole(user.role) !== 'admin') {
    throw new AppError('Not your payment', 403, 'FORBIDDEN');
  }
  if (payment.status !== PS.PENDING) return payment;

  const result = await gateway.verify(reference);
  if (result.status === 'success') return confirmByReference(reference, { gatewayAmount: result.amount });
  if (result.status === 'failed' || result.status === 'abandoned') {
    payment.status = PS.FAILED;
    payment.failureReason = `gateway_status: ${result.status}`;
    await payment.save();
  }
  return payment;
}

/* ------------------------- earnings release ------------------------- */

/**
 * Call when a rental is COMPLETED. Moves the owner's earning pending -> available (withdrawable).
 * Idempotent.
 */
async function releaseEarnings(bookingId) {
  const payment = await Payment.findOne({ booking: bookingId, purpose: PAYMENT_PURPOSE.RENTAL, isPaid: true });
  if (!payment) throw new AppError('No paid payment for this booking', 404, 'PAYMENT_NOT_FOUND');
  if (payment.status === PS.REFUNDED) throw new AppError('Payment was refunded', 409, 'PAYMENT_REFUNDED');

  return runInTransaction(async (session) => {
    const claimed = await Payment.findOneAndUpdate(
      { _id: payment._id, earningsReleased: false },
      { $set: { earningsReleased: true, earningsReleasedAt: new Date() } },
      { new: true, session: session || undefined }
    );
    if (!claimed) return payment; // already released

    // Any refund already removed its share of the earning from the pending bucket
    const remaining = claimed.ownerEarning - (claimed.ownerEarningReversed || 0);
    if (remaining > 0) {
      await wallet.debit(
        {
          userId: payment.owner,
          amount: remaining,
          bucket: WALLET_BUCKET.PENDING,
          type: TX.EARNING_RELEASE,
          idempotencyKey: `release-out:${payment._id}`,
          links: { payment: payment._id, booking: payment.booking },
          description: 'Rental completed - earning released',
        },
        session
      );
      await wallet.credit(
        {
          userId: payment.owner,
          amount: remaining,
          type: TX.EARNING_RELEASE,
          idempotencyKey: `release-in:${payment._id}`,
          links: { payment: payment._id, booking: payment.booking },
          description: 'Rental completed - earning available',
        },
        session
      );
    }
    return claimed;
  });
}

/* ------------------------------ queries ------------------------------ */

const getPayment = async (id, user) => {
  const p = await Payment.findById(id);
  if (!p) throw new AppError('Payment not found', 404, 'PAYMENT_NOT_FOUND');
  const uid = String(user._id || user.id);
  if (normalizeRole(user.role) !== 'admin' && String(p.renter) !== uid && String(p.owner) !== uid) {
    throw new AppError('Not allowed', 403, 'FORBIDDEN');
  }
  return p;
};

async function listMyPayments(user, { page = 1, limit = 20, status } = {}) {
  const uid = String(user._id || user.id);
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100, Math.max(1, Number(limit) || 20));
  const filter = { $or: [{ renter: uid }, { owner: uid }], ...(status ? { status } : {}) };
  const [items, total] = await Promise.all([
    Payment.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l).lean(),
    Payment.countDocuments(filter),
  ]);
  return { items, meta: { page: p, limit: l, total, pages: Math.ceil(total / l) } };
}

async function adminSummary() {
  const [row] = await Payment.aggregate([
    { $match: { purpose: PAYMENT_PURPOSE.RENTAL, isPaid: true } },
    {
      $group: {
        _id: null,
        payments: { $sum: 1 },
        grossRentals: { $sum: '$rentalAmount' },
        depositsCollected: { $sum: '$depositAmount' },
        commissionGross: { $sum: '$commissionAmount' },
        commissionReversed: { $sum: '$commissionReversed' },
        earningsGross: { $sum: '$ownerEarning' },
        earningsReversed: { $sum: '$ownerEarningReversed' },
        refunded: { $sum: '$refundedAmount' },
      },
    },
  ]);
  if (!row) {
    return { payments: 0, grossRentals: 0, depositsCollected: 0, platformCommission: 0, ownerEarnings: 0, refunded: 0 };
  }
  // Commission and owner earnings are reported NET of refunds
  return {
    payments: row.payments,
    grossRentals: row.grossRentals,
    depositsCollected: row.depositsCollected,
    platformCommission: row.commissionGross - row.commissionReversed,
    ownerEarnings: row.earningsGross - row.earningsReversed,
    refunded: row.refunded,
  };
}

module.exports = {
  getQuote,
  createCheckout,
  createTopup,
  confirmByReference,
  verifyByReference,
  releaseEarnings,
  getPayment,
  listMyPayments,
  adminSummary,
  settleSuccess,
};
