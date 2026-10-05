const crypto = require('crypto');
const mongoose = require('mongoose');
const AppError = require('./AppError');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const sendOk = (res, data, status = 200, meta) =>
  res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });

const newReference = (prefix = 'RENTIT') =>
  `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

const assertPositiveInt = (n, label = 'amount') => {
  if (!Number.isInteger(n) || n <= 0) {
    throw new AppError(`${label} must be a positive integer (minor units / kobo)`, 400, 'INVALID_AMOUNT');
  }
};

const assertObjectId = (id, label = 'id') => {
  if (!mongoose.isValidObjectId(id)) throw new AppError(`Invalid ${label}`, 400, 'INVALID_ID');
};

const isTxUnsupported = (err) =>
  err &&
  (err.code === 20 || /replica set|Transaction numbers are only allowed/i.test(err.message || ''));

/**
 * Runs fn inside a MongoDB transaction when the server supports it (Atlas / replica set).
 * On a standalone mongod (typical local dev) it transparently falls back to running without one.
 * fn receives `session` (or null) - pass it to every query/write inside.
 */
async function runInTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } catch (err) {
    if (isTxUnsupported(err)) return fn(null);
    throw err;
  } finally {
    session.endSession();
  }
}

const userId = (u) => String(u._id || u.id);

const normalizeRole = (role = '') => {
  const r = String(role).toLowerCase().replace(/[\s_-]/g, '');
  if (r.includes('admin')) return 'admin';
  if (r.includes('owner')) return 'owner';
  if (r.includes('renter')) return 'renter';
  return r;
};

module.exports = {
  asyncHandler,
  sendOk,
  newReference,
  assertPositiveInt,
  assertObjectId,
  runInTransaction,
  userId,
  normalizeRole,
};
