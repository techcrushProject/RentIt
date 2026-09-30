const mongoose = require("mongoose");

const damageClaimSchema = new mongoose.Schema(
  {
    rental: { type: mongoose.Schema.Types.ObjectId, ref: "Rental", required: true },
    claimant: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    description: { type: String, required: true },
    images: [String],
    amountRequested: { type: Number, required: true },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "resolved"],
      default: "pending",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("DamageClaim", damageClaimSchema);