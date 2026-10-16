/**
 * Errors that are safe to show to API clients.
 * Anything that is NOT an HttpError is treated as a bug: it is logged on the
 * server and the client only ever sees a generic 500 (see errorMiddleware).
 */
export class HttpError extends Error {
    constructor(status, message, details) {
        super(message);
        this.name = "HttpError";
        this.status = status;
        if (details !== undefined) this.details = details;
    }
}

export const badRequest = (message, details) => new HttpError(400, message, details);
export const unauthorized = (message = "Not authorized") => new HttpError(401, message);
export const forbidden = (message = "Access denied") => new HttpError(403, message);
export const notFound = (message = "Not found") => new HttpError(404, message);
export const conflict = (message) => new HttpError(409, message);
export const payloadTooLarge = (message = "Payload too large") => new HttpError(413, message);
