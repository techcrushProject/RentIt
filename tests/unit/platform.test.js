import "../helpers/setEnv.js";
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import mongoose from "mongoose";
import env from "../../config/env.js";
import { createApp } from "../../app.js";
import { errorHandler, notFound } from "../../Middleware/errorMiddleware.js";
import { requestLogger } from "../../Middleware/security.js";
import { HttpError } from "../../utils/httpError.js";
import { signToken } from "../../utils/token.js";
import User from "../../Models/user.js";
import authRoutes from "../../Routes/authRoutes.js";
import kycRoutes from "../../Routes/kycRoutes.js";
import adminRoutes from "../../Routes/adminRoutes.js";
import equipmentRoutes from "../../Routes/equipmentRoutes.js";
import categoryRoutes from "../../Routes/categoryRoutes.js";
import uploadRoutes from "../../Routes/uploadRoutes.js";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/* ---------------------------------------------------------------- helpers */

function fakeRes({ headersSent = false } = {}) {
    return {
        headersSent,
        statusCode: undefined,
        body: undefined,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
    };
}

// Carries secrets on purpose: none of them may ever reach a log line.
const fakeReq = {
    method: "POST",
    originalUrl: "/api/auth/login?token=query-secret",
    path: "/api/auth/login",
    headers: { authorization: "Bearer header-secret" },
    body: { password: "body-secret" },
};

function handle(err, req = fakeReq) {
    const res = fakeRes();
    const next = mock.fn();
    errorHandler(err, req, res, next);
    return { res, next };
}

const withProps = (err, props) => Object.assign(err, props);

/** Start an app on an ephemeral port and return a tiny client plus close(). */
async function serve(app) {
    const server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    return {
        baseUrl,
        async call(urlPath, { method = "GET", headers = {}, body } = {}) {
            const res = await fetch(baseUrl + urlPath, { method, headers, body, signal: AbortSignal.timeout(15_000) });
            const text = await res.text();
            let json;
            try {
                json = JSON.parse(text);
            } catch {
                json = undefined;
            }
            return { status: res.status, headers: res.headers, text, json };
        },
        close: () =>
            new Promise((resolve) => {
                server.close(resolve);
                server.closeAllConnections();
            }),
    };
}

const JSON_HEADERS = { "content-type": "application/json" };
// A body that body-parser rejects (400) before any route or database code runs.
const BROKEN_JSON = { method: "POST", headers: JSON_HEADERS, body: "{" };

/* ----------------------------------------------------------- errorHandler */

describe("notFound", () => {
    it("responds with a JSON 404", () => {
        const res = fakeRes();
        notFound(fakeReq, res);
        assert.equal(res.statusCode, 404);
        assert.deepEqual(res.body, { message: "Not found" });
    });
});

describe("errorHandler", () => {
    it("maps HttpError to its status and message", () => {
        const { res } = handle(new HttpError(403, "Access denied"));
        assert.equal(res.statusCode, 403);
        assert.deepEqual(res.body, { message: "Access denied" });
    });

    it("includes HttpError details only when present", () => {
        const { res } = handle(new HttpError(400, "Bad input", [{ field: "email" }]));
        assert.deepEqual(res.body, { message: "Bad input", details: [{ field: "email" }] });
    });

    it("maps an oversized body to 413", () => {
        const { res } = handle(withProps(new Error("request entity too large"), { type: "entity.too.large", status: 413 }));
        assert.equal(res.statusCode, 413);
        assert.deepEqual(res.body, { message: "Request body too large" });
    });

    it("maps malformed JSON to 400 without echoing the parser message", () => {
        const { res } = handle(withProps(new SyntaxError("Unexpected token x in JSON at position 3"), { type: "entity.parse.failed", status: 400 }));
        assert.equal(res.statusCode, 400);
        assert.deepEqual(res.body, { message: "Invalid JSON body" });
    });

    it("keeps the status of other body-parser errors with a generic message", () => {
        const { res } = handle(withProps(new Error("unsupported charset \"UTF-7\""), { type: "charset.unsupported", status: 415 }));
        assert.equal(res.statusCode, 415);
        assert.deepEqual(res.body, { message: "Invalid request" });
    });

    it("maps a URL that cannot be decoded to 400", () => {
        const { res } = handle(withProps(new URIError("Failed to decode param '%E0%A4%A'"), { status: 400 }));
        assert.equal(res.statusCode, 400);
        assert.deepEqual(res.body, { message: "Invalid request" });
    });

    it("maps a Mongoose ValidationError to 400 with the first message", async () => {
        const Thing = mongoose.model("PlatformValidationProbe", new mongoose.Schema({ title: { type: String, required: [true, "Title is required"] } }));
        const err = await new Thing({}).validate().catch((e) => e);
        const { res } = handle(err);
        assert.equal(res.statusCode, 400);
        assert.deepEqual(res.body, { message: "Title is required" });
    });

    it("maps a CastError to 400 naming the path only", () => {
        const { res } = handle(new mongoose.Error.CastError("ObjectId", "{ $gt: '' }", "owner"));
        assert.equal(res.statusCode, 400);
        assert.deepEqual(res.body, { message: "Invalid owner" });
    });

    it("maps a duplicate key error to 409 without leaking the index or value", () => {
        const err = withProps(new Error("E11000 duplicate key error collection: rentit.users index: email_1 dup key: { email: \"a@b.co\" }"), { code: 11000 });
        const { res } = handle(err);
        assert.equal(res.statusCode, 409);
        assert.deepEqual(res.body, { message: "Already exists" });
    });

    it("does not log errors it already described to the client", () => {
        const logged = mock.method(console, "error", () => {});
        try {
            handle(new HttpError(404, "Equipment not found"));
            handle(withProps(new Error("x"), { code: 11000 }));
            assert.equal(logged.mock.callCount(), 0);
        } finally {
            logged.mock.restore();
        }
    });

    it("hides unexpected errors behind a generic 500 and logs method, path and stack only", () => {
        const logged = mock.method(console, "error", () => {});
        try {
            const err = new Error("connect failed mongodb://user:db-password@host/db");
            const { res } = handle(err);
            assert.equal(res.statusCode, 500);
            assert.deepEqual(res.body, { message: "Internal server error" });

            assert.equal(logged.mock.callCount(), 1);
            const line = logged.mock.calls[0].arguments.map(String).join(" ");
            assert.match(line, /POST \/api\/auth\/login/);
            assert.ok(line.includes(err.stack));
            for (const secret of ["query-secret", "header-secret", "body-secret", "Bearer"]) {
                assert.ok(!line.includes(secret), `log line leaks ${secret}`);
            }
        } finally {
            logged.mock.restore();
        }
    });

    it("also answers 500 when something other than an Error was thrown", () => {
        const logged = mock.method(console, "error", () => {});
        try {
            assert.deepEqual(handle("boom").res.body, { message: "Internal server error" });
            assert.deepEqual(handle(undefined).res.body, { message: "Internal server error" });
        } finally {
            logged.mock.restore();
        }
    });

    it("delegates to Express when the response has already started", () => {
        const err = new Error("late failure");
        const res = fakeRes({ headersSent: true });
        const next = mock.fn();
        errorHandler(err, fakeReq, res, next);
        assert.equal(next.mock.callCount(), 1);
        assert.equal(next.mock.calls[0].arguments[0], err);
        assert.equal(res.statusCode, undefined);
    });
});

/* ------------------------------------------------------------- requestLogger */

describe("requestLogger", () => {
    it("logs method, path, status and duration, and nothing sensitive", () => {
        const logged = mock.method(console, "log", () => {});
        try {
            const res = Object.assign(new EventEmitter(), { statusCode: 401 });
            const next = mock.fn();
            requestLogger(fakeReq, res, next);
            assert.equal(next.mock.callCount(), 1);
            assert.equal(logged.mock.callCount(), 0, "logs only once the response finished");

            res.emit("finish");
            assert.equal(logged.mock.callCount(), 1);
            const line = logged.mock.calls[0].arguments.join(" ");
            assert.match(line, /^POST \/api\/auth\/login 401 \d+\.\dms$/);
        } finally {
            logged.mock.restore();
        }
    });
});

/* ------------------------------------------------------- config/env.js (child processes) */

describe("config/env.js validation", () => {
    const ENV_MODULE = pathToFileURL(path.join(root, "config/env.js")).href;
    const LOAD = "const { default: env } = await import(process.env.ENV_MODULE); console.log(JSON.stringify(env));";
    const GOOD = { MONGO_URI: "mongodb://127.0.0.1:27017/rentit", JWT_SECRET: "k9f2".repeat(10) };
    let emptyDir;

    before(async () => {
        // Run children in an empty directory so a developer's own .env cannot fill in missing values.
        emptyDir = await mkdtemp(path.join(tmpdir(), "rentit-env-"));
    });
    after(() => rm(emptyDir, { recursive: true, force: true }));

    // The child gets ONLY these variables, never the test process's environment.
    async function load(vars) {
        try {
            const { stdout } = await execFileAsync(
                process.execPath,
                ["--input-type=module", "-e", LOAD],
                { cwd: emptyDir, env: { PATH: process.env.PATH, ENV_MODULE, ...vars } }
            );
            return { ok: true, config: JSON.parse(stdout) };
        } catch (err) {
            return { ok: false, stderr: String(err.stderr) };
        }
    }

    it("accepts a minimal environment and applies the defaults", async () => {
        const r = await load(GOOD);
        assert.equal(r.ok, true, r.stderr);
        assert.equal(r.config.nodeEnv, "development");
        assert.equal(r.config.isProd, false);
        assert.equal(r.config.port, 3000);
        assert.equal(r.config.jwtExpiresIn, "1d");
        assert.equal(r.config.trustProxy, 0);
        assert.equal(r.config.cloudinary.enabled, false);
        assert.ok(r.config.corsOrigins.includes("http://localhost:5500"), "development falls back to localhost origins");
    });

    it("accepts a production environment and normalises CORS origins", async () => {
        const r = await load({
            ...GOOD,
            NODE_ENV: "production",
            CORS_ORIGINS: "https://rentit.example/ , https://app.rentit.example",
            PORT: "8080",
        });
        assert.equal(r.ok, true, r.stderr);
        assert.equal(r.config.isProd, true);
        assert.equal(r.config.port, 8080);
        assert.equal(r.config.trustProxy, 1);
        assert.deepEqual(r.config.corsOrigins, ["https://rentit.example", "https://app.rentit.example"]);
    });

    it("enables Cloudinary only when all three values are set", async () => {
        const r = await load({ ...GOOD, CLOUDINARY_CLOUD_NAME: "demo", CLOUDINARY_API_KEY: "key", CLOUDINARY_API_SECRET: "secret" });
        assert.equal(r.ok, true, r.stderr);
        assert.equal(r.config.cloudinary.enabled, true);
        assert.equal(r.config.cloudinary.cloudName, "demo");
    });

    const rejected = [
        ["a missing MONGO_URI", { JWT_SECRET: GOOD.JWT_SECRET }, "MONGO_URI is required"],
        ["a missing JWT_SECRET", { MONGO_URI: GOOD.MONGO_URI }, "JWT_SECRET is required"],
        ["a short JWT_SECRET", { ...GOOD, JWT_SECRET: "too-short" }, "at least 32 characters"],
        ["a placeholder JWT_SECRET in production", { ...GOOD, NODE_ENV: "production", CORS_ORIGINS: "https://a.example", JWT_SECRET: "change-me-".repeat(4) }, "looks like a placeholder"],
        ["a wildcard CORS origin", { ...GOOD, CORS_ORIGINS: "*" }, "not *"],
        ["production without CORS_ORIGINS", { ...GOOD, NODE_ENV: "production" }, "CORS_ORIGINS is required in production"],
        ["a malformed JWT_EXPIRES_IN", { ...GOOD, JWT_EXPIRES_IN: "forever" }, "JWT_EXPIRES_IN"],
        ["an out-of-range PORT", { ...GOOD, PORT: "70000" }, "PORT must be a valid port"],
        ["a short SETUP_ADMIN_TOKEN", { ...GOOD, SETUP_ADMIN_TOKEN: "short" }, "SETUP_ADMIN_TOKEN must be at least 24"],
        ["partial Cloudinary settings", { ...GOOD, CLOUDINARY_CLOUD_NAME: "demo" }, "must be set together"],
        ["a negative TRUST_PROXY", { ...GOOD, TRUST_PROXY: "-1" }, "TRUST_PROXY"],
    ];
    for (const [label, vars, expected] of rejected) {
        it(`refuses to start with ${label}`, async () => {
            const r = await load(vars);
            assert.equal(r.ok, false, "the process should have exited non-zero");
            assert.ok(r.stderr.includes("Invalid environment configuration"), r.stderr);
            assert.ok(r.stderr.includes(expected), `stderr should mention "${expected}":\n${r.stderr}`);
        });
    }

    it("reports every problem at once", async () => {
        const r = await load({});
        assert.equal(r.ok, false);
        assert.ok(r.stderr.includes("MONGO_URI is required") && r.stderr.includes("JWT_SECRET is required"), r.stderr);
    });
});

/* ------------------------------------------------------------------ createApp */

describe("createApp", () => {
    it("neither listens nor connects to the database", () => {
        createApp();
        assert.equal(mongoose.connection.readyState, 0);
    });

    it("disables x-powered-by and applies the configured proxy trust", () => {
        const app = createApp({ rateLimit: false });
        assert.equal(app.get("x-powered-by"), false);
        assert.equal(app.get("trust proxy"), env.trustProxy);
    });

    it("mounts every router on its documented paths", () => {
        const app = createApp({ rateLimit: false });
        const mounted = (router, p) => app.router.stack.some((layer) => layer.handle === router && layer.match(p));
        const expected = [
            [authRoutes, ["/api/auth"]],
            [kycRoutes, ["/api/kyc"]],
            [adminRoutes, ["/api/admin"]],
            [equipmentRoutes, ["/api/equipment", "/equipment"]],
            [categoryRoutes, ["/api/categories", "/category"]],
            [uploadRoutes, ["/api/uploads"]],
        ];
        for (const [router, paths] of expected) {
            for (const p of paths) assert.ok(mounted(router, `${p}/anything`), `${p} is not mounted`);
        }
        assert.ok(!mounted(equipmentRoutes, "/api/categories/x"), "routers must not answer for each other's paths");
    });

    describe("without rate limiting", () => {
        let server;
        before(async () => {
            server = await serve(createApp({ rateLimit: false }));
        });
        after(() => server.close());

        it("GET / keeps returning the welcome text", async () => {
            const r = await server.call("/");
            assert.equal(r.status, 200);
            assert.equal(r.text, "WELCOME TO BACKEND API");
        });

        it("GET /health answers 503 while the database is disconnected, without details", async () => {
            const r = await server.call("/health");
            assert.equal(r.status, 503);
            assert.deepEqual(r.json, { status: "degraded", db: "down" });
            assert.ok(!r.text.includes("mongodb"), "must not expose connection details");
        });

        it("GET /health answers 200 once the database is connected", async () => {
            // readyState is an inherited getter; shadow it on the instance, then remove the shadow.
            Object.defineProperty(mongoose.connection, "readyState", { get: () => 1, configurable: true });
            try {
                const r = await server.call("/health");
                assert.equal(r.status, 200);
                assert.deepEqual(r.json, { status: "ok", db: "up" });
            } finally {
                delete mongoose.connection.readyState;
            }
        });

        it("sends security headers and hides the framework", async () => {
            const r = await server.call("/");
            assert.equal(r.headers.get("x-powered-by"), null);
            assert.equal(r.headers.get("x-content-type-options"), "nosniff");
            assert.equal(r.headers.get("cross-origin-resource-policy"), "cross-origin");
            for (const name of ["content-security-policy", "strict-transport-security", "x-frame-options", "referrer-policy"]) {
                assert.ok(r.headers.get(name), `${name} should be set`);
            }
        });

        describe("CORS", () => {
            const listed = env.corsOrigins[0];
            const unlisted = "https://evil.example";

            it("echoes a listed origin, varies on Origin and never allows credentials", async () => {
                const r = await server.call("/", { headers: { origin: listed } });
                assert.equal(r.headers.get("access-control-allow-origin"), listed);
                assert.match(r.headers.get("vary"), /Origin/i);
                assert.equal(r.headers.get("access-control-allow-credentials"), null);
            });

            it("sends no CORS headers to an unlisted origin", async () => {
                const r = await server.call("/", { headers: { origin: unlisted } });
                assert.equal(r.headers.get("access-control-allow-origin"), null);
                assert.equal(r.headers.get("access-control-allow-credentials"), null);
                assert.match(r.headers.get("vary"), /Origin/i);
            });

            it("serves requests without an Origin header (curl, server to server)", async () => {
                const r = await server.call("/");
                assert.equal(r.status, 200);
                assert.equal(r.headers.get("access-control-allow-origin"), null);
            });

            it("answers a preflight from a listed origin with the allowed methods and headers", async () => {
                const r = await server.call("/api/auth/login", {
                    method: "OPTIONS",
                    headers: {
                        origin: listed,
                        "access-control-request-method": "POST",
                        "access-control-request-headers": "authorization,content-type",
                    },
                });
                assert.equal(r.status, 204);
                assert.equal(r.headers.get("access-control-allow-origin"), listed);
                for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
                    assert.match(r.headers.get("access-control-allow-methods"), new RegExp(method));
                }
                assert.equal(r.headers.get("access-control-allow-headers"), "Authorization,Content-Type,X-Setup-Token");
                assert.equal(r.headers.get("access-control-max-age"), "600");
            });

            it("does not approve a preflight from an unlisted origin", async () => {
                const r = await server.call("/api/auth/login", {
                    method: "OPTIONS",
                    headers: { origin: unlisted, "access-control-request-method": "POST" },
                });
                assert.equal(r.headers.get("access-control-allow-origin"), null);
                assert.equal(r.headers.get("access-control-allow-methods"), null);
            });
        });

        describe("request bodies", () => {
            const jsonOfSize = (bytes) => JSON.stringify({ blob: "a".repeat(bytes) });

            it("rejects a body over 100kb on an ordinary route with a JSON 413", async () => {
                const r = await server.call("/api/auth/login", { method: "POST", headers: JSON_HEADERS, body: jsonOfSize(150 * 1024) });
                assert.equal(r.status, 413);
                assert.match(r.headers.get("content-type"), /application\/json/);
                assert.deepEqual(r.json, { message: "Request body too large" });
            });

            // A signed token for a user that does not exist: enough for the pre-parse
            // signature check; the route's protect() would still reject it later.
            const SIGNED = {
                ...JSON_HEADERS,
                authorization: `Bearer ${signToken({ _id: "507f1f77bcf86cd799439011", role: "owner", tokenVersion: 0 })}`,
            };

            it("lets /api/kyc through above 100kb for a signed-in caller (the router then checks the user)", async () => {
                // No database in unit tests: the user lookup in protect() finds nobody.
                const lookup = mock.method(User, "findById", () => ({ select: async () => null }));
                try {
                    const r = await server.call("/api/kyc", { method: "POST", headers: SIGNED, body: jsonOfSize(200 * 1024) });
                    assert.equal(r.status, 401);
                    assert.deepEqual(r.json, { message: "Not authorized, invalid token" });
                    assert.equal(lookup.mock.callCount(), 1, "the body was parsed and the route ran");
                } finally {
                    lookup.mock.restore();
                }
            });

            for (const route of ["/api/kyc", "/api/equipment", "/equipment"]) {
                it(`still caps ${route} at 8mb`, async () => {
                    const r = await server.call(route, { method: "POST", headers: SIGNED, body: jsonOfSize(9 * 1024 * 1024) });
                    assert.equal(r.status, 413);
                    assert.deepEqual(r.json, { message: "Request body too large" });
                });

                it(`refuses an anonymous large body on ${route} before parsing it`, async () => {
                    for (const headers of [JSON_HEADERS, { ...JSON_HEADERS, authorization: "Bearer not-a-jwt" }]) {
                        const r = await server.call(route, { method: "POST", headers, body: jsonOfSize(9 * 1024 * 1024) });
                        // 401, not 413: the body was never handed to the JSON parser.
                        assert.equal(r.status, 401, route);
                    }
                });
            }

            it("answers malformed JSON with a JSON 400", async () => {
                for (const body of ['{"email":', "not json", '"just a string"']) {
                    const r = await server.call("/api/auth/login", { method: "POST", headers: JSON_HEADERS, body });
                    assert.equal(r.status, 400, body);
                    assert.deepEqual(r.json, { message: "Invalid JSON body" });
                }
            });
        });

        it("answers unknown routes with a JSON 404", async () => {
            for (const [method, route] of [["GET", "/nope"], ["POST", "/api/nope"], ["DELETE", "/api/auth/nope"]]) {
                const r = await server.call(route, { method });
                assert.equal(r.status, 404, `${method} ${route}`);
                assert.match(r.headers.get("content-type"), /application\/json/);
                assert.deepEqual(r.json, { message: "Not found" });
            }
        });

        it("does not rate limit when rateLimit is false", async () => {
            for (let i = 0; i < 25; i++) {
                const r = await server.call("/api/auth/login", BROKEN_JSON);
                assert.equal(r.status, 400, `attempt ${i + 1}`);
            }
        });
    });

    describe("with rate limiting", () => {
        const TOO_MANY = { message: "Too many requests, please try again later." };

        /** Send `count` requests (all must be answered by `expected`), then one more that must be limited. */
        async function exhaust(server, route, count, init, expected) {
            for (let i = 1; i <= count; i++) {
                const r = await server.call(route, init);
                assert.equal(r.status, expected, `request ${i} to ${route} should not be limited`);
            }
            return server.call(route, init);
        }

        it("limits login to 20 attempts per window and answers the 21st with 429", async () => {
            const server = await serve(createApp());
            try {
                const r = await exhaust(server, "/api/auth/login", 20, BROKEN_JSON, 400);
                assert.equal(r.status, 429);
                assert.deepEqual(r.json, TOO_MANY);
                assert.match(r.headers.get("content-type"), /application\/json/);
                assert.ok(r.headers.get("ratelimit"), "draft-7 RateLimit header");
                assert.ok(r.headers.get("ratelimit-policy"), "draft-7 RateLimit-Policy header");
                assert.equal(r.headers.get("x-ratelimit-limit"), null, "legacy headers are off");
                assert.ok(r.headers.get("retry-after"));
            } finally {
                await server.close();
            }
        });

        it("shares the 20-attempt budget between login and register", async () => {
            const server = await serve(createApp());
            try {
                for (let i = 0; i < 10; i++) await server.call("/api/auth/login", BROKEN_JSON);
                const r = await exhaust(server, "/api/auth/register", 10, BROKEN_JSON, 400);
                assert.equal(r.status, 429);
            } finally {
                await server.close();
            }
        });

        it("limits setup-admin to 5 per hour", async () => {
            const server = await serve(createApp());
            try {
                const r = await exhaust(server, "/api/auth/setup-admin", 5, BROKEN_JSON, 400);
                assert.equal(r.status, 429);
                assert.deepEqual(r.json, TOO_MANY);
            } finally {
                await server.close();
            }
        });

        it("limits KYC submissions to 10 per hour but not reads", async () => {
            const server = await serve(createApp());
            try {
                // Anonymous, so the pre-parse token check answers 401; the limiter still counts it.
                const r = await exhaust(server, "/api/kyc", 10, BROKEN_JSON, 401);
                assert.equal(r.status, 429);
                assert.deepEqual(r.json, TOO_MANY);
                const read = await server.call("/api/kyc/me");
                assert.equal(read.status, 401, "GET /api/kyc/me is not covered by the submission limiter");
            } finally {
                await server.close();
            }
        });

        it("limits /api, /equipment and /category together to 300 requests per window", async () => {
            const server = await serve(createApp());
            try {
                const routes = ["/api/anything", "/equipment", "/category"];
                for (let i = 0; i < 300; i++) {
                    const route = routes[i % routes.length];
                    const r = await server.call(route, BROKEN_JSON);
                    // Anonymous writes to /equipment stop at the pre-parse token check (401).
                    assert.equal(r.status, route === "/equipment" ? 401 : 400, `request ${i + 1} should not be limited`);
                }
                for (const route of routes) {
                    const r = await server.call(route, BROKEN_JSON);
                    assert.equal(r.status, 429, route);
                    assert.deepEqual(r.json, TOO_MANY);
                }
                const home = await server.call("/");
                assert.equal(home.status, 200, "paths outside the limited prefixes are untouched");
                const health = await server.call("/health");
                assert.equal(health.status, 503, "health checks are never rate limited");
            } finally {
                await server.close();
            }
        });

        it("starts every app with fresh counters", async () => {
            const server = await serve(createApp());
            try {
                const r = await server.call("/api/auth/login", BROKEN_JSON);
                assert.equal(r.status, 400);
            } finally {
                await server.close();
            }
        });
    });
});
