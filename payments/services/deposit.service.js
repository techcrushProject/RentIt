const Deposit = require('../models/Deposit');
const wallet = require('./wallet.service');
const AppError = require('../utils/AppError');
const { depositRemaining } = require('../utils/calc');
const { runInTransaction, normalizeRole } = require('../utils/helpers');
const { DEPOSIT_STATUS: DS, WALLET_TX_TYPE: TX } = require('../constants');

const sid = (v) => (v ? String(v) : null);

async function getDeposit(id, user) {
  const d = await Deposit.findById(id);
  if (!d) throw new AppError('Deposit not found', 404, 'DEPOSIT_NOT_FOUND');
  assertCanView(d, user);
  return d;
}

async function getDepositByBooking(bookingId, user) {
  const d = await Deposit.findOne({ booking: bookingId });
  if (!d) throw new AppError('No deposit for this booking', 404, 'DEPOSIT_NOT_FOUND');
  assertCanView(d, user);
  return d;
}

function assertCanView(d, user) {
  const uid = sid(user._id || user.id);
  if (normalizeRole(user.role) !== 'admin' && sid(d.renter) !== uid && sid(d.owner) !== uid) {
    throw new AppError('Not allowed', 403, 'FORBIDDEN');
  }
}

/* ------------------------- Damage Claim hooks ------------------------- */

/** Damage module calls this when a claim is opened: freezes auto-release. */
async function lockForClaim(depositId, claimId) {
  const d = await Deposit.findOneAndUpdate(
    { _id: depositId, status: DS.HELD, $or: [{ 'claimLock.locked': false }, { 'claimLock.claimId': claimId }] },
    { $set: { 'claimLock.locked': true, 'claimLock.claimId': claimId, 'claimLock.lockedAt': new Date() } },
    { new: true }
  );
  if (!d) throw new AppError('Deposit is not held or is locked by another claim', 409, 'DEPOSIT_NOT_LOCKABLE');
  return d;
}

/** Claim withdrawn/rejected with no deduction: unlock so normal release can proceed. */
async function unlockClaim(depositId, claimId) {
  const d = await Deposit.findOneAndUpdate(
    { _id: depositId, status: DS.HELD, 'claimLock.claimId': claimId },
    { $set: { 'claimLock.locked': false }, $unset: { 'claimLock.claimId': '', 'claimLock.lockedAt': '' } },
    { new: true }
  );
  if (!d) throw new AppError('No matching claim lock on this deposit', 409, 'DEPOSIT_NOT_LOCKED');
  return d;
}

/* ------------------------------ settlement ------------------------------ */

/**
 * The single place deposit money moves out of "held".
 *   deductionAmount = 0            -> full release to renter
 *   0 < deductionAmount < amount   -> deduction to owner, remainder to renter
 *   deductionAmount = amount       -> everything to owner (forfeited)
 * Atomic + idempotent (guarded by status:'held' and ledger idempotency keys).
 */
async function settleDeposit(depositId, { deductionAmount = 0, claimId, reason } = {}) {
  if (!Number.isInteger(deductionAmount) || deductionAmount < 0) {
    throw new AppError('deductionAmount must be a non-negative integer (kobo)', 400, 'INVALID_AMOUNT');
  }

  const current = await Deposit.findById(depositId);
  if (!current) throw new AppError('Deposit not found', 404, 'DEPOSIT_NOT_FOUND');

  // Idempotent replay of the same claim resolution
  if (claimId && current.deductions.some((x) => sid(x.claimId) === sid(claimId))) return current;
  if (current.status !== DS.HELD) {
    throw new AppError(`Deposit is ${current.status}, not held`, 409, 'DEPOSIT_NOT_HELD');
  }
  if (current.claimLock.locked && sid(current.claimLock.claimId) !== sid(claimId)) {
    throw new AppError('Deposit is locked by an open damage claim', 409, 'DEPOSIT_LOCKED_BY_CLAIM');
  }
  const remaining = depositRemaining(current);
  if (deductionAmount > remaining) {
    throw new AppError(`Deduction exceeds deposit (${remaining} kobo available)`, 400, 'DEDUCTION_TOO_HIGH');
  }

  const toRenter = remaining - deductionAmount;
  const finalStatus = deductionAmount === 0 ? DS.RELEASED : toRenter === 0 ? DS.FORFEITED : DS.PARTIALLY_DEDUCTED;

  return runInTransaction(async (session) => {
    const d = await Deposit.findOneAndUpdate(
      { _id: depositId, status: DS.HELD },
      {
        $set: {
          status: finalStatus,
          deductedAmount: current.deductedAmount + deductionAmount,
          releasedAmount: current.releasedAmount + toRenter,
          resolvedAt: new Date(),
          'claimLock.locked': false,
        },
        ...(deductionAmount > 0 ? { $push: { deductions: { claimId, amount: deductionAmount, reason } } } : {}),
      },
      { new: true, session: session || undefined }
    );
    if (!d) throw new AppError('Deposit was already settled', 409, 'DEPOSIT_NOT_HELD');

    if (deductionAmount > 0) {
      await wallet.credit(
        {
          userId: d.owner,
          amount: deductionAmount,
          type: TX.DAMAGE_DEDUCTION,
          idempotencyKey: `dep-deduct:${d._id}`,
          links: { deposit: d._id, booking: d.booking, payment: d.payment },
          description: reason || 'Damage deduction from security deposit',
        },
        session
      );
    }
    if (toRenter > 0) {
      await wallet.credit(
        {
          userId: d.renter,
          amount: toRenter,
          type: TX.DEPOSIT_RELEASE,
          idempotencyKey: `dep-release:${d._id}`,
          links: { deposit: d._id, booking: d.booking, payment: d.payment },
          description: deductionAmount > 0 ? 'Security deposit returned (after deduction)' : 'Security deposit returned',
        },
        session
      );
    }
    return d;
  });
}

/** Owner (or admin) confirms equipment came back fine -> full release. */
async function confirmReturnAndRelease(depositId, user) {
  const d = await Deposit.findById(depositId);
  if (!d) throw new AppError('Deposit not found', 404, 'DEPOSIT_NOT_FOUND');
  const uid = sid(user._id || user.id);
  if (normalizeRole(user.role) !== 'admin' && sid(d.owner) !== uid) {
    throw new AppError('Only the equipment owner or an admin can release the deposit', 403, 'FORBIDDEN');
  }
  return settleDeposit(depositId, { deductionAmount: 0 });
}

/** Damage Claim module calls this when a claim is resolved. */
const resolveClaim = (depositId, { claimId, approvedAmount, reason }) =>
  settleDeposit(depositId, { deductionAmount: approvedAmount, claimId, reason });

/* ---------------------------- auto-release job ---------------------------- */

async function releaseDueDeposits(limit = 100) {
  const due = await Deposit.find({
    status: DS.HELD,
    'claimLock.locked': { $ne: true },
    releaseDueAt: { $lte: new Date() },
  }).limit(limit);

  const results = { released: 0, failed: 0 };
  for (const d of due) {
    try {
      await settleDeposit(d._id, { deductionAmount: 0 });
      results.released += 1;
    } catch (err) {
      results.failed += 1;
      console.error(`[payments] auto-release failed for deposit ${d._id}:`, err.message);
    }
  }
  return results;
}

let timer = null;
function startDepositScheduler(intervalMs = 15 * 60 * 1000) {
  if (timer) return timer;
  timer = setInterval(() => releaseDueDeposits().catch((e) => console.error('[payments] scheduler:', e.message)), intervalMs);
  timer.unref();
  return timer;
}

module.exports = {
  getDeposit,
  getDepositByBooking,
  lockForClaim,
  unlockClaim,
  settleDeposit,
  confirmReturnAndRelease,
  resolveClaim,
  releaseDueDeposits,
  startDepositScheduler,
};
