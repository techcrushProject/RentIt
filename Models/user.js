import mongoose from "mongoose";

/**
 * Sensitive / heavy fields use `select: false`, so they are NEVER returned
 * unless a query asks for them explicitly with `.select("+field")`.
 */
const userSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true, maxlength: 100 },
        firstName: { type: String, trim: true, maxlength: 50 },
        lastName: { type: String, trim: true, maxlength: 50 },
        businessName: { type: String, trim: true, maxlength: 100 },

        email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },

        // bcrypt hash (always 60 chars). The password POLICY is enforced on the
        // plaintext in utils/validate.js, never on this hash.
        password: { type: String, required: true, select: false },

        role: { type: String, enum: ["renter", "owner", "admin"], default: "renter", index: true },
        phone: { type: String, trim: true, maxlength: 30 },
        address: { type: String, trim: true, maxlength: 200 },

        kycStatus: {
            type: String,
            enum: ["not_submitted", "under_review", "verified", "rejected", "resubmit"],
            default: "not_submitted",
            index: true,
        },
        kycDetails: {
            idType: { type: String, maxlength: 40 },
            idNumber: { type: String, maxlength: 40, select: false },
            // base64 data URLs; large, so excluded from every query by default
            documentUrl: { type: String, select: false },
            selfieUrl: { type: String, select: false },
            documentMime: String,
            selfieMime: String,
            documentBytes: Number,
            selfieBytes: Number,
            address: { type: String, maxlength: 200 },
            submittedAt: Date,
        },
        kycRejectionReason: { type: String, default: "", maxlength: 500 },
        isVerified: { type: Boolean, default: false },

        // Bumped on logout, role change and password change. Tokens carry the
        // value they were issued with, so bumping it revokes every older token.
        tokenVersion: { type: Number, default: 0, select: false },
        lastLoginAt: Date,
    },
    { timestamps: true }
);

const User = mongoose.models.User || mongoose.model("User", userSchema);

export default User;
