import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
    },

    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true,
    },

    password: {
        type: String,
        required: true,
        minlength: 6,
    },

    role: {
        type: String,
        enum: ["renter", "owner", "admin"],
        default: "renter",
    },
    phone: {
        type: String,
        trim: true,
    },
    address: {
        type: String,
        trim: true,
    },
    kycStatus: {
        type: String,
        enum: ["not_submitted", "under_review", "verified", "rejected", "resubmit"],
        default: "not_submitted",
    },
    kycDetails: {
        idType: String,
        idNumber: String,
        documentUrl: String,
        selfieUrl: String,
        address: String,
        submittedAt: Date,
    },
    kycRejectionReason: {
        type: String,
        default: "",
    },
    isVerified: {
        type: Boolean,
        default: false,
    },
},
{
    timestamps: true,
});

const User = mongoose.models.User || mongoose.model("User", userSchema);

export default User;