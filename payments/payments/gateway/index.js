const config = require('../config');

// Swap providers with PAYMENT_PROVIDER=paystack|demo - nothing else in the module changes.
module.exports = config.provider === 'paystack' ? require('./paystack') : require('./demo');
