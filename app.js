import express from "express";
import mongoose from "mongoose";
import env from "./config/env.js";
import { securityHeaders, corsMiddleware, requestLogger, createLimiters, requireTokenForLargeBody } from "./Middleware/security.js";
import { notFound, errorHandler } from "./Middleware/errorMiddleware.js";
import { badRequest } from "./utils/httpError.js";
import authRoutes from "./Routes/authRoutes.js";
import kycRoutes from "./Routes/kycRoutes.js";
import adminRoutes from "./Routes/adminRoutes.js";
import equipmentRoutes from "./Routes/equipmentRoutes.js";
import categoryRoutes from "./Routes/categoryRoutes.js";
import uploadRoutes from "./Routes/uploadRoutes.js";

// KYC and equipment submissions carry base64 images; everything else stays small.
const LARGE_BODY_PATHS = ["/api/kyc", "/api/equipment", "/equipment"];
// body-parser reads a body on ANY method that sends one, so the big parser is limited to real writes.
const LARGE_BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

// Responses on these paths carry tokens, personal data or KYC details: never cache them.
const NO_STORE_PATHS = ["/api/auth", "/api/kyc", "/api/admin", "/api/uploads"];

/**
 * Build the configured Express app. It neither listens nor connects to the
 * database, so tests and server.js decide when to do both.
 * `options.rateLimit === false` turns rate limiting off (tests only).
 */
export function createApp(options = {}) {
    const app = express();

    app.disable("x-powered-by");
    app.set("trust proxy", env.trustProxy);

    app.use(securityHeaders());
    app.use(corsMiddleware(env.corsOrigins));
    if (!env.isTest) app.use(requestLogger);

    // Limiters run before body parsing so a flood of large bodies is refused
    // before any of it is buffered and parsed.
    if (options.rateLimit !== false) {
        const limiters = createLimiters();
        app.use(["/api", "/equipment", "/category"], limiters.general);
        app.use(["/api/auth/login", "/api/auth/register"], limiters.auth);
        app.use("/api/auth/setup-admin", limiters.setup);
        // Prefix match (like the other limiters) so variants such as POST /api/kyc// are counted too.
        app.use("/api/kyc", (req, res, next) => (req.method === "POST" ? limiters.kycSubmit(req, res, next) : next()));
    }

    // body-parser skips a request whose body an earlier parser already consumed.
    // Only signed-in callers writing to these paths may make us parse up to 8mb.
    const largeJson = express.json({ limit: "8mb" });
    app.use(LARGE_BODY_PATHS, (req, res, next) => {
        if (!LARGE_BODY_METHODS.has(req.method)) return next();
        return requireTokenForLargeBody(req, res, (err) => (err ? next(err) : largeJson(req, res, next)));
    });
    app.use(express.json({ limit: "100kb" }));

    // Express 5's simple query parser keeps "q[$ne]" as a literal key. No route uses such keys,
    // so refuse them outright instead of silently ignoring an operator-shaped filter.
    app.use((req, res, next) => {
        const bad = Object.keys(req.query).some((key) => /[[\]$]/.test(key));
        return bad ? next(badRequest("Invalid query parameter")) : next();
    });

    app.use(NO_STORE_PATHS, (req, res, next) => {
        res.set("Cache-Control", "no-store");
        next();
    });

    app.get("/health", (req, res) => {
        const up = mongoose.connection.readyState === 1;
        res.status(up ? 200 : 503).json(up ? { status: "ok", db: "up" } : { status: "degraded", db: "down" });
    });

    app.get("/", (req, res) => {
        res.send("WELCOME TO BACKEND API");
    });

    app.use("/api/auth", authRoutes);
    app.use("/api/kyc", kycRoutes);
    app.use("/api/admin", adminRoutes);
    app.use(["/api/equipment", "/equipment"], equipmentRoutes);
    app.use(["/api/categories", "/category"], categoryRoutes);
    app.use("/api/uploads", uploadRoutes);

    app.use(notFound);
    app.use(errorHandler);

    return app;
}
