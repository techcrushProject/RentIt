/**
 * Payment & Deposit module configuration.
 * ALL money values in this module are INTEGERS in minor units (kobo for NGN).
 * e.g. ₦1,500.00 === 150000
 */
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

module.exports = {
  currency: process.env.PAYMENT_CURRENCY || 'NGN',

  // 'demo' (default, no external calls) or 'paystack'
  provider: process.env.PAYMENT_PROVIDER || 'demo',
  callbackUrl: process.env.PAYMENT_CALLBACK_URL || 'http://localhost:3000/payment/callback',
  webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET || 'demo-webhook-secret',
  paystackSecretKey: process.env.PAYSTACK_SECRET_KEY || '',

  // Platform commission taken from the RENTAL amount only (never from the deposit)
  commissionRate: num(process.env.PLATFORM_COMMISSION_RATE, 0.1),

  // Pending (unpaid) card checkouts are reused for this long, then replaced
  checkoutExpiryMinutes: num(process.env.CHECKOUT_EXPIRY_MINUTES, 30),

  // Smallest payout an owner can request (default ₦1,000)
  minPayoutAmount: num(process.env.MIN_PAYOUT_AMOUNT, 100000),

  // Smallest / largest wallet top-up (default ₦500 / ₦1,000,000)
  minTopupAmount: num(process.env.MIN_TOPUP_AMOUNT, 50000),
  maxTopupAmount: num(process.env.MAX_TOPUP_AMOUNT, 100000000),

  deposit: {
    // After rental end date, an unclaimed deposit is auto-released to the renter after this delay
    autoReleaseDelayHours: num(process.env.DEPOSIT_AUTO_RELEASE_HOURS, 48),
  },

  // Renter-initiated cancellation policy (hours BEFORE rental start)
  cancellation: {
    fullRefundHours: num(process.env.CANCEL_FULL_REFUND_HOURS, 48),
    partialRefundHours: num(process.env.CANCEL_PARTIAL_REFUND_HOURS, 24),
    partialRefundRate: num(process.env.CANCEL_PARTIAL_REFUND_RATE, 0.5),
  },

  /**
   * Booking module mapping. The payment module never touches the Booking model
   * directly outside services/booking-adapter.js. If your teammate's Booking
   * schema uses different names, change them HERE only.
   */
  booking: {
    modelName: 'Booking',
    fields: {
      renter: 'renter',
      owner: 'owner',
      equipment: 'equipment',
      rentalAmount: 'totalPrice', // rental price for the whole period
      depositAmount: 'securityDeposit',
      startDate: 'startDate',
      endDate: 'endDate',
      status: 'status',
      paymentStatus: 'paymentStatus',
    },
    // true if booking amounts are already stored in kobo; false if in naira (decimals allowed)
    amountsInMinorUnits: false,
    payableStatuses: ['approved', 'confirmed'],
    cancelledStatuses: ['cancelled', 'canceled'],
    // status to move the booking to once paid (null = leave status alone, only set paymentStatus)
    statusAfterPayment: null,
  },
};
