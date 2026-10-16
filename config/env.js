/**
 * Single source of truth for configuration.
 * Validated once at import time: the process refuses to start with a clear
 * message instead of failing later with a confusing runtime error.
 */
import dotenv from "dotenv";

dotenv.config({ quiet: true });

const e = process.env;
const errors = [];

const nodeEnv = (e.NODE_ENV || "development").trim();
// A typo such as "Production" or "prod" would otherwise silently run with development defaults.
if (!["development", "production", "test"].includes(nodeEnv)) {
    errors.push("NODE_ENV must be development, production or test");
}
const isProd = nodeEnv === "production";

const required = (name) => {
    const v = (e[name] || "").trim();
    if (!v) errors.push(`${name} is required`);
    return v;
};

const optional = (name, fallback = "") => ((e[name] || "").trim() || fallback);

const mongoUri = required("MONGO_URI");

const jwtSecret = required("JWT_SECRET");
if (jwtSecret && jwtSecret.length < 32) {
    errors.push(
        "JWT_SECRET must be at least 32 characters. Generate one with: " +
        "node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\""
    );
}
if (jwtSecret && /^(replace|change|secret|password|test)/i.test(jwtSecret) && isProd) {
    errors.push("JWT_SECRET looks like a placeholder; set a random value");
}

const jwtExpiresIn = optional("JWT_EXPIRES_IN", "1d");
if (!/^\d+[smhd]$/.test(jwtExpiresIn)) errors.push("JWT_EXPIRES_IN must look like 15m, 12h or 1d");

const port = Number.parseInt(optional("PORT", "3000"), 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push("PORT must be a valid port number");

const devOrigins = [3000, 5500, 5501, 8080].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]);
const corsOrigins = optional("CORS_ORIGINS")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
if (corsOrigins.includes("*")) errors.push("CORS_ORIGINS must list explicit origins, not *");
if (isProd && corsOrigins.length === 0) errors.push("CORS_ORIGINS is required in production (comma-separated list of frontend origins)");

const setupAdminToken = optional("SETUP_ADMIN_TOKEN");
if (setupAdminToken && setupAdminToken.length < 24) errors.push("SETUP_ADMIN_TOKEN must be at least 24 characters");

// Values copied from .env.example or docs must never boot, whatever NODE_ENV says.
const PLACEHOLDER = /change_?me|replace_?me|replace-with|your[-_]?(super[-_]?)?secret/i;
for (const [name, value] of [["MONGO_URI", mongoUri], ["JWT_SECRET", jwtSecret], ["SETUP_ADMIN_TOKEN", setupAdminToken]]) {
    if (value && PLACEHOLDER.test(value)) errors.push(`${name} still contains a placeholder value; set a real one`);
}

const cloudinary = {
    cloudName: optional("CLOUDINARY_CLOUD_NAME"),
    apiKey: optional("CLOUDINARY_API_KEY"),
    apiSecret: optional("CLOUDINARY_API_SECRET"),
};
const cloudSet = Object.values(cloudinary).filter(Boolean).length;
if (cloudSet !== 0 && cloudSet !== 3) {
    errors.push("CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET must be set together");
}

// Trusting a proxy that is not there lets clients spoof X-Forwarded-For and dodge every per-IP limit,
// so production must say explicitly how many proxies sit in front (1 on Render, 0 when exposed directly).
const rawTrustProxy = optional("TRUST_PROXY");
if (isProd && !rawTrustProxy) errors.push("TRUST_PROXY is required in production (1 behind Render's proxy, 0 if clients connect directly)");
const trustProxy = /^\d+$/.test(rawTrustProxy || "0") ? Number.parseInt(rawTrustProxy || "0", 10) : NaN;
if (!Number.isInteger(trustProxy) || trustProxy < 0) errors.push("TRUST_PROXY must be a non-negative integer (number of proxy hops)");

if (errors.length) {
    throw new Error(`Invalid environment configuration:\n - ${errors.join("\n - ")}`);
}

export default Object.freeze({
    nodeEnv,
    isProd,
    isTest: nodeEnv === "test",
    port,
    mongoUri,
    jwtSecret,
    jwtExpiresIn,
    corsOrigins: corsOrigins.length ? corsOrigins : devOrigins,
    setupAdminToken,
    cloudinary: Object.freeze({ ...cloudinary, enabled: cloudSet === 3 }),
    trustProxy,
});
