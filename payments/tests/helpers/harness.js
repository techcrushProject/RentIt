'use strict';
/**
 * Test harness. Requiring this file FIRST swaps `mongoose` and `express` for the fakes, then loads the
 * real payments module, so every test exercises the production code unchanged.
 */
const Module = require('module');
const path = require('path');
const assert = require('node:assert/strict');
const fake = require('./fake-mongoose');
const fakeExpress = require('./fake-express');

const origLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === 'mongoose') return fake.mongoose;
  if (request === 'express') return fakeExpress.express;
  return origLoad.call(this, request, ...rest);
};

const ROOT = path.join(__dirname, '..', '..');
const mod = require(ROOT);
const walletService = require(path.join(ROOT, 'services', 'wallet.service'));
const payoutService = require(path.join(ROOT, 'services', 'payout.service'));
const gateway = require(path.join(ROOT, 'gateway'));
const config = require(path.join(ROOT, 'config'));

const { mongoose } = fake;
const bookingSchema = new mongoose.Schema(
  {
    renter: { type: mongoose.Schema.Types.ObjectId },
    owner: { type: mongoose.Schema.Types.ObjectId },
    equipment: { type: mongoose.Schema.Types.ObjectId },
    totalPrice: { type: Number }, // naira, as in config.booking.amountsInMinorUnits = false
    securityDeposit: { type: Number },
    startDate: { type: Date },
    endDate: { type: Date },
    status: { type: String, default: 'pending' },
    paymentStatus: { type: String, default: 'unpaid' },
  },
  { timestamps: true }
);
const Booking = mongoose.model('Booking', bookingSchema);

const HOUR = 3600e3;
const oid = () => new mongoose.Types.ObjectId();

function mkUser(role, extra = {}) {
  const _id = oid();
  return { _id, id: String(_id), role, email: `${role}-${String(_id).slice(-6)}@test.dev`, ...extra };
}

/** Default booking = ₦50,000 rental + ₦20,000 deposit (5,000,000 + 2,000,000 kobo), starting in 72h for 24h. */
async function mkBooking({ renter, owner, price = 50000, deposit = 20000, startInHours = 72, hours = 24, status = 'approved' }) {
  const start = new Date(Date.now() + startInHours * HOUR);
  return Booking.create({
    renter: renter._id,
    owner: owner._id,
    equipment: oid(),
    totalPrice: price,
    securityDeposit: deposit,
    startDate: start,
    endDate: new Date(start.getTime() + hours * HOUR),
    status,
  });
}

/** Renter pays by card and the gateway confirms. Returns the succeeded payment. */
async function payBooking(booking, renter) {
  const p = await mod.services.paymentService.createCheckout(renter, { bookingId: booking._id, method: 'card' });
  return mod.services.paymentService.confirmByReference(p.reference);
}

const cancelBooking = (booking) => Booking.updateOne({ _id: booking._id }, { $set: { status: 'cancelled' } });
const getBooking = (booking) => Booking.findById(booking._id);
const wallet = async (user) => {
  const w = await walletService.getWallet(user._id);
  return { balance: w.balance, pending: w.pendingBalance };
};
const seedBalance = (user, amount, key = `seed:${oid()}`) =>
  walletService.credit({ userId: user._id, amount, type: 'topup', idempotencyKey: key, description: 'test seed' });

async function expectErr(promise, code, status) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, code, `expected error ${code} but got ${e.code}: ${e.message}`);
    if (status) assert.equal(e.statusCode, status);
    return true;
  });
}

module.exports = {
  fake,
  mod,
  config,
  gateway,
  Booking,
  oid,
  HOUR,
  mkUser,
  mkBooking,
  payBooking,
  cancelBooking,
  getBooking,
  wallet,
  seedBalance,
  expectErr,
  reset: fake.reset,
  svc: {
    payment: mod.services.paymentService,
    deposit: mod.services.depositService,
    refund: mod.services.refundService,
    wallet: walletService,
    payout: payoutService,
  },
  models: mod.models,
};
