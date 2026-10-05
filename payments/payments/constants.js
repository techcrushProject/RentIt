module.exports = {
  PAYMENT_PURPOSE: { RENTAL: 'rental', WALLET_TOPUP: 'wallet_topup' },
  PAYMENT_METHOD: { CARD: 'card', WALLET: 'wallet' },
  PAYMENT_STATUS: {
    PENDING: 'pending',
    SUCCEEDED: 'succeeded',
    FAILED: 'failed',
    EXPIRED: 'expired',
    PARTIALLY_REFUNDED: 'partially_refunded',
    REFUNDED: 'refunded',
  },
  DEPOSIT_STATUS: {
    PENDING: 'pending', // checkout created, not yet paid
    HELD: 'held', // paid and held by the platform
    RELEASED: 'released', // fully returned to renter
    PARTIALLY_DEDUCTED: 'partially_deducted', // damage deduction paid to owner, rest to renter
    FORFEITED: 'forfeited', // entire deposit paid to owner
  },
  REFUND_STATUS: { PENDING: 'pending', PROCESSED: 'processed', FAILED: 'failed' },
  PAYOUT_STATUS: { REQUESTED: 'requested', APPROVED: 'approved', PAID: 'paid', REJECTED: 'rejected' },
  WALLET_BUCKET: { AVAILABLE: 'balance', PENDING: 'pendingBalance' },
  WALLET_TX_TYPE: {
    TOPUP: 'topup',
    RENTAL_PAYMENT: 'rental_payment',
    OWNER_EARNING: 'owner_earning', // credited to owner's pending bucket on payment
    EARNING_RELEASE: 'earning_release', // pending -> available on rental completion
    EARNING_REVERSAL: 'earning_reversal', // owner earning removed on refund
    DEPOSIT_RELEASE: 'deposit_release', // deposit back to renter
    DAMAGE_DEDUCTION: 'damage_deduction', // part/all of deposit to owner
    REFUND: 'refund',
    PAYOUT: 'payout',
    PAYOUT_REVERSAL: 'payout_reversal',
  },
  ROLES: { RENTER: 'renter', OWNER: 'owner', ADMIN: 'admin' },
};
