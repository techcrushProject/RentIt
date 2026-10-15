import mongoose from "mongoose";

const equipmentSchema = new mongoose.Schema({
    title: { type: String, required: true },
    description: String,
    price: { type: Number, required: true },
    category: String,
    condition: String,
    location: String,
    specs: [String],
    image: String,
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' }
}, { timestamps: true });

export default mongoose.model("Equipment", equipmentSchema);