/**
 * Integration-test harness: the real app on an ephemeral port, backed by a
 * disposable MongoDB.
 *
 *   import "../helpers/setEnv.js";                  // must be the first import
 *   import { startTestServer, dropDatabase } from "../helpers/testServer.js";
 *
 *   const server = await startTestServer();         // before(): connect + listen
 *   const { status, body } = await server.request("/api/auth/login", { method: "POST", json: {...} });
 *   await dropDatabase();                           // beforeEach(): clean slate
 *   await server.close();                           // after(): stop + disconnect
 *
 * Requires TEST_MONGO_URI (for example mongodb://127.0.0.1:27017/rentit_test).
 * That database is written to and DROPPED by the tests, so it must never hold
 * real data; names such as "rentit", "admin" or anything containing "prod" are refused.
 * Rate limiting is off by default; pass { rateLimit: true } to test it.
 */
import mongoose from "mongoose";
import { createApp } from "../../app.js";

const REQUEST_TIMEOUT_MS = 15_000;

function connectionString() {
    const uri = process.env.TEST_MONGO_URI;
    if (!uri) {
        throw new Error(
            "TEST_MONGO_URI is not set. Point it at a disposable MongoDB, " +
            "e.g. TEST_MONGO_URI=mongodb://127.0.0.1:27017/rentit_test"
        );
    }
    return uri;
}

/** Guard against pointing the destructive helpers at a real database by mistake. */
function assertDisposable(name) {
    if (!name || /^(rentit|admin|local|config)$/i.test(name) || /prod/i.test(name)) {
        throw new Error(`Refusing to use database "${name}" for tests: use a dedicated one such as rentit_test`);
    }
}

/**
 * Connect, start the app on port 0 and return { baseUrl, close, request }.
 * `options` is passed to createApp(). Call it once per test file: close()
 * disconnects the process-wide mongoose connection.
 */
export async function startTestServer(options = {}) {
    const uri = connectionString();
    mongoose.set("strictQuery", true);
    if (mongoose.connection.readyState === 0) {
        await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
    }
    try {
        assertDisposable(mongoose.connection.name);
    } catch (err) {
        await mongoose.disconnect();
        throw err;
    }

    const server = await new Promise((resolve, reject) => {
        const s = createApp({ rateLimit: false, ...options }).listen(0, "127.0.0.1", () => resolve(s));
        s.once("error", reject);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    /**
     * Send a request to the app. `json` is serialised as the JSON body; `body`
     * sends a raw string instead (for malformed-JSON tests). `token` becomes a
     * Bearer header. Returns { status, headers, body, res }: `body` is the
     * parsed JSON when the response is JSON (null if empty), else the text;
     * `res` is the fetch Response with its body already consumed.
     */
    async function request(path, { method = "GET", token, json, body, headers = {} } = {}) {
        const sent = { ...headers };
        if (token) sent.authorization = `Bearer ${token}`;
        let payload = body;
        if (json !== undefined) {
            payload = JSON.stringify(json);
            sent["content-type"] = "application/json";
        }
        const res = await fetch(baseUrl + path, {
            method,
            headers: sent,
            body: payload,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const text = await res.text();
        const isJson = (res.headers.get("content-type") || "").includes("application/json");
        return { status: res.status, headers: res.headers, body: isJson ? (text ? JSON.parse(text) : null) : text, res };
    }

    async function close() {
        await new Promise((resolve) => {
            server.close(resolve);
            // Keep-alive sockets from fetch would otherwise delay the close callback.
            server.closeAllConnections();
        });
        await mongoose.disconnect();
    }

    return { baseUrl, close, request };
}

/**
 * Drop the whole test database, then rebuild the schema indexes (dropping
 * removes them, and unique-email style constraints must keep working).
 * Needs an open connection, i.e. a started test server.
 */
export async function dropDatabase() {
    if (mongoose.connection.readyState !== 1) {
        throw new Error("dropDatabase() needs an open connection: call startTestServer() first");
    }
    assertDisposable(mongoose.connection.name);
    await mongoose.connection.dropDatabase();
    await Promise.all(Object.values(mongoose.models).map((model) => model.createIndexes()));
}
