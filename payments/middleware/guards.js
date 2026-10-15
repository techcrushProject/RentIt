const AppError = require('../utils/AppError');
const { normalizeRole } = require('../utils/helpers');

/**
 * Role guard that works with whatever role strings the auth module uses
 * ("Renter", "EquipmentOwner", "Admin", "owner", ...). Run AFTER the auth `protect` middleware.
 */
const requireRole =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user) return next(new AppError('Not authenticated', 401, 'UNAUTHENTICATED'));
    if (!roles.includes(normalizeRole(req.user.role))) {
      return next(new AppError('You do not have permission to perform this action', 403, 'FORBIDDEN'));
    }
    next();
  };

/** Webhook needs the raw bytes for signature checking. */
const requireRawBody = (req, _res, next) => {
  if (!req.rawBody) {
    return next(
      new AppError(
        'rawBody missing: add express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }) in app.js',
        500,
        'RAW_BODY_MISSING'
      )
    );
  }
  next();
};

/* eslint-disable-next-line no-unused-vars */
const errorHandler = (err, _req, res, _next) => {
  let status = err.statusCode || 500;
  let code = err.code && typeof err.code === 'string' ? err.code : 'SERVER_ERROR';
  let message = err.message || 'Something went wrong';

  if (err.name === 'ValidationError') {
    status = 400;
    code = 'VALIDATION_ERROR';
  } else if (err.name === 'CastError') {
    status = 400;
    code = 'INVALID_ID';
    message = `Invalid ${err.path}`;
  } else if (err.code === 11000) {
    status = 409;
    code = 'DUPLICATE';
    message = 'Duplicate record';
  }
  if (status >= 500) {
    console.error('[payments]', err);
    if (!err.isOperational) message = 'Internal server error';
  }
  res.status(status).json({ success: false, error: { code, message } });
};

module.exports = { requireRole, requireRawBody, errorHandler };
