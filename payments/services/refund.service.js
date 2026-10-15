const Payment = require('../models/Payment');
const Deposit = require('../models/Deposit');
const Refund = require('../models/Refund');
const gateway = require('../gateway');
const wallet = require('./wallet.service');
const bookings = require('./booking-adapter');
const AppError = require('../utils/AppError');
const { cancellationRefund } = require('../utils/calc');
const { runInTransaction, normalizeRole } = require('../utils/helpers');
const {
  PAYMENT_STATUS: PS,
  PAYMENT_PURPOSE,
  PAYMENT_METHOD,
  DEPOSIT_STATUS: DS,
  REFUND_STATUS: RS,
  WALLET_TX_TYPE: TX,
  WALLET_BUCKET,
} = require('../constants');

const sid = (v) => (v ? String(v) : null);

async function loadContext(bookingId) {
  const payment = await Payment.findOne({ booking: bookingId, purpose: PAYMENT_PURPOSE.RENTAL, isPaid: true });
  if (!payment) throw new AppError('This booking has no successful payment to refund', 404, 'PAYMENT_NOT_FOUND');
  const deposit = await Deposit.findOne({ payment: payment._id });
  return { payment, deposit };
}

/** What would a cancellation refund right now? Used by the frontend before the user confirms. */
async function previewCancellation(bookingId, user) {
  const { payment } = await loadContext(bookingId);
  const uid = sid(user._id || user.id);
  const role = normalizeRole(user.role);
  if (role !== 'admin' && sid(payment.renter) !== uid && sid(payment.owner) !== uid) {
    throw new AppError('Not allowed', 403, 'FORBIDDEN');
  }
  const cancelledBy = role === 'admin' ? 'admin' : sid(payment.owner) === uid ? 'owner' : 'renter';
  return { cancelledBy, ...compute(payment, cancelledBy) };
}

function compute(payment, cancelledBy) {
  return cancellationRefund({
    rentalAmount: payment.rentalAmount,
    ownerEarning: payment.ownerEarning,
    depositAmount: payment.depositAmount,
    startDate: payment.rentalStartDate,
    cancelledAt: new Date(),
    cancelledBy,
  });
}

/**
 * Refund for a cancelled booking. Called by the Booking module after it marks a booking cancelled
 * (or via POST /payments/booking/:id/refund). Idempotent - one cancellation refund per payment.
 *   destination 'wallet'   -> instant credit to renter's wallet
 *   destination 'original' -> pending until an admin processes the gateway refund
 */
async function refundCancelledBooking(bookingId, user, { destination = 'wallet' } = {}) {
  if (!['wallet', 'original'].includes(destination)) {
    throw new AppError('destination must be "wallet" or "original"', 400, 'INVALID_DESTINATION');
  }
  const b = await bookings.load(bookingId);
  if (!bookings.isCancelled(b)) {
    throw new AppError('Booking must be cancelled before a refund can be issued', 409, 'BOOKING_NOT_CANCELLED');
  }
  const { payment, deposit } = await loadContext(bookingId);

  const uid = sid(user._id || user.id);
  const role = normalizeRole(user.role);
  if (role !== 'admin' && sid(payment.renter) !== uid && sid(payment.owner) !== uid) {
    throw new AppError('Not allowed', 403, 'FORBIDDEN');
  }
  const cancelledBy = role === 'admin' ? 'admin' : sid(payment.owner) === uid ? 'owner' : 'renter';

  const existing = await Refund.findOne({ payment: payment._id, kind: 'cancellation' });
  if (existing) return existing;

  if (payment.method === PAYMENT_METHOD.WALLET && destination === 'original') {
    // Wallet-funded payments have no card to go back to
    destination = 'wallet';
  }
  if (deposit && ![DS.HELD, DS.PENDING].includes(deposit.status) && payment.depositAmount > 0) {
    throw new AppError('Deposit was already settled; cannot refund via cancellation', 409, 'DEPOSIT_ALREADY_SETTLED');
  }

  const calc = compute(payment, cancelledBy);

  return runInTransaction(async (session) => {
    const [refund] = await Refund.create(
      [
        {
          payment: payment._id,
          booking: bookingId,
          renter: payment.renter,
          requestedBy: uid,
          cancelledBy,
          destination,
          rentalRefund: calc.refundRental,
          depositRefund: calc.refundDeposit,
          amount: calc.refundTotal,
          ownerEarningReversal: calc.ownerEarningReversal,
          commissionReversal: calc.commissionReversal,
          policyReason: calc.reason,
          status: calc.refundTotal === 0 ? RS.PROCESSED : RS.PENDING,
          processedAt: calc.refundTotal === 0 ? new Date() : undefined,
        },
      ],
      { session: session || undefined }
    );

    // 1. Remove owner's share of the refunded rental (from pending, or available if already released)
    if (calc.ownerEarningReversal > 0) {
      await wallet.debit(
        {
          userId: payment.owner,
          amount: calc.ownerEarningReversal,
          bucket: payment.earningsReleased ? WALLET_BUCKET.AVAILABLE : WALLET_BUCKET.PENDING,
          type: TX.EARNING_REVERSAL,
          idempotencyKey: `earning-reversal:${refund._id}`,
          links: { payment: payment._id, booking: bookingId, refund: refund._id },
          description: 'Booking cancelled - earning reversed',
        },
        session
      );
    }

    // 2. Close out the deposit (full amount goes back, settled as part of this refund)
    if (deposit && calc.refundDeposit > 0) {
      await Deposit.findOneAndUpdate(
        { _id: deposit._id, status: { $in: [DS.HELD, DS.PENDING] } },
        { $set: { status: DS.RELEASED, releasedAmount: calc.refundDeposit, resolvedAt: new Date(), 'claimLock.locked': false } },
        { session: session || undefined }
      );
    }

    // 3. Payment bookkeeping - only when money was actually refunded. A cancellation after the rental
    //    started refunds nothing, so the payment stays 'succeeded' and the booking stays 'paid'.
    if (calc.refundTotal > 0) {
      const newRefunded = payment.refundedAmount + calc.refundTotal;
      await Payment.updateOne(
        { _id: payment._id },
        {
          $set: { refundedAmount: newRefunded, status: newRefunded >= payment.totalAmount ? PS.REFUNDED : PS.PARTIALLY_REFUNDED },
          $inc: { ownerEarningReversed: calc.ownerEarningReversal, commissionReversed: calc.commissionReversal },
        },
        { session: session || undefined }
      );
      await bookings.markRefunded(bookingId, session);
    }

    // 4. Money back to renter
    if (calc.refundTotal > 0 && destination === 'wallet') {
      await wallet.credit(
        {
          userId: payment.renter,
          amount: calc.refundTotal,
          type: TX.REFUND,
          idempotencyKey: `refund:${refund._id}`,
          links: { payment: payment._id, booking: bookingId, refund: refund._id },
          description: calc.reason,
        },
        session
      );
      refund.status = RS.PROCESSED;
      refund.processedAt = new Date();
      await refund.save({ session: session || undefined });
    }
    return refund;
  });
}

/** Admin: push a pending 'original' refund through the payment gateway. */
async function processGatewayRefund(refundId, admin) {
  const refund = await Refund.findById(refundId);
  if (!refund) throw new AppError('Refund not found', 404, 'REFUND_NOT_FOUND');
  if (refund.status === RS.PROCESSED) return refund;
  if (refund.destination !== 'original') throw new AppError('This refund is paid to the wallet', 409, 'WRONG_DESTINATION');

  const payment = await Payment.findById(refund.payment);
  try {
    const out = await gateway.refund({ reference: payment.providerReference || payment.reference, amount: refund.amount });
    refund.status = RS.PROCESSED;
    refund.providerReference = out.providerReference;
    refund.processedAt = new Date();
    refund.processedBy = admin._id || admin.id;
    refund.failureReason = undefined;
  } catch (err) {
    refund.status = RS.FAILED;
    refund.failureReason = err.message;
  }
  await refund.save();
  return refund;
}

async function listRefunds(user, { page = 1, limit = 20, status } = {}) {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100, Math.max(1, Number(limit) || 20));
  const uid = sid(user._id || user.id);
  const filter = normalizeRole(user.role) === 'admin' ? {} : { renter: uid };
  if (status) filter.status = status;
  const [items, total] = await Promise.all([
    Refund.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l).lean(),
    Refund.countDocuments(filter),
  ]);
  return { items, meta: { page: p, limit: l, total, pages: Math.ceil(total / l) } };
}

module.exports = { previewCancellation, refundCancelledBooking, processGatewayRefund, listRefunds };
