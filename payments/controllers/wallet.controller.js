const wallet = require('../services/wallet.service');
const { asyncHandler, sendOk, userId } = require('../utils/helpers');

exports.me = asyncHandler(async (req, res) => sendOk(res, await wallet.getWallet(userId(req.user))));

exports.transactions = asyncHandler(async (req, res) => {
  const { items, meta } = await wallet.listTransactions(userId(req.user), req.query);
  sendOk(res, items, 200, meta);
});
