const mongoose = require('mongoose');
const Payout = require('../models/Payout');
const config = require('../config');
const wallet = require('./wallet.service');
const AppError = require('../utils/AppError');
const { runInTransaction, normalizeRole } = require('../utils/helpers');
const { PAYOUT_STATUS: PO, WALLET_TX_TYPE: TX } = require('../constants');

const sid = (v) => (v ? String(v) : null);

async function requestPayout(owner, { amount, bankName, bankCode, accountNumber, accountName }) {
  if (!Number.isInteger(amount) || amount < config.minPayoutAmount) {
    throw new AppError(`amount must be an integer in kobo, minimum ${config.minPayoutAmount}`, 400, 'INVALID_AMOUNT');
  }
  if (!bankName || !accountNumber || !accountName) {
    throw new AppError('bankName, accountNumber and accountName are required', 400, 'INVALID_BANK_DETAILS');
  }
  if (!/^\d{10}$/.test(String(accountNumber))) {
    throw new AppError('accountNumber must be a 10-digit NUBAN number', 400, 'INVALID_BANK_DETAILS');
  }

  const ownerId = sid(owner._id || owner.id);
  const payoutId = new mongoose.Types.ObjectId();

  return runInTransaction(async (session) => {
    // Debit first - if the balance is too low this throws 402 and nothing is created
    await wallet.debit(
      {
        userId: ownerId,
        amount,
        type: TX.PAYOUT,
        idempotencyKey: `payout:${payoutId}`,
        links: { payout: payoutId },
        description: 'Payout requested',
      },
      session
    );
    const [payout] = await Payout.create(
      [
        {
          _id: payoutId,
          owner: ownerId,
          amount,
          bank: { bankName, bankCode, accountNumber: String(accountNumber), accountName },
        },
      ],
      { session: session || undefined }
    );
    return payout;
  });
}

async function listPayouts(user, { page = 1, limit = 20, status } = {}) {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100, Math.max(1, Number(limit) || 20));
  const filter = normalizeRole(user.role) === 'admin' ? {} : { owner: sid(user._id || user.id) };
  if (status) filter.status = status;
  const [items, total] = await Promise.all([
    Payout.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l),
    Payout.countDocuments(filter),
  ]);
  return { items, meta: { page: p, limit: l, total, pages: Math.ceil(total / l) } };
}

async function getPayout(id, user) {
  const po = await Payout.findById(id);
  if (!po) throw new AppError('Payout not found', 404, 'PAYOUT_NOT_FOUND');
  if (normalizeRole(user.role) !== 'admin' && sid(po.owner) !== sid(user._id || user.id)) {
    throw new AppError('Not allowed', 403, 'FORBIDDEN');
  }
  return po;
}

const transition = async (id, from, set, admin) => {
  const po = await Payout.findOneAndUpdate(
    { _id: id, status: { $in: from } },
    { $set: { ...set, processedBy: admin._id || admin.id } },
    { new: true }
  );
  if (!po) {
    const exists = await Payout.findById(id);
    if (!exists) throw new AppError('Payout not found', 404, 'PAYOUT_NOT_FOUND');
    throw new AppError(`Payout is ${exists.status}; action not allowed`, 409, 'INVALID_STATE');
  }
  return po;
};

const approvePayout = (id, admin) => transition(id, [PO.REQUESTED], { status: PO.APPROVED, approvedAt: new Date() }, admin);

/** Admin confirms the bank transfer was made and records its reference. */
async function markPayoutPaid(id, admin, { transferReference }) {
  if (!transferReference) throw new AppError('transferReference is required', 400, 'INVALID_INPUT');
  return transition(
    id,
    [PO.REQUESTED, PO.APPROVED],
    { status: PO.PAID, paidAt: new Date(), transferReference },
    admin
  );
}

/** Rejecting returns the money to the owner's wallet. */
async function rejectPayout(id, admin, { reason }) {
  if (!reason) throw new AppError('reason is required', 400, 'INVALID_INPUT');
  return runInTransaction(async (session) => {
    const po = await Payout.findOneAndUpdate(
      { _id: id, status: { $in: [PO.REQUESTED, PO.APPROVED] } },
      { $set: { status: PO.REJECTED, rejectedAt: new Date(), rejectionReason: reason, processedBy: admin._id || admin.id } },
      { new: true, session: session || undefined }
    );
    if (!po) {
      const exists = await Payout.findById(id).session(session || null);
      if (!exists) throw new AppError('Payout not found', 404, 'PAYOUT_NOT_FOUND');
      throw new AppError(`Payout is ${exists.status}; action not allowed`, 409, 'INVALID_STATE');
    }
    await wallet.credit(
      {
        userId: po.owner,
        amount: po.amount,
        type: TX.PAYOUT_REVERSAL,
        idempotencyKey: `payout-reversal:${po._id}`,
        links: { payout: po._id },
        description: `Payout rejected: ${reason}`,
      },
      session
    );
    return po;
  });
}

module.exports = { requestPayout, listPayouts, getPayout, approvePayout, markPayoutPaid, rejectPayout };
