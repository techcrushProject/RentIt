const mongoose = require('mongoose');
const { REFUND_STATUS } = require('../constants');

const { ObjectId } = mongoose.Schema.Types;

const refundSchema = new mongoose.Schema(
  {
    payment: { type: ObjectId, ref: 'Payment', required: true, index: true },
    booking: { type: ObjectId, ref: 'Booking', required: true, index: true },
    renter: { type: ObjectId, ref: 'User', required: true, index: true },
    requestedBy: { type: ObjectId, ref: 'User' },
    cancelledBy: { type: String, enum: ['renter', 'owner', 'admin'], required: true },
    kind: { type: String, enum: ['cancellation'], default: 'cancellation' },

    // 'wallet' = instant credit to renter's wallet. 'original' = back to card via gateway (admin processes).
    destination: { type: String, enum: ['wallet', 'original'], default: 'wallet' },

    rentalRefund: { type: Number, default: 0, min: 0 },
    depositRefund: { type: Number, default: 0, min: 0 },
    amount: { type: Number, required: true, min: 0 }, // rentalRefund + depositRefund
    ownerEarningReversal: { type: Number, default: 0, min: 0 },
    commissionReversal: { type: Number, default: 0, min: 0 },
    policyReason: String,

    status: { type: String, enum: Object.values(REFUND_STATUS), default: REFUND_STATUS.PENDING, index: true },
    providerReference: String,
    failureReason: String,
    processedAt: Date,
    processedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// One cancellation refund per payment
refundSchema.index({ payment: 1, kind: 1 }, { unique: true, partialFilterExpression: { kind: 'cancellation' } });

module.exports = mongoose.models.Refund || mongoose.model('Refund', refundSchema);
