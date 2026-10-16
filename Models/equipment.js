import mongoose from "mongoose";

export const MAX_SPECS = 20;
export const MAX_IMAGES = 6;

const equipmentSchema = new mongoose.Schema(
    {
        title: { type: String, required: true, trim: true, minlength: 3, maxlength: 120 },
        description: { type: String, trim: true, maxlength: 2000, default: "" },
        // Per day, NGN. `min` is inclusive, so "greater than 0" needs a validator.
        price: {
            type: Number,
            required: true,
            validate: { validator: (value) => value > 0, message: "price must be greater than 0" },
        },
        rentalDeposit: { type: Number, min: 0, default: 0 },
        category: { type: String, trim: true, maxlength: 60, default: "" },
        condition: { type: String, trim: true, maxlength: 40, default: "" },
        location: { type: String, trim: true, maxlength: 120, default: "" },
        specs: {
            type: [{ type: String, trim: true, maxlength: 100 }],
            validate: { validator: (value) => value.length <= MAX_SPECS, message: `specs can have at most ${MAX_SPECS} items` },
        },
        images: {
            type: [String],
            validate: { validator: (value) => value.length <= MAX_IMAGES, message: `images can have at most ${MAX_IMAGES} items` },
        },
        // Maintained by the hook below so list views can skip `images` entirely.
        thumbnail: { type: String, default: "" },
        imageCount: { type: Number, default: 0 },
        availability: { type: Boolean, default: true },

        owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

        // Only admins move a listing out of "pending" (see Controllers/adminControllers.js).
        status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending", index: true },
        rejectionReason: { type: String, maxlength: 500, default: "" },
        reviewedAt: Date,
        reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    },
    {
        timestamps: true,
        toJSON: {
            // The frontend dashboards read name, pricePerDay and image, so they are derived rather than stored.
            transform(doc, ret) {
                ret.name = ret.title;
                ret.pricePerDay = ret.price;
                // Listings created before `images` existed still carry a raw `image` string.
                const legacyImage = typeof ret.image === "string" ? ret.image : "";
                ret.image = ret.images?.[0] || legacyImage;
                // The thumbnail duplicates images[0]; list views add it back themselves.
                delete ret.thumbnail;
                delete ret.__v;
                return ret;
            },
        },
    }
);

equipmentSchema.pre("validate", function () {
    const images = Array.isArray(this.images) ? this.images : [];
    this.thumbnail = images[0] || "";
    this.imageCount = images.length;
});

// Serves the public listing: approved + available, newest first.
equipmentSchema.index({ status: 1, availability: 1, createdAt: -1 });

export default mongoose.models.Equipment || mongoose.model("Equipment", equipmentSchema);
