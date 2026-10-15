const mongoose = require('mongoose');
const { PAYOUT_STATUS } = require('../constants');

const { ObjectId } = mongoose.Schema.Types;

const payoutSchema = new mongoose.Schema(
  {
    owner: { type: ObjectId, ref: 'User', required: true, index: true },
    amount: { type: Number, required: true, min: 1 }, // integer kobo, debited from wallet on request
    status: { type: String, enum: Object.values(PAYOUT_STATUS), default: PAYOUT_STATUS.REQUESTED, index: true },

    bank: {
      bankName: { type: String, required: true, trim: true },
      bankCode: { type: String, trim: true },
      accountNumber: { type: String, required: true, trim: true },
      accountName: { type: String, required: true, trim: true },
    },

    requestedAt: { type: Date, default: Date.now },
    approvedAt: Date,
    paidAt: Date,
    rejectedAt: Date,
    rejectionReason: String,
    transferReference: String, // bank/gateway transfer reference entered by admin when marked paid
    processedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Never leak full account numbers in JSON by default
payoutSchema.methods.toJSON = function toJSON() {
  const obj = this.toObject();
  if (obj.bank && obj.bank.accountNumber) {
    obj.bank.accountNumber = `******${obj.bank.accountNumber.slice(-4)}`;
  }
  return obj;
};

module.exports = mongoose.models.Payout || mongoose.model('Payout', payoutSchema);
