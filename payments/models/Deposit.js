const mongoose = require('mongoose');
const { DEPOSIT_STATUS } = require('../constants');

const { ObjectId } = mongoose.Schema.Types;

const depositSchema = new mongoose.Schema(
  {
    payment: { type: ObjectId, ref: 'Payment', required: true, unique: true },
    booking: { type: ObjectId, ref: 'Booking', required: true, index: true },
    equipment: { type: ObjectId, ref: 'Equipment' },
    renter: { type: ObjectId, ref: 'User', required: true, index: true },
    owner: { type: ObjectId, ref: 'User', required: true, index: true },

    amount: { type: Number, required: true, min: 1 }, // integer kobo
    status: { type: String, enum: Object.values(DEPOSIT_STATUS), default: DEPOSIT_STATUS.PENDING, index: true },

    heldAt: Date,
    releaseDueAt: Date, // auto-release time if nobody raises a claim
    resolvedAt: Date,

    deductedAmount: { type: Number, default: 0, min: 0 }, // paid to owner (damage)
    releasedAmount: { type: Number, default: 0, min: 0 }, // returned to renter

    // The Damage Claim module locks the deposit while a claim is open
    claimLock: {
      locked: { type: Boolean, default: false },
      claimId: { type: ObjectId },
      lockedAt: Date,
    },

    deductions: [
      {
        claimId: { type: ObjectId },
        amount: Number,
        reason: String,
        at: { type: Date, default: Date.now },
        _id: false,
      },
    ],
  },
  { timestamps: true }
);

depositSchema.index({ status: 1, releaseDueAt: 1 });

module.exports = mongoose.models.Deposit || mongoose.model('Deposit', depositSchema);
