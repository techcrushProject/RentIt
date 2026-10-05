const deposits = require('../services/deposit.service');
const { asyncHandler, sendOk, assertObjectId } = require('../utils/helpers');

exports.getOne = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'deposit id');
  sendOk(res, await deposits.getDeposit(req.params.id, req.user));
});

exports.byBooking = asyncHandler(async (req, res) => {
  assertObjectId(req.params.bookingId, 'bookingId');
  sendOk(res, await deposits.getDepositByBooking(req.params.bookingId, req.user));
});

exports.release = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'deposit id');
  sendOk(res, await deposits.confirmReturnAndRelease(req.params.id, req.user));
});

/** Admin manual deduction (normally the Damage Claim module calls resolveClaim() directly). */
exports.deduct = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'deposit id');
  const { amount, reason, claimId } = req.body || {};
  sendOk(
    res,
    await deposits.settleDeposit(req.params.id, { deductionAmount: amount, claimId, reason })
  );
});

exports.runAutoRelease = asyncHandler(async (_req, res) => sendOk(res, await deposits.releaseDueDeposits()));
