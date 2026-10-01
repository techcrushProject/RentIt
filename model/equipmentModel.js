const mongoose = require("mongoose");

const equipmentSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    description: {
      type: String,
      required: true,
      trim: true,
    },

    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },

    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    brand: {
      type: String,
      trim: true,
    },

    model: {
      type: String,
      trim: true,
    },

    condition: {
      type: String,
      enum: ["Brand New", "Fairly Used"],
      trim: true,
    },

    additionalInformation: {
      type: String,
      trim: true,
    },

    pricePerDay: {
      type: Number,
      required: true,
      min: 0,
    },

    rentalDeposit: {
      type: Number,
      min: 0,
      default: 0,
    },

    rentalRules: {
      type: String,
      trim: true,
    },

    location: {
      type: String,
      required: true,
      trim: true,
    },

    availableDate: {
      type: Date,
    },

    unavailableDate: {
      type: Date,
    },

    handoverMethod: {
      type: String,
      enum: ["Pickup", "Delivery"],
    },

    images: [
      {
        type: String,
      },
    ],

    availability: {
      type: Boolean,
      default: true,
    },

    status: {
      type: String,
      enum: ["submitted", "published", "rented", "unavailable"],
      default: "submitted",
    },
  },
  {
    timestamps: true,
  }
);

const equipmentModel = mongoose.model("Equipment", equipmentSchema);

module.exports = equipmentModel;