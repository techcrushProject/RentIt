const payouts = require('../services/payout.service');
const { asyncHandler, sendOk, assertObjectId } = require('../utils/helpers');

exports.request = asyncHandler(async (req, res) => sendOk(res, await payouts.requestPayout(req.user, req.body || {}), 201));

exports.list = asyncHandler(async (req, res) => {
  const { items, meta } = await payouts.listPayouts(req.user, req.query);
  sendOk(res, items, 200, meta);
});

exports.getOne = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'payout id');
  sendOk(res, await payouts.getPayout(req.params.id, req.user));
});

exports.approve = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'payout id');
  sendOk(res, await payouts.approvePayout(req.params.id, req.user));
});

exports.markPaid = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'payout id');
  sendOk(res, await payouts.markPayoutPaid(req.params.id, req.user, req.body || {}));
});

exports.reject = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'payout id');
  sendOk(res, await payouts.rejectPayout(req.params.id, req.user, req.body || {}));
});
