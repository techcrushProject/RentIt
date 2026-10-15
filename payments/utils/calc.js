/**
 * Pure money maths - no DB, fully unit-tested. All values are integer minor units (kobo).
 */
const config = require('../config');

const calcCommission = (rentalAmount, rate = config.commissionRate) => Math.round(rentalAmount * rate);

/** Split what a renter pays into rental / deposit / platform commission / owner earning. */
function splitPayment({ rentalAmount, depositAmount = 0 }, rate = config.commissionRate) {
  const commissionAmount = calcCommission(rentalAmount, rate);
  return {
    rentalAmount,
    depositAmount,
    commissionRate: rate,
    commissionAmount,
    ownerEarning: rentalAmount - commissionAmount,
    totalAmount: rentalAmount + depositAmount,
  };
}

/**
 * Cancellation refund policy.
 * - Owner/admin cancels  -> 100% rental refund
 * - Renter cancels >= fullRefundHours before start      -> 100% rental
 * - Renter cancels >= partialRefundHours before start   -> partialRefundRate of rental
 * - Renter cancels later                                -> 0% rental
 * Security deposit is ALWAYS fully refunded on a pre-start cancellation (equipment never left).
 * Platform commission is reversed proportionally to the rental refunded.
 */
function cancellationRefund({
  rentalAmount,
  ownerEarning,
  depositAmount,
  startDate,
  cancelledAt = new Date(),
  cancelledBy = 'renter',
  policy = config.cancellation,
}) {
  const hoursBeforeStart = (new Date(startDate).getTime() - new Date(cancelledAt).getTime()) / 36e5;
  const started = hoursBeforeStart < 0;

  let rate;
  let reason;
  if (cancelledBy !== 'renter') {
    rate = 1;
    reason = 'Cancelled by owner/admin - full rental refund';
  } else if (hoursBeforeStart >= policy.fullRefundHours) {
    rate = 1;
    reason = `Cancelled ${policy.fullRefundHours}h or more before start - full rental refund`;
  } else if (hoursBeforeStart >= policy.partialRefundHours) {
    rate = policy.partialRefundRate;
    reason = `Cancelled ${policy.partialRefundHours}-${policy.fullRefundHours}h before start - partial rental refund`;
  } else {
    rate = 0;
    reason = `Cancelled less than ${policy.partialRefundHours}h before start - no rental refund`;
  }

  const refundRental = Math.round(rentalAmount * rate);
  const refundDeposit = started ? 0 : depositAmount;
  const ownerEarningReversal = rentalAmount > 0 ? Math.round((ownerEarning * refundRental) / rentalAmount) : 0;

  return {
    rate,
    reason,
    hoursBeforeStart: Math.round(hoursBeforeStart * 10) / 10,
    refundRental,
    refundDeposit,
    refundTotal: refundRental + refundDeposit,
    ownerEarningReversal,
    commissionReversal: refundRental - ownerEarningReversal,
  };
}

const depositRemaining = (d) => d.amount - (d.deductedAmount || 0) - (d.releasedAmount || 0);

module.exports = { calcCommission, splitPayment, cancellationRefund, depositRemaining };
