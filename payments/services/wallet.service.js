const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const AppError = require('../utils/AppError');
const { assertPositiveInt } = require('../utils/helpers');
const { WALLET_BUCKET } = require('../constants');

const getOrCreateWallet = (userId, session) =>
  Wallet.findOneAndUpdate(
    { user: userId },
    { $setOnInsert: { user: userId } },
    { upsert: true, new: true, setDefaultsOnInsert: true, session: session || undefined }
  );

/**
 * Core ledger write. Atomic balance update + append-only ledger row.
 * Idempotent: the same idempotencyKey never applies twice (returns duplicate: true).
 * Debits are guarded in the DB query itself so a balance can never go negative.
 */
async function applyEntry(
  { userId, amount, direction, type, idempotencyKey, bucket = WALLET_BUCKET.AVAILABLE, links = {}, description },
  session
) {
  assertPositiveInt(amount);
  if (!idempotencyKey) throw new AppError('idempotencyKey required', 500, 'LEDGER_KEY_MISSING');

  const existing = await WalletTransaction.findOne({ idempotencyKey }).session(session || null);
  if (existing) return { tx: existing, duplicate: true };

  await getOrCreateWallet(userId, session);

  const filter = { user: userId };
  if (direction === 'debit') filter[bucket] = { $gte: amount };

  const wallet = await Wallet.findOneAndUpdate(
    filter,
    { $inc: { [bucket]: direction === 'credit' ? amount : -amount } },
    { new: true, session: session || undefined }
  );
  if (!wallet) throw new AppError('Insufficient wallet balance', 402, 'INSUFFICIENT_FUNDS');

  const [tx] = await WalletTransaction.create(
    [
      {
        wallet: wallet._id,
        user: userId,
        direction,
        bucket,
        type,
        amount,
        balanceAfter: wallet[bucket],
        idempotencyKey,
        description,
        ...links,
      },
    ],
    { session: session || undefined }
  );
  return { tx, wallet, duplicate: false };
}

const credit = (params, session) => applyEntry({ ...params, direction: 'credit' }, session);
const debit = (params, session) => applyEntry({ ...params, direction: 'debit' }, session);

async function getWallet(userId) {
  const w = await getOrCreateWallet(userId);
  return {
    balance: w.balance,
    pendingBalance: w.pendingBalance,
    currency: w.currency,
    updatedAt: w.updatedAt,
  };
}

async function listTransactions(userId, { page = 1, limit = 20, type } = {}) {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100, Math.max(1, Number(limit) || 20));
  const filter = { user: userId, ...(type ? { type } : {}) };
  const [items, total] = await Promise.all([
    WalletTransaction.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l).lean(),
    WalletTransaction.countDocuments(filter),
  ]);
  return { items, meta: { page: p, limit: l, total, pages: Math.ceil(total / l) } };
}

module.exports = { getOrCreateWallet, credit, debit, getWallet, listTransactions };
