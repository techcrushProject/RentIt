/**
 * Small, dependency-free input validators. Every function either returns a
 * cleaned value or throws an HttpError(400) with a client-safe message.
 * Never pass raw req.body values to Mongoose: objects such as {"$gt": ""}
 * must be rejected here, which is why every helper insists on real strings.
 */
import mongoose from "mongoose";
import { badRequest } from "./httpError.js";

const isString = (v) => typeof v === "string";

/** Required or optional trimmed string with length bounds. */
export function str(value, { field = "value", min = 0, max = 200, required = false } = {}) {
    if (value === undefined || value === null || value === "") {
        if (required) throw badRequest(`${field} is required`);
        return "";
    }
    if (!isString(value)) throw badRequest(`${field} must be text`);
    const v = value.trim();
    if (required && v.length === 0) throw badRequest(`${field} is required`);
    if (v.length < min) throw badRequest(`${field} must be at least ${min} characters`);
    if (v.length > max) throw badRequest(`${field} must be at most ${max} characters`);
    return v;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function email(value, field = "email") {
    const v = str(value, { field, required: true, max: 254 }).toLowerCase();
    if (!EMAIL_RE.test(v)) throw badRequest("Enter a valid email address");
    return v;
}

/** bcrypt silently ignores bytes past 72, so reject longer passwords. */
export function password(value, field = "password") {
    if (!isString(value) || value.length === 0) throw badRequest(`${field} is required`);
    if (value.length < 8) throw badRequest("Password must be at least 8 characters");
    if (Buffer.byteLength(value, "utf8") > 72) throw badRequest("Password must be at most 72 bytes");
    if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) {
        throw badRequest("Password must contain at least one letter and one number");
    }
    return value;
}

export function phone(value, { required = false } = {}) {
    const v = str(value, { field: "phone", required, max: 30 });
    if (!v) return "";
    const digits = v.replace(/[\s\-()]/g, "");
    if (!/^\+?\d{10,15}$/.test(digits)) throw badRequest("Enter a valid phone number");
    return v;
}

export function objectId(value, field = "id") {
    if (!isString(value) || !/^[a-f\d]{24}$/i.test(value) || !mongoose.isValidObjectId(value)) {
        throw badRequest(`Invalid ${field}`);
    }
    return value;
}

export function oneOf(value, allowed, field = "value") {
    if (!isString(value) || !allowed.includes(value)) {
        throw badRequest(`${field} must be one of: ${allowed.join(", ")}`);
    }
    return value;
}

export function positiveNumber(value, { field = "value", allowZero = false, max = 1e9 } = {}) {
    const n = typeof value === "number" ? value : isString(value) && value.trim() !== "" ? Number(value) : NaN;
    if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0) || n > max) {
        throw badRequest(`${field} must be a ${allowZero ? "non-negative" : "positive"} number`);
    }
    return n;
}

const MAX_PAGE = 10000;

/** Page/limit query parsing with a hard ceiling so nobody can request "everything". */
export function pagination(query = {}, { defaultLimit = 20, maxLimit = 100 } = {}) {
    // Capped so a huge ?page= cannot turn into an Infinity/int64-overflow skip (a 500 from the database).
    const page = Math.min(Math.max(1, Number.parseInt(isString(query.page) ? query.page : "1", 10) || 1), MAX_PAGE);
    let limit = Number.parseInt(isString(query.limit) ? query.limit : String(defaultLimit), 10) || defaultLimit;
    limit = Math.min(Math.max(1, limit), maxLimit);
    return { page, limit, skip: (page - 1) * limit };
}

/* ---------- images ---------- */

const MIME_BY_PREFIX = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

function sniffMime(buf) {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
    if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return "image/png";
    }
    if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") {
        return "image/webp";
    }
    return null;
}

/**
 * Parse and strictly validate a base64 image data URL.
 * Checks the declared type, the real file signature (so HTML/SVG cannot be
 * smuggled in as "image/png"), and the decoded size.
 * Returns { dataUrl, mime, bytes, buffer }.
 */
export function parseImageDataUrl(value, { field = "image", maxBytes = 2 * 1024 * 1024 } = {}) {
    if (!isString(value)) throw badRequest(`${field} must be an image`);
    const m = /^data:image\/(jpeg|png|webp);base64,/.exec(value);
    if (!m) throw badRequest(`${field} must be a JPEG, PNG or WebP image`);
    const b64 = value.slice(m[0].length);
    // Base64 length bounds decoded size; reject early before allocating.
    if (b64.length > Math.ceil((maxBytes * 4) / 3) + 4) {
        const limit = maxBytes >= 1024 * 1024 ? `${Math.round(maxBytes / 1024 / 1024)}MB` : `${Math.round(maxBytes / 1024)}KB`;
        throw badRequest(`${field} is too large (max ${limit})`);
    }
    if (b64.length === 0 || b64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(b64) || /=[^=]/.test(b64)) {
        throw badRequest(`${field} is not valid image data`);
    }
    const buffer = Buffer.from(b64, "base64");
    if (buffer.length > maxBytes) throw badRequest(`${field} is too large`);
    const real = sniffMime(buffer);
    if (!real || real !== MIME_BY_PREFIX[m[1]]) throw badRequest(`${field} is not a valid ${m[1].toUpperCase()} image`);
    return { dataUrl: value, mime: real, bytes: buffer.length, buffer };
}

/**
 * Accept either a validated data URL or an https URL that points at OUR
 * Cloudinary cloud (https://res.cloudinary.com/<cloud>/image/upload/...).
 * `cloudName` comes from config; when it is empty only data URLs are accepted.
 * `folder` (e.g. "rentit/equipment/<userId>") additionally requires the asset to
 * live in that folder, so nobody can attach images another user uploaded.
 */
export function imageRef(value, { field = "image", cloudName = "", maxBytes = 1.5 * 1024 * 1024, folder = "" } = {}) {
    if (!isString(value) || value.length === 0) throw badRequest(`${field} must be an image`);
    if (value.startsWith("data:")) return parseImageDataUrl(value, { field, maxBytes }).dataUrl;
    if (value.length > 600) throw badRequest(`${field} URL is too long`);
    let url;
    try {
        url = new URL(value);
    } catch {
        throw badRequest(`${field} must be an image URL`);
    }
    const okHost = url.protocol === "https:" && url.hostname === "res.cloudinary.com" && !url.username && !url.password;
    const base = `/${cloudName}/image/upload/`;
    let okPath = Boolean(cloudName) && url.pathname.startsWith(base);
    if (okPath && folder) {
        // Our signed uploads come back as .../image/upload/v<version>/<folder>/<public id>.<ext>
        const rest = url.pathname.slice(base.length).replace(/^v\d+\//, "");
        okPath = rest.startsWith(`${folder.replace(/\/+$/, "")}/`) && !rest.includes("..");
    }
    if (!okHost || !okPath || url.search || url.hash) throw badRequest(`${field} must be an image uploaded through RentIt`);
    return url.toString();
}
