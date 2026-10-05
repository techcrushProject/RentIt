const mongoose = require('mongoose');
const config = require('../config');
const { PAYMENT_STATUS, PAYMENT_PURPOSE, PAYMENT_METHOD } = require('../constants');

const { ObjectId } = mongoose.Schema.Types;
const money = { type: Number, default: 0, min: 0 };

const paymentSchema = new mongoose.Schema(
  {
    reference: { type: String, required: true, unique: true },
    purpose: { type: String, enum: Object.values(PAYMENT_PURPOSE), default: PAYMENT_PURPOSE.RENTAL },
    booking: { type: ObjectId, ref: 'Booking' },
    equipment: { type: ObjectId, ref: 'Equipment' },
    renter: { type: ObjectId, ref: 'User', required: true, index: true },
    owner: { type: ObjectId, ref: 'User', index: true },

    method: { type: String, enum: Object.values(PAYMENT_METHOD), required: true },
    provider: { type: String, default: config.provider },
    providerReference: String,
    checkoutUrl: String,
    currency: { type: String, default: config.currency },

    // All integer minor units (kobo)
    rentalAmount: money,
    depositAmount: money,
    commissionRate: { type: Number, default: 0 },
    commissionAmount: money, // platform revenue
    ownerEarning: money, // rentalAmount - commissionAmount
    totalAmount: { type: Number, required: true, min: 1 }, // what the renter is charged

    status: { type: String, enum: Object.values(PAYMENT_STATUS), default: PAYMENT_STATUS.PENDING, index: true },
    isPaid: { type: Boolean, default: false }, // set true on success, never reset (used by unique index)
    paidAt: Date,
    failureReason: String,

    rentalStartDate: Date,
    rentalEndDate: Date,

    earningsReleased: { type: Boolean, default: false },
    earningsReleasedAt: Date,

    refundedAmount: money,
    ownerEarningReversed: money, // portion of ownerEarning removed because of refunds
    commissionReversed: money, // portion of platform commission given back because of refunds
  },
  { timestamps: true }
);

// A booking can only ever be paid for once
paymentSchema.index(
  { booking: 1 },
  { unique: true, partialFilterExpression: { isPaid: true, purpose: PAYMENT_PURPOSE.RENTAL } }
);

module.exports = mongoose.models.Payment || mongoose.model('Payment', paymentSchema);
