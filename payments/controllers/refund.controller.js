const refunds = require('../services/refund.service');
const { asyncHandler, sendOk, assertObjectId } = require('../utils/helpers');

exports.preview = asyncHandler(async (req, res) => {
  assertObjectId(req.params.bookingId, 'bookingId');
  sendOk(res, await refunds.previewCancellation(req.params.bookingId, req.user));
});

exports.refundBooking = asyncHandler(async (req, res) => {
  assertObjectId(req.params.bookingId, 'bookingId');
  sendOk(
    res,
    await refunds.refundCancelledBooking(req.params.bookingId, req.user, { destination: req.body?.destination }),
    201
  );
});

exports.list = asyncHandler(async (req, res) => {
  const { items, meta } = await refunds.listRefunds(req.user, req.query);
  sendOk(res, items, 200, meta);
});

exports.process = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'refund id');
  sendOk(res, await refunds.processGatewayRefund(req.params.id, req.user));
});
