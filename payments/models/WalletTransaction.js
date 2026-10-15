const mongoose = require('mongoose');
const { WALLET_TX_TYPE, WALLET_BUCKET } = require('../constants');

const { ObjectId } = mongoose.Schema.Types;

/** Append-only ledger. One row per wallet movement. Never updated or deleted. */
const walletTransactionSchema = new mongoose.Schema(
  {
    wallet: { type: ObjectId, ref: 'Wallet', required: true },
    user: { type: ObjectId, ref: 'User', required: true, index: true },
    direction: { type: String, enum: ['credit', 'debit'], required: true },
    bucket: { type: String, enum: Object.values(WALLET_BUCKET), default: WALLET_BUCKET.AVAILABLE },
    type: { type: String, enum: Object.values(WALLET_TX_TYPE), required: true },
    amount: { type: Number, required: true, min: 1 },
    balanceAfter: { type: Number, required: true },
    // Guarantees a business event can only hit the ledger once (safe retries / duplicate webhooks)
    idempotencyKey: { type: String, required: true, unique: true },
    payment: { type: ObjectId, ref: 'Payment' },
    booking: { type: ObjectId, ref: 'Booking' },
    deposit: { type: ObjectId, ref: 'Deposit' },
    payout: { type: ObjectId, ref: 'Payout' },
    refund: { type: ObjectId, ref: 'Refund' },
    description: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

walletTransactionSchema.index({ user: 1, createdAt: -1 });

module.exports =
  mongoose.models.WalletTransaction || mongoose.model('WalletTransaction', walletTransactionSchema);
