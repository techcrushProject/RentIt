/**
 * Cross-cutting HTTP hardening used by app.js: security headers, the CORS
 * allowlist, the request logger and the rate limiters.
 */
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { verifyJwt } from "../utils/token.js";

const MINUTE = 60 * 1000;

/** The API serves JSON and images that other origins embed, so CORP must be cross-origin. */
export const securityHeaders = () => helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } });

/**
 * Exact-match origin allowlist. Requests without an Origin header (curl,
 * server-to-server, health checks) are allowed; an Origin that is not listed
 * simply gets no CORS headers, so the browser blocks the response.
 */
export function corsMiddleware(allowedOrigins) {
    const allowed = new Set(allowedOrigins);
    const handler = cors({
        origin: (origin, callback) => callback(null, !origin || allowed.has(origin)),
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: ["Authorization", "Content-Type", "X-Setup-Token"],
        maxAge: 600,
        credentials: false,
    });
    return (req, res, next) => {
        // The answer depends on Origin, so shared caches must not reuse it across origins.
        res.vary("Origin");
        handler(req, res, next);
    };
}

/**
 * One line per finished request: method, path, status, duration.
 * Deliberately never touches headers, query string or body, which can carry
 * tokens, passwords and KYC images.
 */
export function requestLogger(req, res, next) {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        const path = req.originalUrl.split("?")[0];
        console.log(`${req.method} ${path} ${res.statusCode} ${ms.toFixed(1)}ms`);
    });
    next();
}

const limiter = (windowMs, limit) =>
    rateLimit({
        windowMs,
        limit,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        message: { message: "Too many requests, please try again later." },
    });

/**
 * Fresh limiters (each with its own in-memory counters) per call, so tests
 * and multiple apps never share state. Counters are per process: running
 * several instances needs a shared store.
 */
export const createLimiters = () => ({
    general: limiter(15 * MINUTE, 300),
    auth: limiter(15 * MINUTE, 20),
    setup: limiter(60 * MINUTE, 5),
    kycSubmit: limiter(60 * MINUTE, 10),
});

/**
 * Runs before the 8mb JSON parser (app.js only calls it for POST, PUT and PATCH).
 * Every write on those paths requires a login anyway, so refusing callers
 * without a validly signed token here stops an anonymous client from making us
 * buffer and parse megabytes of JSON.
 * Signature check only (no database): the route's `protect` still does the full check.
 */
export function requireTokenForLargeBody(req, res, next) {
    const parts = typeof req.headers.authorization === "string" ? req.headers.authorization.split(" ") : [];
    if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer" || !parts[1]) {
        return res.status(401).json({ message: "Not authorized, no token" });
    }
    try {
        verifyJwt(parts[1]);
    } catch {
        return res.status(401).json({ message: "Not authorized, invalid token" });
    }
    return next();
}
