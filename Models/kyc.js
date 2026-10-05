import mongoose from "mongoose";

const kycSchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "user",
            required: true,
            unique: true,
        },

        documentType: {
            type: String,
            required: true,
            enum: ["national_id", "passport", "drivers_license", "voters_card"],
        },

        documentNumber: {
            type: String,
            required: true,
            trim: true,
        },

        documentUrl: {
            type: String,
            required: true,
        },

        status: {
            type: String,
            enum: [
                "under_review",
                "verified",
                "rejected",
                "resubmission_required",
            ],
            default: "under_review",
        },

        rejectionReason: {
            type: String,
            default: null,
            trim: true,
        },

        reviewedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "user",
            default: null,
        },

        reviewedAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,
    }
);

const Kyc = mongoose.model("Kyc", kycSchema);

export default Kyc;