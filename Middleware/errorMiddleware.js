import mongoose from "mongoose";
import { HttpError } from "../utils/httpError.js";

export const notFound = (req, res) => {
    res.status(404).json({ message: "Not found" });
};

const isClientStatus = (status) => Number.isInteger(status) && status >= 400 && status < 500;

/**
 * Map an error to the JSON response the client may see. Only errors we
 * recognise are described; anything else is a bug whose details stay in the
 * server log (see errorHandler).
 * Returns null for unrecognised errors.
 */
function toClientError(err) {
    if (err instanceof HttpError) {
        const body = { message: err.message };
        if (err.details !== undefined) body.details = err.details;
        return { status: err.status, body };
    }
    // body-parser (and the Express router for bad URL encoding) tag their errors with a 4xx status.
    if (err.type === "entity.too.large") return { status: 413, body: { message: "Request body too large" } };
    if (err.type === "entity.parse.failed") return { status: 400, body: { message: "Invalid JSON body" } };
    if (isClientStatus(err.status) && (typeof err.type === "string" || err instanceof URIError)) {
        return { status: err.status, body: { message: "Invalid request" } };
    }
    if (err instanceof mongoose.Error.ValidationError) {
        const first = Object.values(err.errors)[0];
        return { status: 400, body: { message: first?.message || "Validation failed" } };
    }
    if (err instanceof mongoose.Error.CastError) return { status: 400, body: { message: `Invalid ${err.path}` } };
    if (err.code === 11000) return { status: 409, body: { message: "Already exists" } };
    return null;
}

// Express identifies an error handler by its four parameters, so `next` must stay.
export function errorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);

    const known = err ? toClientError(err) : null;
    if (known) return res.status(known.status).json(known.body);

    // Log the stack only: never the body or the Authorization header, which hold passwords, tokens and KYC data.
    console.error(`[error] ${req.method} ${req.originalUrl.split("?")[0]}`, err?.stack ?? String(err));
    res.status(500).json({ message: "Internal server error" });
}
