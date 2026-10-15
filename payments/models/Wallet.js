const mongoose = require('mongoose');
const config = require('../config');

const intField = { type: Number, default: 0, min: 0, validate: { validator: Number.isInteger, message: 'must be an integer' } };

const walletSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    balance: intField, // available - can be spent or withdrawn
    pendingBalance: intField, // owner earnings for paid rentals not yet completed
    currency: { type: String, default: config.currency },
  },
  { timestamps: true }
);

module.exports = mongoose.models.Wallet || mongoose.model('Wallet', walletSchema);
