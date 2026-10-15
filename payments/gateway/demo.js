/**
 * Demo gateway - no external calls. Lets the frontend run a full "demo transaction":
 * checkout -> redirect to callbackUrl?reference=... -> GET /payments/verify/:reference
 * (or POST /payments/:id/demo-confirm) -> payment succeeds.
 */
const crypto = require('crypto');
const config = require('../config');

module.exports = {
  name: 'demo',

  async initialize({ reference }) {
    return {
      providerReference: reference,
      checkoutUrl: `${config.callbackUrl}?reference=${encodeURIComponent(reference)}&demo=1`,
    };
  },

  async verify(reference) {
    return { status: 'success', reference, amount: undefined };
  },

  async refund({ reference }) {
    return { providerReference: `demo-refund-${reference}` };
  },

  verifyWebhookSignature(rawBody, signature) {
    if (!rawBody || !signature) return false;
    const expected = crypto.createHmac('sha512', config.webhookSecret).update(rawBody).digest('hex');
    return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  },

  parseWebhook(body) {
    const data = body.data || {};
    return { event: body.event, reference: data.reference, amount: data.amount, status: data.status };
  },
};
