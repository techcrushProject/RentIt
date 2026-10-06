/**
 * The ONLY place the payment module touches the Booking model.
 * Adjust field names in config.js -> booking.fields if the Booking schema differs.
 */
const mongoose = require('mongoose');
const config = require('../config');
const AppError = require('../utils/AppError');

const cfg = config.booking;
const F = cfg.fields;

const toMinor = (v) => (cfg.amountsInMinorUnits ? Math.round(Number(v) || 0) : Math.round((Number(v) || 0) * 100));

const BookingModel = () => {
  try {
    return mongoose.model(cfg.modelName);
  } catch (e) {
    throw new AppError(`Booking model "${cfg.modelName}" is not registered`, 500, 'BOOKING_MODEL_MISSING');
  }
};

const idOf = (v) => (v && v._id ? String(v._id) : v ? String(v) : null);

function normalize(doc) {
  return {
    id: String(doc._id),
    renterId: idOf(doc.get(F.renter)),
    ownerId: idOf(doc.get(F.owner)),
    equipmentId: idOf(doc.get(F.equipment)),
    rentalAmount: toMinor(doc.get(F.rentalAmount)),
    depositAmount: toMinor(doc.get(F.depositAmount)),
    startDate: doc.get(F.startDate),
    endDate: doc.get(F.endDate),
    status: String(doc.get(F.status) || '').toLowerCase(),
  };
}

async function load(bookingId, session) {
  const doc = await BookingModel().findById(bookingId).session(session || null);
  if (!doc) throw new AppError('Booking not found', 404, 'BOOKING_NOT_FOUND');
  const b = normalize(doc);
  if (!b.ownerId) throw new AppError('Booking has no owner', 422, 'BOOKING_INVALID');
  return b;
}

const isPayable = (b) => cfg.payableStatuses.includes(b.status);
const isCancelled = (b) => cfg.cancelledStatuses.includes(b.status);

async function markPaid(bookingId, session) {
  const update = { [F.paymentStatus]: 'paid' };
  if (cfg.statusAfterPayment) update[F.status] = cfg.statusAfterPayment;
  await BookingModel().updateOne({ _id: bookingId }, { $set: update }, { session: session || undefined, strict: false });
}

async function markRefunded(bookingId, session) {
  await BookingModel().updateOne(
    { _id: bookingId },
    { $set: { [F.paymentStatus]: 'refunded' } },
    { session: session || undefined, strict: false }
  );
}

module.exports = { load, isPayable, isCancelled, markPaid, markRefunded };
