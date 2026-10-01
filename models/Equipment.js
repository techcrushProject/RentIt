import mongoose from "mongoose";

const unavailablePeriodSchema = new mongoose.Schema(
  {
    startDate: {
      type: Date,
      required: true,
    },

    endDate: {
      type: Date,
      required: true,
    },
  },
  {
    _id: false,
  }
);

const equipmentSchema = new mongoose.Schema(
  {
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
    },

    pricePerDay: {
      type: Number,
      required: true,
      min: 0,
    },

    securityDeposit: {
      type: Number,
      required: true,
      min: 0,
    },

    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },

    unavailablePeriods: {
      type: [unavailablePeriodSchema],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

const Equipment = mongoose.model("Equipment", equipmentSchema);

export default Equipment;