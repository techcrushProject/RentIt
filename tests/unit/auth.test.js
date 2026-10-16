import "../helpers/setEnv.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import env from "../../config/env.js";
import {
    createFirstAdmin,
    getMe,
    loginUser,
    logoutUser,
    registerUser,
    updateUserRole,
} from "../../Controllers/authController.js";
import protect, { optionalAuth, verifyToken } from "../../Middleware/authMiddleware.js";
import authorizeRoles from "../../Middleware/roleMiddleware.js";
import Setting from "../../Models/setting.js";
import User from "../../Models/user.js";
import authRouter from "../../Routes/authRoutes.js";
import { HttpError } from "../../utils/httpError.js";
import { signToken, verifyJwt } from "../../utils/token.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const USER_ID = "64b7f0c2a1b2c3d4e5f60718";
const OTHER_ID = "64b7f0c2a1b2c3d4e5f60719";
const GOOD_PASSWORD = "Passw0rdOK";

/* ---------- helpers ---------- */

// Stubs are plain assignments onto the real model/library objects, undone after every test.
const restores = [];
function stub(target, name, fn) {
    const own = Object.hasOwn(target, name);
    const original = target[name];
    target[name] = fn;
    restores.push(() => {
        if (own) target[name] = original;
        else delete target[name];
    });
}
afterEach(() => {
    while (restores.length) restores.pop()();
});

/** Makes any database call fail the test, to prove a code path never reaches the database. */
function forbidDatabase() {
    const boom = (what) => () => {
        throw new Error(`unexpected database call: ${what}`);
    };
    for (const name of ["findById", "findOne", "exists", "create", "updateOne", "countDocuments"]) {
        stub(User, name, boom(`User.${name}`));
    }
    for (const name of ["updateOne", "deleteOne"]) stub(Setting, name, boom(`Setting.${name}`));
}

/** Records calls to a stubbed method and returns the list of argument arrays. */
function record(target, name, impl) {
    const calls = [];
    stub(target, name, (...args) => {
        calls.push(args);
        return impl(...args);
    });
    return calls;
}

/** Cost-4 hashing keeps the suite fast; the cost the controller asked for is still recorded. */
const realHash = bcrypt.hash;
function fastHash() {
    return record(bcrypt, "hash", (password) => realHash(password, 4));
}

const fakeRes = () => ({
    statusCode: undefined,
    body: undefined,
    status(code) {
        this.statusCode = code;
        return this;
    },
    json(body) {
        this.body = body;
        return this;
    },
});

const fakeReq = (over = {}) => ({ headers: {}, body: undefined, ...over });

const nextSpy = () => {
    const calls = [];
    const next = (...args) => calls.push(args);
    next.calls = calls;
    return next;
};

const dbUser = (over = {}) => ({
    _id: USER_ID,
    name: "Ada Obi",
    email: "ada@example.com",
    role: "renter",
    kycStatus: "not_submitted",
    isVerified: false,
    tokenVersion: 0,
    ...over,
});

/** Stubs User.findById(...).select(...) the way the middleware calls it. */
function findByIdReturns(doc) {
    const calls = [];
    stub(User, "findById", (id) => ({
        select: async (fields) => {
            calls.push({ id, fields });
            return doc;
        },
    }));
    return calls;
}

const tokenFor = (claims = {}, secret = env.jwtSecret, options = {}) =>
    jwt.sign({ id: USER_ID, role: "renter", tv: 0, ...claims }, secret, {
        algorithm: "HS256",
        expiresIn: "1h",
        ...options,
    });

const expiredToken = (secret = env.jwtSecret) =>
    jwt.sign({ id: USER_ID, role: "renter", tv: 0, exp: Math.floor(Date.now() / 1000) - 60 }, secret, { algorithm: "HS256" });

const b64 = (object) => Buffer.from(JSON.stringify(object)).toString("base64url");

async function run(middleware, headers) {
    const req = fakeReq({ headers });
    const res = fakeRes();
    const next = nextSpy();
    await middleware(req, res, next);
    return { req, res, next };
}

const bearer = (token) => ({ authorization: `Bearer ${token}` });

function assertRejected401(result, message) {
    assert.equal(result.res.statusCode, 401);
    assert.deepEqual(result.res.body, { message });
    assert.equal(result.next.calls.length, 0);
    assert.equal(result.req.user, undefined);
}

/** Asserts the handler rejects with an HttpError of the given status (and message when given). */
async function assertHttpError(promise, status, message) {
    await assert.rejects(promise, (error) => {
        assert.ok(error instanceof HttpError, `expected HttpError, got ${error}`);
        assert.equal(error.status, status, error.message);
        if (message !== undefined) assert.equal(error.message, message);
        return true;
    });
}

const call = (handler, { body, user, headers = {} } = {}) => {
    const res = fakeRes();
    return { res, done: handler(fakeReq({ body, user, headers }), res) };
};

/* ---------- protect ---------- */

describe("protect", () => {
    it("exposes verifyToken as the same function", () => {
        assert.equal(verifyToken, protect);
    });

    it("rejects a request with no Authorization header", async () => {
        const calls = findByIdReturns(dbUser());
        assertRejected401(await run(protect, {}), "Not authorized, no token");
        assert.equal(calls.length, 0);
    });

    for (const [label, header] of [
        ["wrong scheme", `Basic ${tokenFor()}`],
        ["scheme only", "Bearer"],
        ["empty token", "Bearer "],
        ["bare token without scheme", tokenFor()],
        ["extra part", `Bearer ${tokenFor()} extra`],
        ["double space", `Bearer  ${tokenFor()}`],
    ]) {
        it(`treats ${label} as no token`, async () => {
            const calls = findByIdReturns(dbUser());
            assertRejected401(await run(protect, { authorization: header }), "Not authorized, no token");
            assert.equal(calls.length, 0);
        });
    }

    it("accepts the Bearer scheme in any letter case", async () => {
        findByIdReturns(dbUser());
        for (const scheme of ["bearer", "BEARER", "BeArEr"]) {
            const { next } = await run(protect, { authorization: `${scheme} ${tokenFor()}` });
            assert.equal(next.calls.length, 1);
        }
    });

    it("rejects a token with a tampered signature", async () => {
        const calls = findByIdReturns(dbUser());
        const token = tokenFor();
        const [head, payload, signature] = token.split(".");
        const flipped = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
        assertRejected401(await run(protect, bearer(`${head}.${payload}.${flipped}`)), "Not authorized, invalid token");
        assert.equal(calls.length, 0);
    });

    it("rejects a token whose payload was edited after signing", async () => {
        const calls = findByIdReturns(dbUser());
        const [head, , signature] = tokenFor({ role: "renter" }).split(".");
        const forged = b64({ id: USER_ID, role: "admin", tv: 0 });
        assertRejected401(await run(protect, bearer(`${head}.${forged}.${signature}`)), "Not authorized, invalid token");
        assert.equal(calls.length, 0);
    });

    it("rejects an expired token", async () => {
        const calls = findByIdReturns(dbUser());
        assertRejected401(await run(protect, bearer(expiredToken())), "Not authorized, invalid token");
        assert.equal(calls.length, 0);
    });

    it("rejects an unsigned alg:none token", async () => {
        const calls = findByIdReturns(dbUser());
        const unsigned = `${b64({ alg: "none", typ: "JWT" })}.${b64({ id: USER_ID, role: "admin", tv: 0 })}.`;
        assertRejected401(await run(protect, bearer(unsigned)), "Not authorized, invalid token");
        assert.equal(calls.length, 0);
    });

    it("rejects a token signed with another secret", async () => {
        const calls = findByIdReturns(dbUser());
        const foreign = tokenFor({}, "another-secret-another-secret-another-secret-9876");
        assertRejected401(await run(protect, bearer(foreign)), "Not authorized, invalid token");
        assert.equal(calls.length, 0);
    });

    it("rejects a token signed with an algorithm other than HS256", async () => {
        const calls = findByIdReturns(dbUser());
        const hs512 = tokenFor({}, env.jwtSecret, { algorithm: "HS512" });
        assertRejected401(await run(protect, bearer(hs512)), "Not authorized, invalid token");
        assert.equal(calls.length, 0);
    });

    it("rejects garbage that is not a JWT", async () => {
        assertRejected401(await run(protect, bearer("not.a.jwt")), "Not authorized, invalid token");
        assertRejected401(await run(protect, bearer("x")), "Not authorized, invalid token");
    });

    for (const [label, claims] of [
        ["a malformed id", { id: "not-an-object-id" }],
        ["a non-string id", { id: { $gt: "" } }],
        ["a numeric id", { id: 12345 }],
        ["no id", { id: undefined }],
    ]) {
        it(`answers 401, not 500, for a signed token with ${label}`, async () => {
            // The real findById would throw a CastError; the stub throws too if the guard is missing.
            stub(User, "findById", () => {
                throw new Error("findById must not be called for a malformed id");
            });
            assertRejected401(await run(protect, bearer(tokenFor(claims))), "Not authorized, invalid token");
        });
    }

    it("rejects a valid token whose user no longer exists", async () => {
        findByIdReturns(null);
        assertRejected401(await run(protect, bearer(tokenFor())), "Not authorized, invalid token");
    });

    it("rejects a token with a stale tokenVersion", async () => {
        findByIdReturns(dbUser({ tokenVersion: 1 }));
        assertRejected401(await run(protect, bearer(tokenFor({ tv: 0 }))), "Not authorized, invalid token");
    });

    it("rejects a token that has no tokenVersion claim", async () => {
        findByIdReturns(dbUser());
        assertRejected401(await run(protect, bearer(tokenFor({ tv: undefined }))), "Not authorized, invalid token");
    });

    it("treats a user document without tokenVersion as version 0", async () => {
        findByIdReturns(dbUser({ tokenVersion: undefined }));
        const { next } = await run(protect, bearer(tokenFor({ tv: 0 })));
        assert.equal(next.calls.length, 1);
    });

    it("takes the role from the database, never from the token claim", async () => {
        findByIdReturns(dbUser({ role: "renter" }));
        const { req, next } = await run(protect, bearer(tokenFor({ role: "admin" })));
        assert.equal(next.calls.length, 1);
        assert.equal(req.user.role, "renter");
    });

    it("loads the user fresh with the tokenVersion field selected and sets a minimal req.user", async () => {
        const calls = findByIdReturns(dbUser({ role: "owner", kycStatus: "verified", isVerified: true, password: "hash", tokenVersion: 3 }));
        const { req, res, next } = await run(protect, bearer(tokenFor({ role: "owner", tv: 3 })));

        assert.deepEqual(calls, [{ id: USER_ID, fields: "+tokenVersion" }]);
        assert.deepEqual(next.calls, [[]]);
        assert.equal(res.statusCode, undefined);
        assert.deepEqual(req.user, {
            id: USER_ID,
            role: "owner",
            name: "Ada Obi",
            email: "ada@example.com",
            kycStatus: "verified",
            isVerified: true,
        });
    });

    it("sets req.user.id to a string even when the database returns an ObjectId", async () => {
        const mongoose = (await import("mongoose")).default;
        findByIdReturns(dbUser({ _id: new mongoose.Types.ObjectId(USER_ID) }));
        const { req } = await run(protect, bearer(tokenFor()));
        assert.equal(typeof req.user.id, "string");
        assert.equal(req.user.id, USER_ID);
    });

    it("works with tokens issued by signToken", async () => {
        findByIdReturns(dbUser({ tokenVersion: 2 }));
        const token = signToken({ _id: USER_ID, role: "renter", tokenVersion: 2 });
        const { next } = await run(protect, bearer(token));
        assert.equal(next.calls.length, 1);
    });

    it("lets a database failure propagate instead of answering 401", async () => {
        stub(User, "findById", () => ({
            select: async () => {
                throw new Error("connection lost");
            },
        }));
        await assert.rejects(run(protect, bearer(tokenFor())), /connection lost/);
    });
});

/* ---------- optionalAuth ---------- */

describe("optionalAuth", () => {
    it("continues anonymously without a header", async () => {
        const { req, res, next } = await run(optionalAuth, {});
        assert.deepEqual(next.calls, [[]]);
        assert.equal(req.user, undefined);
        assert.equal(res.statusCode, undefined);
    });

    for (const [label, headers] of [
        ["a wrong scheme", { authorization: "Basic abc" }],
        ["a garbage token", bearer("garbage")],
        ["a tampered token", bearer(`${tokenFor().slice(0, -3)}abc`)],
        ["an expired token", bearer(expiredToken())],
        ["a token signed with another secret", bearer(tokenFor({}, "another-secret-another-secret-another-secret-9876"))],
        ["a malformed id", bearer(tokenFor({ id: "nope" }))],
    ]) {
        it(`continues anonymously with ${label}`, async () => {
            findByIdReturns(dbUser());
            const { req, res, next } = await run(optionalAuth, headers);
            assert.deepEqual(next.calls, [[]]);
            assert.equal(req.user, undefined);
            assert.equal(res.statusCode, undefined);
        });
    }

    it("continues anonymously when the user was deleted", async () => {
        findByIdReturns(null);
        const { req, next } = await run(optionalAuth, bearer(tokenFor()));
        assert.equal(next.calls.length, 1);
        assert.equal(req.user, undefined);
    });

    it("continues anonymously when the tokenVersion is stale", async () => {
        findByIdReturns(dbUser({ tokenVersion: 5 }));
        const { req, next } = await run(optionalAuth, bearer(tokenFor({ tv: 4 })));
        assert.equal(next.calls.length, 1);
        assert.equal(req.user, undefined);
    });

    it("sets req.user for a valid token, with the role from the database", async () => {
        findByIdReturns(dbUser({ role: "owner" }));
        const { req, next } = await run(optionalAuth, bearer(tokenFor({ role: "admin" })));
        assert.deepEqual(next.calls, [[]]);
        assert.equal(req.user.id, USER_ID);
        assert.equal(req.user.role, "owner");
    });
});

/* ---------- authorizeRoles ---------- */

describe("authorizeRoles", () => {
    it("answers 401 when nobody is authenticated", () => {
        const res = fakeRes();
        const next = nextSpy();
        authorizeRoles("admin")(fakeReq(), res, next);
        assert.equal(res.statusCode, 401);
        assert.deepEqual(res.body, { message: "Not authenticated" });
        assert.equal(next.calls.length, 0);
    });

    it("answers 403 when the role is not listed", () => {
        const res = fakeRes();
        const next = nextSpy();
        authorizeRoles("admin")(fakeReq({ user: { role: "owner" } }), res, next);
        assert.equal(res.statusCode, 403);
        assert.deepEqual(res.body, { message: "Access denied" });
        assert.equal(next.calls.length, 0);
    });

    it("calls next for a listed role", () => {
        const res = fakeRes();
        const next = nextSpy();
        authorizeRoles("owner")(fakeReq({ user: { role: "owner" } }), res, next);
        assert.deepEqual(next.calls, [[]]);
        assert.equal(res.statusCode, undefined);
    });

    it("accepts any of several roles", () => {
        const guard = authorizeRoles("owner", "admin");
        for (const role of ["owner", "admin"]) {
            const next = nextSpy();
            guard(fakeReq({ user: { role } }), fakeRes(), next);
            assert.equal(next.calls.length, 1, role);
        }
        const res = fakeRes();
        guard(fakeReq({ user: { role: "renter" } }), res, nextSpy());
        assert.equal(res.statusCode, 403);
    });

    it("denies everyone when no roles are listed", () => {
        const res = fakeRes();
        authorizeRoles()(fakeReq({ user: { role: "admin" } }), res, nextSpy());
        assert.equal(res.statusCode, 403);
    });

    it("does not treat a missing role as a match", () => {
        const res = fakeRes();
        authorizeRoles("admin")(fakeReq({ user: {} }), res, nextSpy());
        assert.equal(res.statusCode, 403);
    });
});

/* ---------- registerUser ---------- */

describe("registerUser", () => {
    const valid = { name: "Ada Obi", email: "Ada@Example.com", password: GOOD_PASSWORD };

    describe("rejects invalid input before touching the database", () => {
        for (const [label, body] of [
            ["no body at all", undefined],
            ["an array body", []],
            ["a missing name", { ...valid, name: undefined }],
            ["a one-character name", { ...valid, name: "A" }],
            ["a name over 100 characters", { ...valid, name: "a".repeat(101) }],
            ["an object name", { ...valid, name: { $ne: "" } }],
            ["a numeric name", { ...valid, name: 42 }],
            ["a first name over 50 characters", { ...valid, firstName: "a".repeat(51) }],
            ["an object first name", { ...valid, firstName: { $gt: "" } }],
            ["a last name over 50 characters", { ...valid, lastName: "a".repeat(51) }],
            ["a business name over 100 characters", { ...valid, businessName: "a".repeat(101) }],
            ["an invalid phone", { ...valid, phone: "abc" }],
            ["an object phone", { ...valid, phone: { $gt: "" } }],
            ["a missing email", { ...valid, email: undefined }],
            ["an object email", { ...valid, email: { $gt: "" } }],
            ["an array email", { ...valid, email: ["a@b.co"] }],
            ["a malformed email", { ...valid, email: "not-an-email" }],
            ["a missing password", { ...valid, password: undefined }],
            ["an empty password", { ...valid, password: "" }],
            ["a short password", { ...valid, password: "abc1" }],
            ["a password without a digit", { ...valid, password: "onlyletters" }],
            ["a password without a letter", { ...valid, password: "12345678" }],
            ["a password over 72 bytes", { ...valid, password: `a1${"x".repeat(71)}` }],
            ["a multi-byte password over 72 bytes", { ...valid, password: `a1${"é".repeat(36)}` }],
            ["an object password", { ...valid, password: { $ne: null } }],
            ["the admin role", { ...valid, role: "admin" }],
            ["an unknown role", { ...valid, role: "superuser" }],
            ["an object role", { ...valid, role: { $ne: "" } }],
        ]) {
            it(label, async () => {
                forbidDatabase();
                const { res, done } = call(registerUser, { body });
                await assertHttpError(done, 400);
                assert.equal(res.statusCode, undefined);
            });
        }
    });

    it("applies the password policy to the plaintext, not to a hash", async () => {
        forbidDatabase();
        const { done } = call(registerUser, { body: { ...valid, password: "short1" } });
        await assertHttpError(done, 400, "Password must be at least 8 characters");
    });

    it("answers 409 when the email is found by lookup", async () => {
        forbidDatabase();
        const lookups = record(User, "exists", async () => ({ _id: USER_ID }));
        const { done } = call(registerUser, { body: valid });
        await assertHttpError(done, 409, "An account with this email already exists");
        assert.deepEqual(lookups, [[{ email: "ada@example.com" }]]);
    });

    it("answers 409 when the unique index rejects a concurrent duplicate", async () => {
        forbidDatabase();
        stub(User, "exists", async () => null);
        stub(User, "create", async () => {
            throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
        });
        fastHash();
        const { done } = call(registerUser, { body: valid });
        await assertHttpError(done, 409, "An account with this email already exists");
    });

    it("lets unexpected database errors through unchanged", async () => {
        forbidDatabase();
        stub(User, "exists", async () => null);
        const failure = new Error("disk on fire");
        stub(User, "create", async () => {
            throw failure;
        });
        fastHash();
        const { done } = call(registerUser, { body: valid });
        await assert.rejects(done, (error) => error === failure);
    });

    it("hashes the password with bcrypt cost 12 and answers 201", async () => {
        forbidDatabase();
        stub(User, "exists", async () => null);
        const created = record(User, "create", async (doc) => doc);
        const { res, done } = call(registerUser, { body: { ...valid, firstName: " Ada ", businessName: "", phone: "+234 801 234 5678" } });
        await done;

        assert.equal(res.statusCode, 201);
        assert.deepEqual(res.body, { message: "User registered successfully" });

        const [[doc]] = created;
        assert.equal(doc.email, "ada@example.com");
        assert.equal(doc.role, "renter");
        assert.equal(doc.firstName, "Ada");
        assert.equal(doc.businessName, undefined);
        assert.equal(doc.lastName, undefined);
        assert.equal(doc.phone, "+234 801 234 5678");
        assert.notEqual(doc.password, GOOD_PASSWORD);
        assert.equal(bcrypt.getRounds(doc.password), 12);
        assert.ok(await bcrypt.compare(GOOD_PASSWORD, doc.password));
    });

    it("lets a user register as an owner", async () => {
        forbidDatabase();
        stub(User, "exists", async () => null);
        const created = record(User, "create", async (doc) => doc);
        const hashes = fastHash();
        const { res, done } = call(registerUser, { body: { ...valid, role: "owner" } });
        await done;
        assert.equal(res.statusCode, 201);
        assert.equal(created[0][0].role, "owner");
        assert.deepEqual(hashes.map(([, cost]) => cost), [12]);
    });

    it("never copies unexpected body fields into the new user", async () => {
        forbidDatabase();
        stub(User, "exists", async () => null);
        const created = record(User, "create", async (doc) => doc);
        fastHash();
        const { done } = call(registerUser, { body: { ...valid, isVerified: true, kycStatus: "verified", tokenVersion: 99, _id: OTHER_ID } });
        await done;
        const [[doc]] = created;
        for (const key of ["isVerified", "kycStatus", "tokenVersion", "_id"]) assert.equal(key in doc, false, key);
    });
});

/* ---------- loginUser ---------- */

describe("loginUser", () => {
    const hash = bcrypt.hashSync(GOOD_PASSWORD, 4);
    const stored = () => ({
        _id: USER_ID,
        name: "Ada Obi",
        firstName: "Ada",
        lastName: "Obi",
        businessName: "Ada Rentals",
        email: "ada@example.com",
        phone: "+2348012345678",
        role: "owner",
        password: hash,
        tokenVersion: 2,
    });

    function findOneReturns(doc) {
        return record(User, "findOne", () => ({ select: async () => doc }));
    }

    describe("rejects invalid input before touching the database", () => {
        for (const [label, body] of [
            ["no body", undefined],
            ["a missing email", { password: GOOD_PASSWORD }],
            ["an object email (NoSQL injection)", { email: { $gt: "" }, password: GOOD_PASSWORD }],
            ["a malformed email", { email: "nope", password: GOOD_PASSWORD }],
            ["a missing password", { email: "ada@example.com" }],
            ["an empty password", { email: "ada@example.com", password: "" }],
            ["a numeric password", { email: "ada@example.com", password: 12345678 }],
            ["an object password (NoSQL injection)", { email: "ada@example.com", password: { $ne: null } }],
            ["an array password", { email: "ada@example.com", password: [GOOD_PASSWORD] }],
            ["a password over 72 bytes", { email: "ada@example.com", password: "a".repeat(73) }],
            ["a multi-byte password over 72 bytes", { email: "ada@example.com", password: "é".repeat(37) }],
        ]) {
            it(label, async () => {
                forbidDatabase();
                const { done } = call(loginUser, { body });
                await assertHttpError(done, 400);
            });
        }
    });

    it("does not apply the registration password policy", async () => {
        forbidDatabase();
        findOneReturns(null);
        // A weak legacy password must still reach the credential check and get the generic 401.
        const { done } = call(loginUser, { body: { email: "ada@example.com", password: "weak" } });
        await assertHttpError(done, 401, "Invalid email or password");
    });

    it("logs in with the right password and returns the documented shape", async () => {
        forbidDatabase();
        const finds = [];
        stub(User, "findOne", (filter) => ({
            select: async (fields) => {
                finds.push({ filter, fields });
                return stored();
            },
        }));
        const updates = record(User, "updateOne", async () => ({}));

        const { res, done } = call(loginUser, { body: { email: " ADA@Example.com ", password: GOOD_PASSWORD } });
        await done;

        assert.deepEqual(finds, [{ filter: { email: "ada@example.com" }, fields: "+password +tokenVersion" }]);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.message, "Login successful");
        assert.deepEqual(res.body.user, {
            id: USER_ID,
            name: "Ada Obi",
            firstName: "Ada",
            lastName: "Obi",
            businessName: "Ada Rentals",
            email: "ada@example.com",
            phone: "+2348012345678",
            role: "owner",
        });
        assert.equal("password" in res.body.user, false);

        const claims = verifyJwt(res.body.token);
        assert.equal(claims.id, USER_ID);
        assert.equal(claims.role, "owner");
        assert.equal(claims.tv, 2);

        assert.equal(updates.length, 1);
        assert.deepEqual(updates[0][0], { _id: USER_ID });
        assert.deepEqual(Object.keys(updates[0][1]), ["$set"]);
        assert.ok(updates[0][1].$set.lastLoginAt instanceof Date);
    });

    it("answers a generic 401 for a wrong password and records no login", async () => {
        forbidDatabase();
        findOneReturns(stored());
        const { done } = call(loginUser, { body: { email: "ada@example.com", password: "WrongPass1" } });
        await assertHttpError(done, 401, "Invalid email or password");
    });

    it("answers the same 401 for an unknown email and still runs bcrypt against a cost-12 dummy hash", async () => {
        forbidDatabase();
        findOneReturns(null);
        const compares = record(bcrypt, "compare", async () => false);
        const { done } = call(loginUser, { body: { email: "ghost@example.com", password: GOOD_PASSWORD } });
        await assertHttpError(done, 401, "Invalid email or password");

        assert.equal(compares.length, 1);
        const [plain, dummy] = compares[0];
        assert.equal(plain, GOOD_PASSWORD);
        assert.equal(bcrypt.getRounds(dummy), 12);
    });

    it("does not let a matching dummy comparison log anyone in", async () => {
        forbidDatabase();
        findOneReturns(null);
        stub(bcrypt, "compare", async () => true);
        const { done } = call(loginUser, { body: { email: "ghost@example.com", password: GOOD_PASSWORD } });
        await assertHttpError(done, 401, "Invalid email or password");
    });
});

/* ---------- logoutUser and getMe ---------- */

describe("logoutUser", () => {
    it("bumps tokenVersion for the caller and answers 200", async () => {
        forbidDatabase();
        const updates = record(User, "updateOne", async () => ({}));
        const { res, done } = call(logoutUser, { user: { id: USER_ID } });
        await done;
        assert.deepEqual(updates, [[{ _id: USER_ID }, { $inc: { tokenVersion: 1 } }]]);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, { message: "Logged out" });
    });
});

describe("getMe", () => {
    it("returns the fresh database record in the documented shape", async () => {
        forbidDatabase();
        const reads = record(User, "findById", async () => ({
            ...dbUser({ role: "owner", kycStatus: "verified", isVerified: true }),
            firstName: "Ada",
            lastName: "Obi",
            businessName: "Ada Rentals",
            phone: "+2348012345678",
            password: "must-not-leak",
            tokenVersion: 7,
        }));
        const { res, done } = call(getMe, { user: { id: USER_ID, role: "renter" } });
        await done;

        assert.deepEqual(reads, [[USER_ID]]);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, {
            user: {
                id: USER_ID,
                name: "Ada Obi",
                firstName: "Ada",
                lastName: "Obi",
                businessName: "Ada Rentals",
                email: "ada@example.com",
                phone: "+2348012345678",
                role: "owner",
                kycStatus: "verified",
                isVerified: true,
            },
        });
    });

    it("answers 401 when the account disappeared after authentication", async () => {
        forbidDatabase();
        stub(User, "findById", async () => null);
        const { done } = call(getMe, { user: { id: USER_ID } });
        await assertHttpError(done, 401);
    });
});

/* ---------- updateUserRole ---------- */

describe("updateUserRole", () => {
    const admin = { id: USER_ID, role: "admin" };

    describe("rejects invalid input before touching the database", () => {
        for (const [label, body] of [
            ["no body", undefined],
            ["a missing userId", { role: "owner" }],
            ["a malformed userId", { userId: "123", role: "owner" }],
            ["an object userId (NoSQL injection)", { userId: { $ne: "" }, role: "owner" }],
            ["a missing role", { userId: OTHER_ID }],
            ["an unknown role", { userId: OTHER_ID, role: "superuser" }],
            ["an object role", { userId: OTHER_ID, role: { $ne: "" } }],
        ]) {
            it(label, async () => {
                forbidDatabase();
                const { done } = call(updateUserRole, { body, user: admin });
                await assertHttpError(done, 400);
            });
        }
    });

    it("answers 404 when the target does not exist", async () => {
        forbidDatabase();
        stub(User, "findById", async () => null);
        const { done } = call(updateUserRole, { body: { userId: OTHER_ID, role: "owner" }, user: admin });
        await assertHttpError(done, 404, "User not found");
    });

    it("refuses to let an admin change their own role", async () => {
        forbidDatabase();
        stub(User, "findById", async () => ({ _id: USER_ID, role: "admin" }));
        // Upper-case hex must not sneak past the comparison.
        const { done } = call(updateUserRole, { body: { userId: USER_ID.toUpperCase(), role: "renter" }, user: admin });
        await assertHttpError(done, 400, "You cannot change your own role");
    });

    it("refuses to demote the last remaining admin", async () => {
        forbidDatabase();
        stub(User, "findById", async () => ({ _id: OTHER_ID, role: "admin" }));
        stub(User, "countDocuments", async () => 1);
        const { done } = call(updateUserRole, { body: { userId: OTHER_ID, role: "owner" }, user: admin });
        await assertHttpError(done, 409);
    });

    it("demotes an admin when another admin remains and revokes their tokens", async () => {
        forbidDatabase();
        stub(User, "findById", async () => ({ _id: OTHER_ID, name: "Bola", email: "bola@example.com", role: "admin" }));
        const counts = record(User, "countDocuments", async () => 2);
        const updates = record(User, "updateOne", async () => ({}));
        const { res, done } = call(updateUserRole, { body: { userId: OTHER_ID, role: "owner" }, user: admin });
        await done;

        assert.deepEqual(counts, [[{ role: "admin" }]]);
        assert.deepEqual(updates, [[{ _id: OTHER_ID }, { $set: { role: "owner" }, $inc: { tokenVersion: 1 } }]]);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, {
            message: "User role updated successfully",
            user: { id: OTHER_ID, name: "Bola", email: "bola@example.com", role: "owner" },
        });
    });

    it("promotes a renter without counting admins", async () => {
        forbidDatabase();
        stub(User, "findById", async () => ({ _id: OTHER_ID, name: "Bola", email: "bola@example.com", role: "renter" }));
        const updates = record(User, "updateOne", async () => ({}));
        const { res, done } = call(updateUserRole, { body: { userId: OTHER_ID, role: "admin" }, user: admin });
        await done;
        assert.equal(res.body.user.role, "admin");
        assert.deepEqual(updates[0][1], { $set: { role: "admin" }, $inc: { tokenVersion: 1 } });
    });
});

/* ---------- createFirstAdmin ---------- */

describe("createFirstAdmin", () => {
    const token = env.setupAdminToken;
    const body = { name: "Root Admin", email: "root@example.com", password: GOOD_PASSWORD };
    const withToken = (value) => ({ "x-setup-token": value });

    it("is disabled (404) when SETUP_ADMIN_TOKEN is not configured", () => {
        // env is frozen at import time, so the disabled state needs a process without the variable.
        const script = `
            const { createFirstAdmin } = await import(${JSON.stringify(pathToFileURL(`${ROOT}Controllers/authController.js`).href)});
            try {
                await createFirstAdmin({ headers: { "x-setup-token": "anything" }, body: {} }, {});
                console.log(JSON.stringify({ resolved: true }));
            } catch (error) {
                console.log(JSON.stringify({ status: error.status, message: error.message }));
            }
        `;
        const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
            cwd: ROOT,
            env: { ...process.env, SETUP_ADMIN_TOKEN: "" },
            encoding: "utf8",
            timeout: 30_000,
        });
        assert.equal(child.status, 0, child.stderr);
        assert.deepEqual(JSON.parse(child.stdout.trim().split("\n").pop()), { status: 404, message: "Not found" });
    });

    describe("setup token guard (no database)", () => {
        const flipLast = (value) => value.slice(0, -1) + (value.endsWith("a") ? "b" : "a");
        for (const [label, headers] of [
            ["a missing header", {}],
            ["an empty header", withToken("")],
            ["a wrong token of the same length", withToken(flipLast(token))],
            ["a shorter token", withToken(token.slice(0, -1))],
            ["a longer token", withToken(`${token}x`)],
            ["a token with surrounding whitespace", withToken(` ${token} `)],
            ["a non-string header value", withToken(["x", token])],
        ]) {
            it(`answers 403 for ${label}`, async () => {
                forbidDatabase();
                const { done } = call(createFirstAdmin, { body, headers });
                await assertHttpError(done, 403, "Invalid setup token");
            });
        }
    });

    describe("rejects invalid input after the token check, before the database", () => {
        for (const [label, bad] of [
            ["no body", undefined],
            ["a missing name", { ...body, name: undefined }],
            ["a malformed email", { ...body, email: "nope" }],
            ["an object email", { ...body, email: { $gt: "" } }],
            ["a weak password", { ...body, password: "weak" }],
        ]) {
            it(label, async () => {
                forbidDatabase();
                const { done } = call(createFirstAdmin, { body: bad, headers: withToken(token) });
                await assertHttpError(done, 400);
            });
        }
    });

    it("answers 409 when an admin already exists", async () => {
        forbidDatabase();
        const lookups = record(User, "exists", async () => ({ _id: OTHER_ID }));
        const { done } = call(createFirstAdmin, { body, headers: withToken(token) });
        await assertHttpError(done, 409, "An admin already exists");
        assert.deepEqual(lookups, [[{ role: "admin" }]]);
    });

    it("claims the marker with an upsert that only inserts", async () => {
        forbidDatabase();
        stub(User, "exists", async () => null);
        const claims = record(Setting, "updateOne", async () => ({ upsertedCount: 1 }));
        stub(User, "create", async (doc) => ({ ...doc, _id: USER_ID }));
        fastHash();
        const { done } = call(createFirstAdmin, { body, headers: withToken(token) });
        await done;

        const [[filter, update, options]] = claims;
        assert.deepEqual(filter, { key: "adminBootstrap" });
        assert.deepEqual(Object.keys(update), ["$setOnInsert"]);
        assert.ok(update.$setOnInsert.value.claimedAt instanceof Date);
        assert.deepEqual(options, { upsert: true });
    });

    it("answers 409 when another request already holds the marker", async () => {
        forbidDatabase();
        stub(User, "exists", async () => null);
        stub(Setting, "updateOne", async () => ({ upsertedCount: 0 }));
        fastHash();
        const { done } = call(createFirstAdmin, { body, headers: withToken(token) });
        await assertHttpError(done, 409, "Admin setup already completed");
    });

    it("answers 409 when the marker insert loses a duplicate-key race", async () => {
        forbidDatabase();
        stub(User, "exists", async () => null);
        stub(Setting, "updateOne", async () => {
            throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
        });
        fastHash();
        const { done } = call(createFirstAdmin, { body, headers: withToken(token) });
        await assertHttpError(done, 409, "Admin setup already completed");
    });

    it("creates the admin with a cost-12 hash and answers 201", async () => {
        forbidDatabase();
        stub(User, "exists", async () => null);
        stub(Setting, "updateOne", async () => ({ upsertedCount: 1 }));
        const created = record(User, "create", async (doc) => ({ ...doc, _id: USER_ID }));
        const hashes = fastHash();
        const { res, done } = call(createFirstAdmin, { body: { ...body, role: "renter" }, headers: withToken(token) });
        await done;

        assert.deepEqual(hashes.map(([, cost]) => cost), [12]);
        const [[doc]] = created;
        assert.equal(doc.role, "admin");
        assert.equal(doc.email, "root@example.com");
        assert.ok(await bcrypt.compare(GOOD_PASSWORD, doc.password));
        assert.equal(res.statusCode, 201);
        assert.deepEqual(res.body, {
            message: "First admin created successfully",
            user: { id: USER_ID, name: "Root Admin", email: "root@example.com", role: "admin" },
        });
    });

    it("releases the marker and rethrows when creating the user fails", async () => {
        forbidDatabase();
        stub(User, "exists", async () => null);
        stub(Setting, "updateOne", async () => ({ upsertedCount: 1 }));
        const released = record(Setting, "deleteOne", async () => ({}));
        const failure = new Error("write failed");
        stub(User, "create", async () => {
            throw failure;
        });
        fastHash();
        const { done } = call(createFirstAdmin, { body, headers: withToken(token) });
        await assert.rejects(done, (error) => error === failure);
        assert.deepEqual(released, [[{ key: "adminBootstrap" }]]);
    });

    it("releases the marker and answers 409 when the email is already registered", async () => {
        forbidDatabase();
        stub(User, "exists", async () => null);
        stub(Setting, "updateOne", async () => ({ upsertedCount: 1 }));
        const released = record(Setting, "deleteOne", async () => ({}));
        stub(User, "create", async () => {
            throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
        });
        fastHash();
        const { done } = call(createFirstAdmin, { body, headers: withToken(token) });
        await assertHttpError(done, 409, "An account with this email already exists");
        assert.equal(released.length, 1);
    });
});

/* ---------- route wiring ---------- */

describe("authRoutes", () => {
    const routes = authRouter.stack
        .filter((layer) => layer.route)
        .map((layer) => ({
            method: Object.keys(layer.route.methods)[0].toUpperCase(),
            path: layer.route.path,
            handlers: layer.route.stack.map((item) => item.handle),
        }));
    const find = (method, path) => routes.find((r) => r.method === method && r.path === path);

    it("exposes exactly the expected endpoints", () => {
        assert.deepEqual(
            routes.map((r) => `${r.method} ${r.path}`).sort(),
            [
                "GET /admin-only",
                "GET /me",
                "GET /owner-only",
                "GET /renter-only",
                "POST /login",
                "POST /logout",
                "POST /register",
                "POST /setup-admin",
                "PUT /users/role",
            ]
        );
    });

    it("leaves register, login and setup-admin public with a single handler", () => {
        assert.equal(find("POST", "/register").handlers.length, 1);
        assert.equal(find("POST", "/login").handlers.length, 1);
        assert.equal(find("POST", "/setup-admin").handlers.length, 1);
        assert.equal(find("POST", "/register").handlers[0], registerUser);
        assert.equal(find("POST", "/login").handlers[0], loginUser);
        assert.equal(find("POST", "/setup-admin").handlers[0], createFirstAdmin);
    });

    it("protects logout and me", () => {
        assert.deepEqual(find("POST", "/logout").handlers, [protect, logoutUser]);
        assert.deepEqual(find("GET", "/me").handlers, [protect, getMe]);
    });

    it("restricts PUT /users/role to admins after authentication", () => {
        const [first, guard, last, ...rest] = find("PUT", "/users/role").handlers;
        assert.equal(first, protect);
        assert.equal(last, updateUserRole);
        assert.equal(rest.length, 0);
        for (const [role, allowed] of [["admin", true], ["owner", false], ["renter", false]]) {
            const res = fakeRes();
            const next = nextSpy();
            guard(fakeReq({ user: { role } }), res, next);
            assert.equal(next.calls.length === 1, allowed, role);
            if (!allowed) assert.equal(res.statusCode, 403);
        }
    });

    for (const [path, onlyRole] of [["/renter-only", "renter"], ["/owner-only", "owner"], ["/admin-only", "admin"]]) {
        it(`guards ${path} for the ${onlyRole} role only`, () => {
            const [first, guard, handler, ...rest] = find("GET", path).handlers;
            assert.equal(first, protect);
            assert.equal(rest.length, 0);
            for (const role of ["renter", "owner", "admin"]) {
                const res = fakeRes();
                const next = nextSpy();
                guard(fakeReq({ user: { role } }), res, next);
                assert.equal(next.calls.length === 1, role === onlyRole, role);
            }
            const res = fakeRes();
            handler(fakeReq(), res);
            assert.deepEqual(res.body, { message: `Welcome ${onlyRole}` });
        });
    }
});
