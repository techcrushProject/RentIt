/**
 * Paystack adapter (NGN, amounts already in kobo). Needs PAYSTACK_SECRET_KEY.
 * Uses Node 18+ global fetch - no extra dependency.
 */
const crypto = require('crypto');
const config = require('../config');
const AppError = require('../utils/AppError');

const BASE = 'https://api.paystack.co';

async function call(path, { method = 'GET', body } = {}) {
  if (!config.paystackSecretKey) throw new AppError('PAYSTACK_SECRET_KEY is not configured', 500, 'GATEWAY_NOT_CONFIGURED');
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.paystackSecretKey}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.status === false) {
    throw new AppError(json.message || 'Payment gateway error', 502, 'GATEWAY_ERROR');
  }
  return json.data;
}

module.exports = {
  name: 'paystack',

  async initialize({ reference, amount, email, metadata }) {
    const data = await call('/transaction/initialize', {
      method: 'POST',
      body: { reference, amount, email, currency: config.currency, callback_url: config.callbackUrl, metadata },
    });
    return { providerReference: data.reference || reference, checkoutUrl: data.authorization_url };
  },

  async verify(reference) {
    const data = await call(`/transaction/verify/${encodeURIComponent(reference)}`);
    return { status: data.status, reference: data.reference, amount: data.amount };
  },

  async refund({ reference, amount }) {
    const data = await call('/refund', { method: 'POST', body: { transaction: reference, amount } });
    return { providerReference: String(data.id || data.transaction?.id || reference) };
  },

  verifyWebhookSignature(rawBody, signature) {
    if (!rawBody || !signature || !config.paystackSecretKey) return false;
    const expected = crypto.createHmac('sha512', config.paystackSecretKey).update(rawBody).digest('hex');
    return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  },

  parseWebhook(body) {
    const data = body.data || {};
    return { event: body.event, reference: data.reference, amount: data.amount, status: data.status };
  },
};
