import env from "../config/env.js";
import { HttpError } from "../utils/httpError.js";
import { signParams } from "../utils/cloudinarySign.js";
import { oneOf } from "../utils/validate.js";

const ALLOWED_FORMATS = "jpg,jpeg,png,webp";
// Advisory for the browser: Cloudinary, not this server, enforces the size of a direct upload.
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Lets the browser upload straight to Cloudinary without ever seeing the API
 * secret. The folder is fixed here, per user, and is part of the signature, so
 * a client cannot upload anywhere else with it.
 */
export const signUpload = (req, res) => {
    const body = req.body !== null && typeof req.body === "object" ? req.body : {};
    oneOf(body.purpose, ["equipment"], "purpose");

    const { cloudName, apiKey, apiSecret, enabled } = env.cloudinary;
    if (!enabled) throw new HttpError(503, "Image uploads are not configured");

    const timestamp = Math.floor(Date.now() / 1000);
    const folder = `rentit/equipment/${req.user.id}`;
    const signature = signParams({ allowed_formats: ALLOWED_FORMATS, folder, timestamp }, apiSecret);

    res.status(200).json({
        cloudName,
        apiKey,
        timestamp,
        folder,
        allowedFormats: ALLOWED_FORMATS,
        signature,
        uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
        maxBytes: MAX_BYTES,
    });
};
