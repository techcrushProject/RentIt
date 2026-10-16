import mongoose from "mongoose";

/** Small key/value store. Also used for one-shot markers (e.g. "adminBootstrap") that rely on the unique key. */
const settingSchema = new mongoose.Schema(
    {
        key: { type: String, required: true, unique: true, trim: true },
        value: mongoose.Schema.Types.Mixed,
    },
    { timestamps: true }
);

const Setting = mongoose.models.Setting || mongoose.model("Setting", settingSchema);

export default Setting;
