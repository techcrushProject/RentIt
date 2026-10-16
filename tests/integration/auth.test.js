import "../helpers/setEnv.js";
/**
 * End-to-end tests for authentication and authorisation: registration, login,
 * /me, logout (token revocation), admin role changes, the protect middleware's
 * reliance on the DATABASE role and tokenVersion, forged tokens, and the
 * one-time setup-admin bootstrap.
 *
 * Run alone with its own disposable database, for example:
 *   TEST_MONGO_URI=mongodb://127.0.0.1:27018/rentit_it_auth \
 *     node --test --test-concurrency=1 tests/integration/auth.test.js
 *
 * Everything is seeded through the public API except states the API cannot
 * produce (a legacy weak-password account, a legacy KYC row, a deleted user).
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import Setting from "../../Models/setting.js";
import User from "../../Models/user.js";
import { dropDatabase, startTestServer } from "../helpers/testServer.js";

const JWT_SECRET = process.env.JWT_SECRET;
const SETUP_TOKEN = process.env.SETUP_ADMIN_TOKEN;
const PASSWORD = "Passw0rdOK";
const ADMIN_MARKER_KEY = "adminBootstrap";

const INVALID_TOKEN = { message: "Not authorized, invalid token" };
const NO_TOKEN = { message: "Not authorized, no token" };
const ACCESS_DENIED = { message: "Access denied" };
const BAD_LOGIN = { message: "Invalid email or password" };
const ROLE_ENUM_ERROR = { message: "role must be one of: renter, owner" };

let server;
let seq = 0;

/** Unique per test run so no two tests ever share an account by accident. */
const uniqueEmail = (tag = "user") => `${tag}.${process.pid}.${++seq}@example.com`;

const api = (path, options) => server.request(path, options);

/* ---------- seeding through the public API ---------- */

const register = (body) => api("/api/auth/register", { method: "POST", json: body });

const login = (email, password = PASSWORD) => api("/api/auth/login", { method: "POST", json: { email, password } });

/** Register + log in. Returns { id, email, token, user }. */
async function newUser({ role = "renter", name = `Test ${role}`, email = uniqueEmail(role), ...extra } = {}) {
    const reg = await register({ name, email, password: PASSWORD, role, ...extra });
    assert.equal(reg.status, 201, `register failed: ${JSON.stringify(reg.body)}`);
    const res = await login(email);
    assert.equal(res.status, 200, `login failed: ${JSON.stringify(res.body)}`);
    return { id: res.body.user.id, email, token: res.body.token, user: res.body.user };
}

/** `options.token` overrides the X-Setup-Token header; passing `token: undefined` omits the header entirely. */
function setupAdmin(body = {}, options = {}) {
    const token = "token" in options ? options.token : SETUP_TOKEN;
    const headers = token === undefined ? {} : { "x-setup-token": token };
    return api("/api/auth/setup-admin", {
        method: "POST",
        headers,
        json: { name: "Root Admin", email: uniqueEmail("admin"), password: PASSWORD, ...body },
    });
}

/** The first admin, created through setup-admin and logged in. */
async function firstAdmin() {
    const email = uniqueEmail("root");
    const res = await setupAdmin({ email });
    assert.equal(res.status, 201, `setup-admin failed: ${JSON.stringify(res.body)}`);
    const log = await login(email);
    assert.equal(log.status, 200);
    return { id: log.body.user.id, email, token: log.body.token };
}

const changeRole = (token, json) => api("/api/auth/users/role", { method: "PUT", token, json });

/** A second admin: registered as a renter, promoted by `admin`, then logged in again (the promotion revokes old tokens). */
async function promotedAdmin(admin) {
    const u = await newUser();
    const res = await changeRole(admin.token, { userId: u.id, role: "admin" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const log = await login(u.email);
    assert.equal(log.status, 200);
    return { id: u.id, email: u.email, token: log.body.token };
}

/* ---------- reading back what was persisted ---------- */

const stored = (filter) => User.findOne(filter).select("+password +tokenVersion").lean();
const storedById = (id) => User.findById(id).select("+password +tokenVersion").lean();
const adminCount = () => User.countDocuments({ role: "admin" });

/* ---------- token forging ---------- */

const forge = (claims, { secret = JWT_SECRET, algorithm = "HS256", expiresIn = "1h" } = {}) =>
    jwt.sign(claims, secret, { algorithm, expiresIn });

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** An unsigned JWT ("alg": "none") with an empty signature segment. */
const unsignedToken = (payload) => `${b64url({ alg: "none", typ: "JWT" })}.${b64url(payload)}.`;

const nowSeconds = () => Math.floor(Date.now() / 1000);

/* ---------- response hygiene ---------- */

const SENSITIVE_KEYS = new Set(["password", "hashedPassword", "tokenVersion", "idNumber", "documentUrl", "selfieUrl", "kycDetails"]);

/** Walks a response body and fails on any sensitive key, bcrypt hash, plaintext password or the setup token. */
function assertNoSecrets(body, label = "response") {
    const walk = (value, path) => {
        if (Array.isArray(value)) {
            value.forEach((item, i) => walk(item, `${path}[${i}]`));
        } else if (value !== null && typeof value === "object") {
            for (const [key, item] of Object.entries(value)) {
                assert.ok(!SENSITIVE_KEYS.has(key), `${label}: ${path}.${key} must never be exposed`);
                walk(item, `${path}.${key}`);
            }
        } else if (typeof value === "string") {
            assert.doesNotMatch(value, /\$2[aby]\$\d{2}\$/, `${label}: bcrypt hash leaked at ${path}`);
            assert.ok(!value.includes(PASSWORD), `${label}: plaintext password leaked at ${path}`);
            assert.ok(!value.includes(SETUP_TOKEN), `${label}: setup token leaked at ${path}`);
        }
    };
    walk(body, "body");
}

/* ---------- lifecycle ---------- */

before(async () => {
    server = await startTestServer();
    await dropDatabase();
});

beforeEach(async () => {
    await dropDatabase();
});

after(async () => {
    if (!server) return;
    try {
        await dropDatabase();
    } finally {
        await server.close();
    }
});

/* ======================================================================= */

describe("POST /api/auth/register", () => {
    it("creates a renter by default, answers with a message only, and stores a cost-12 bcrypt hash", async () => {
        const email = uniqueEmail();
        const res = await register({ name: "Ada Obi", email, password: PASSWORD });

        assert.equal(res.status, 201);
        assert.deepEqual(res.body, { message: "User registered successfully" });

        const user = await stored({ email });
        assert.ok(user, "user must be persisted");
        assert.equal(user.name, "Ada Obi");
        assert.equal(user.role, "renter");
        assert.equal(user.kycStatus, "not_submitted");
        assert.equal(user.isVerified, false);
        assert.equal(user.tokenVersion, 0);
        assert.notEqual(user.password, PASSWORD);
        assert.match(user.password, /^\$2b\$12\$/);
        assert.equal(user.password.length, 60);
        assert.equal(await bcrypt.compare(PASSWORD, user.password), true);
    });

    it("registers an owner and stores trimmed optional profile fields", async () => {
        const email = uniqueEmail("owner");
        const res = await register({
            name: "  Bola Ade  ",
            firstName: "  Bola ",
            lastName: " Ade ",
            businessName: "  Ade Tools Ltd ",
            phone: " +234 801 234 5678 ",
            email,
            password: PASSWORD,
            role: "owner",
        });
        assert.equal(res.status, 201, JSON.stringify(res.body));

        const user = await stored({ email });
        assert.equal(user.role, "owner");
        assert.equal(user.name, "Bola Ade");
        assert.equal(user.firstName, "Bola");
        assert.equal(user.lastName, "Ade");
        assert.equal(user.businessName, "Ade Tools Ltd");
        assert.equal(user.phone, "+234 801 234 5678");
    });

    it("normalises the email (case and surrounding spaces) and lets the user log in with any casing", async () => {
        const local = `Mixed.Case.${process.pid}.${++seq}`;
        const res = await register({ name: "Case Test", email: `  ${local}@Example.COM `, password: PASSWORD });
        assert.equal(res.status, 201, JSON.stringify(res.body));

        const lower = `${local.toLowerCase()}@example.com`;
        const user = await stored({ email: lower });
        assert.ok(user, "email must be stored lower-cased and trimmed");

        const log = await login(`${local.toUpperCase()}@EXAMPLE.com`);
        assert.equal(log.status, 200);
        assert.equal(log.body.user.email, lower);
    });

    it("rejects a duplicate email regardless of case or whitespace, and never overwrites the original account", async () => {
        const email = uniqueEmail("dup");
        assert.equal((await register({ name: "Original", email, password: PASSWORD })).status, 201);

        for (const variant of [email, email.toUpperCase(), `  ${email}  `, email.replace(/^d/, "D")]) {
            const res = await register({ name: "Impostor", email: variant, password: "Different123", role: "owner" });
            assert.equal(res.status, 409, `variant ${JSON.stringify(variant)}`);
            assert.deepEqual(res.body, { message: "An account with this email already exists" });
        }

        assert.equal(await User.countDocuments({ email }), 1);
        const user = await stored({ email });
        assert.equal(user.name, "Original");
        assert.equal(user.role, "renter");
        assert.equal((await login(email)).status, 200);
        assert.equal((await login(email, "Different123")).status, 401);
    });

    it("concurrent sign-ups for the same email (different casing) create exactly one account", async () => {
        const email = uniqueEmail("race");
        const variants = [email, email.toUpperCase(), ` ${email}`, email, email.toUpperCase()];
        const results = await Promise.all(
            variants.map((e, i) => register({ name: `Racer ${i}`, email: e, password: PASSWORD }))
        );

        const statuses = results.map((r) => r.status).sort();
        assert.deepEqual(statuses, [201, 409, 409, 409, 409]);
        for (const r of results.filter((x) => x.status === 409)) {
            assert.deepEqual(r.body, { message: "An account with this email already exists" });
        }
        assert.equal(await User.countDocuments({ email }), 1);
    });

    it("only renter and owner may self-register: admin and anything else is refused and nothing is stored", async () => {
        const badRoles = ["admin", "ADMIN", "Admin", " admin", "superadmin", "", ["admin"], { $ne: "renter" }, 1, true];
        for (const role of badRoles) {
            const email = uniqueEmail("role");
            const res = await register({ name: "Role Test", email, password: PASSWORD, role });
            assert.equal(res.status, 400, `role ${JSON.stringify(role)}`);
            assert.deepEqual(res.body, ROLE_ENUM_ERROR);
            assert.equal(await User.exists({ email }), null, `role ${JSON.stringify(role)} must not create a user`);
        }
        assert.equal(await adminCount(), 0);
        assert.equal(await User.countDocuments({}), 0);
    });

    it("ignores mass-assigned privileged fields", async () => {
        const email = uniqueEmail("mass");
        const forcedId = new mongoose.Types.ObjectId().toString();
        const res = await register({
            name: "Mass Assign",
            email,
            password: PASSWORD,
            _id: forcedId,
            isVerified: true,
            kycStatus: "verified",
            tokenVersion: 42,
            kycRejectionReason: "x",
            createdAt: "2000-01-01T00:00:00.000Z",
            lastLoginAt: "2000-01-01T00:00:00.000Z",
        });
        assert.equal(res.status, 201, JSON.stringify(res.body));

        const user = await stored({ email });
        assert.notEqual(String(user._id), forcedId);
        assert.equal(user.role, "renter");
        assert.equal(user.isVerified, false);
        assert.equal(user.kycStatus, "not_submitted");
        assert.equal(user.tokenVersion, 0);
        assert.equal(user.kycRejectionReason, "");
        assert.equal(user.lastLoginAt, undefined);
        assert.ok(user.createdAt.getFullYear() > 2000);
    });

    it("enforces the password policy on the plaintext and stores nothing on failure", async () => {
        const cases = [
            [undefined, "password is required"],
            ["", "password is required"],
            [{ $gt: "" }, "password is required"],
            [["Passw0rdOK"], "password is required"],
            [12345678, "password is required"],
            ["Ab1", "Password must be at least 8 characters"],
            ["abc1234", "Password must be at least 8 characters"],
            ["abcdefgh", "Password must contain at least one letter and one number"],
            ["12345678", "Password must contain at least one letter and one number"],
            ["        ", "Password must contain at least one letter and one number"],
            [`a1${"x".repeat(71)}`, "Password must be at most 72 bytes"], // 73 bytes
            [`a1${"é".repeat(36)}`, "Password must be at most 72 bytes"], // 38 characters but 74 bytes
        ];
        for (const [password, message] of cases) {
            const email = uniqueEmail("pw");
            const res = await register({ name: "Policy Test", email, password });
            assert.equal(res.status, 400, `password ${JSON.stringify(password)}`);
            assert.deepEqual(res.body, { message }, `password ${JSON.stringify(password)}`);
            assert.equal(await User.exists({ email }), null);
        }
    });

    it("accepts passwords exactly at the 8-character and 72-byte limits", async () => {
        const shortEmail = uniqueEmail("pw8");
        assert.equal((await register({ name: "Eight", email: shortEmail, password: "abcdefg1" })).status, 201);
        assert.equal((await login(shortEmail, "abcdefg1")).status, 200);

        const long = `a1${"é".repeat(35)}`; // 2 + 70 = 72 bytes
        assert.equal(Buffer.byteLength(long), 72);
        const longEmail = uniqueEmail("pw72");
        assert.equal((await register({ name: "Seventy Two", email: longEmail, password: long })).status, 201);
        assert.equal((await login(longEmail, long)).status, 200);
    });

    it("hashes a password that looks like a bcrypt hash instead of storing it verbatim", async () => {
        const email = uniqueEmail("hashlike");
        const hashLike = await bcrypt.hash("something-else-1", 4);
        assert.equal(hashLike.length, 60);

        assert.equal((await register({ name: "Hash Like", email, password: hashLike })).status, 201);
        const user = await stored({ email });
        assert.notEqual(user.password, hashLike);
        assert.equal(await bcrypt.compare(hashLike, user.password), true);
        assert.equal((await login(email, "something-else-1")).status, 401);
        assert.equal((await login(email, hashLike)).status, 200);
    });

    it("validates name, email and phone, including injection-shaped and oversize values", async () => {
        const base = () => ({ name: "Valid Name", email: uniqueEmail("val"), password: PASSWORD });
        const cases = [
            [{ name: undefined }, "name is required"],
            [{ name: "   " }, "name is required"],
            [{ name: "A" }, "name must be at least 2 characters"],
            [{ name: "x".repeat(101) }, "name must be at most 100 characters"],
            [{ name: "x".repeat(5000) }, "name must be at most 100 characters"],
            [{ name: { $ne: null } }, "name must be text"],
            [{ email: undefined }, "email is required"],
            [{ email: "not-an-email" }, "Enter a valid email address"],
            [{ email: "a@b" }, "Enter a valid email address"],
            [{ email: "a b@example.com" }, "Enter a valid email address"],
            [{ email: { $gt: "" } }, "email must be text"],
            [{ email: ["a@example.com"] }, "email must be text"],
            [{ email: `${"a".repeat(250)}@x.co` }, "email must be at most 254 characters"],
            [{ firstName: "x".repeat(51) }, "firstName must be at most 50 characters"],
            [{ businessName: { $where: "1" } }, "businessName must be text"],
            [{ phone: "abc" }, "Enter a valid phone number"],
            [{ phone: "123" }, "Enter a valid phone number"],
            [{ phone: "1".repeat(31) }, "phone must be at most 30 characters"],
        ];
        for (const [override, message] of cases) {
            const res = await register({ ...base(), ...override });
            assert.equal(res.status, 400, JSON.stringify(override).slice(0, 80));
            assert.deepEqual(res.body, { message }, JSON.stringify(override).slice(0, 80));
        }
        assert.equal(await User.countDocuments({}), 0);
    });

    it("answers malformed JSON and non-object bodies with 400 and creates nothing", async () => {
        const raw = (body, contentType = "application/json") =>
            api("/api/auth/register", { method: "POST", body, headers: { "content-type": contentType } });

        for (const body of ['{"name": "x",', '"just a string"', "null", "42"]) {
            const res = await raw(body);
            assert.equal(res.status, 400, body);
            assert.deepEqual(res.body, { message: "Invalid JSON body" }, body);
        }
        for (const [body, type] of [["[]", "application/json"], ["name=Ada&email=a@b.co", "application/x-www-form-urlencoded"], [JSON.stringify({ name: "Ada Obi", email: uniqueEmail(), password: PASSWORD }), "text/plain"]]) {
            const res = await raw(body, type);
            assert.equal(res.status, 400, `${type}: ${body}`);
            assert.deepEqual(res.body, { message: "name is required" });
        }
        assert.equal(await User.countDocuments({}), 0);
    });

    it("refuses a body over the 100kb limit with 413 before touching the database", async () => {
        const email = uniqueEmail("big");
        const res = await register({ name: "x".repeat(150 * 1024), email, password: PASSWORD });
        assert.equal(res.status, 413);
        assert.deepEqual(res.body, { message: "Request body too large" });
        assert.equal(await User.exists({ email }), null);
    });
});

/* ======================================================================= */

describe("POST /api/auth/login", () => {
    it("returns a HS256 token and the public user, never the password or tokenVersion", async () => {
        const email = uniqueEmail("login");
        await register({
            name: "Chi Eze",
            firstName: "Chi",
            lastName: "Eze",
            businessName: "Eze Rentals",
            phone: "+2348012345678",
            email,
            password: PASSWORD,
            role: "owner",
        });
        const startedAt = Date.now();
        const res = await login(email);

        assert.equal(res.status, 200);
        assert.deepEqual(Object.keys(res.body).sort(), ["message", "token", "user"]);
        assert.equal(res.body.message, "Login successful");
        assertNoSecrets(res.body, "login");

        const dbUser = await stored({ email });
        assert.deepEqual(res.body.user, {
            id: String(dbUser._id),
            name: "Chi Eze",
            firstName: "Chi",
            lastName: "Eze",
            businessName: "Eze Rentals",
            email,
            phone: "+2348012345678",
            role: "owner",
        });

        const { header, payload } = jwt.decode(res.body.token, { complete: true });
        assert.equal(header.alg, "HS256");
        assert.deepEqual(Object.keys(payload).sort(), ["exp", "iat", "id", "role", "tv"]);
        assert.equal(payload.id, String(dbUser._id));
        assert.equal(payload.role, "owner");
        assert.equal(payload.tv, 0);
        assert.ok(payload.exp > payload.iat);
        assert.doesNotThrow(() => jwt.verify(res.body.token, JWT_SECRET, { algorithms: ["HS256"] }));

        assert.ok(dbUser.lastLoginAt instanceof Date, "lastLoginAt must be recorded");
        assert.ok(dbUser.lastLoginAt.getTime() >= startedAt - 1000);
    });

    it("gives the same generic 401 for an unknown email and a wrong password, and records no login", async () => {
        const u = await newUser();
        await User.updateOne({ _id: u.id }, { $unset: { lastLoginAt: 1 } });

        const unknown = await login(uniqueEmail("nobody"));
        const wrong = await login(u.email, "WrongPassw0rd");
        const wrongCase = await login(u.email, PASSWORD.toUpperCase());

        for (const res of [unknown, wrong, wrongCase]) {
            assert.equal(res.status, 401);
            assert.deepEqual(res.body, BAD_LOGIN);
        }
        assert.deepEqual(unknown.body, wrong.body);
        assert.equal((await stored({ email: u.email })).lastLoginAt, undefined);
    });

    it("rejects injection-shaped and missing credentials with 400 and never issues a token", async () => {
        const u = await newUser();
        const cases = [
            [{ email: { $ne: null }, password: PASSWORD }, "email must be text"],
            [{ email: { $gt: "" }, password: PASSWORD }, "email must be text"],
            [{ email: { $regex: ".*" }, password: PASSWORD }, "email must be text"],
            [{ email: [u.email], password: PASSWORD }, "email must be text"],
            [{ email: u.email, password: { $ne: null } }, "password is required"],
            [{ email: u.email, password: [PASSWORD] }, "password is required"],
            [{ email: u.email, password: "" }, "password is required"],
            [{ email: u.email }, "password is required"],
            [{ password: PASSWORD }, "email is required"],
            [{ email: `${u.email}' || '1'=='1`, password: PASSWORD }, "Enter a valid email address"],
        ];
        for (const [body, message] of cases) {
            const res = await api("/api/auth/login", { method: "POST", json: body });
            assert.equal(res.status, 400, JSON.stringify(body));
            assert.deepEqual(res.body, { message }, JSON.stringify(body));
        }
    });

    it("rejects a password over 72 bytes instead of letting bcrypt silently truncate it", async () => {
        const long = `a1${"x".repeat(70)}`; // exactly 72 bytes
        const email = uniqueEmail("trunc");
        assert.equal((await register({ name: "Trunc", email, password: long })).status, 201);

        assert.equal((await login(email, long)).status, 200);
        const res = await login(email, `${long}EXTRA`);
        assert.equal(res.status, 400);
        assert.deepEqual(res.body, { message: "Password must be at most 72 bytes" });
    });

    it("still lets a legacy account whose password predates the policy log in (seeded via the model)", async () => {
        // The API refuses weak passwords, so this pre-policy account can only be created directly.
        const email = uniqueEmail("legacy");
        await User.create({ name: "Legacy User", email, password: await bcrypt.hash("weak", 4), role: "renter" });

        const res = await login(email, "weak");
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.user.email, email);
        assertNoSecrets(res.body, "legacy login");
    });

    it("refuses an oversize login body with 413", async () => {
        const res = await api("/api/auth/login", {
            method: "POST",
            json: { email: uniqueEmail(), password: "x".repeat(200 * 1024) },
        });
        assert.equal(res.status, 413);
        assert.deepEqual(res.body, { message: "Request body too large" });
    });
});

/* ======================================================================= */

describe("GET /api/auth/me", () => {
    it("returns the caller's profile with KYC status and no secrets", async () => {
        const u = await newUser({
            role: "owner",
            name: "Dayo Ola",
            firstName: "Dayo",
            lastName: "Ola",
            businessName: "Ola Hire",
            phone: "08012345678",
        });
        const res = await api("/api/auth/me", { token: u.token });

        assert.equal(res.status, 200);
        assert.deepEqual(res.body, {
            user: {
                id: u.id,
                name: "Dayo Ola",
                firstName: "Dayo",
                lastName: "Ola",
                businessName: "Ola Hire",
                email: u.email,
                phone: "08012345678",
                role: "owner",
                kycStatus: "not_submitted",
                isVerified: false,
            },
        });
        assertNoSecrets(res.body, "/me");
    });

    it("never exposes KYC documents or ID numbers, even for a legacy KYC row (seeded via the model)", async () => {
        const u = await newUser();
        const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64")}`;
        await User.updateOne(
            { _id: u.id },
            {
                $set: {
                    kycStatus: "under_review",
                    address: "1 Legacy Road",
                    kycDetails: { idType: "passport", idNumber: "A12345678", documentUrl: png, selfieUrl: png, submittedAt: new Date() },
                },
            }
        );

        const res = await api("/api/auth/me", { token: u.token });
        assert.equal(res.status, 200);
        assert.equal(res.body.user.kycStatus, "under_review");
        assert.equal(res.body.user.isVerified, false);
        assertNoSecrets(res.body, "/me with KYC");
        const text = JSON.stringify(res.body);
        assert.ok(!text.includes("A12345678"), "ID number must not leak");
        assert.ok(!text.includes("data:image"), "KYC image must not leak");
    });

    it("identifies the caller only by the token: two users each see themselves", async () => {
        const a = await newUser();
        const b = await newUser({ role: "owner" });
        const [ra, rb] = await Promise.all([api("/api/auth/me", { token: a.token }), api("/api/auth/me", { token: b.token })]);
        assert.equal(ra.body.user.id, a.id);
        assert.equal(ra.body.user.email, a.email);
        assert.equal(rb.body.user.id, b.id);
        assert.equal(rb.body.user.role, "owner");

        // Ids or emails in the query string must not change who is answered for.
        const spoof = await api(`/api/auth/me?id=${b.id}&email=${encodeURIComponent(b.email)}`, { token: a.token });
        assert.equal(spoof.body.user.id, a.id);
    });

    it("rejects missing or malformed Authorization headers with 401", async () => {
        const u = await newUser();

        const noHeader = await api("/api/auth/me");
        assert.equal(noHeader.status, 401);
        assert.deepEqual(noHeader.body, NO_TOKEN);

        for (const authorization of ["Token abc", "Bearer", "Bearer ", `Bearer  ${u.token}`, `Basic ${u.token}`, u.token, `Bearer ${u.token} extra`]) {
            const res = await api("/api/auth/me", { headers: { authorization } });
            assert.equal(res.status, 401, authorization.slice(0, 30));
            assert.deepEqual(res.body, NO_TOKEN, authorization.slice(0, 30));
        }

        for (const authorization of ["Bearer abc.def.ghi", "Bearer not-a-jwt", `Bearer ${u.token}x`]) {
            const res = await api("/api/auth/me", { headers: { authorization } });
            assert.equal(res.status, 401, authorization.slice(0, 30));
            assert.deepEqual(res.body, INVALID_TOKEN);
        }

        // A token in the query string is not a credential.
        assert.equal((await api(`/api/auth/me?token=${u.token}`)).status, 401);

        // The scheme is case-insensitive.
        assert.equal((await api("/api/auth/me", { headers: { authorization: `bearer ${u.token}` } })).status, 200);
        assert.equal((await api("/api/auth/me", { headers: { authorization: `BEARER ${u.token}` } })).status, 200);
    });
});

/* ======================================================================= */

describe("POST /api/auth/logout", () => {
    it("revokes every token the user holds, on every device", async () => {
        const u = await newUser();
        const second = (await login(u.email)).body.token;
        // An older token issued minutes ago, still within its lifetime.
        const older = jwt.sign({ id: u.id, role: "renter", tv: 0, iat: nowSeconds() - 600 }, JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });

        for (const token of [u.token, second, older]) {
            assert.equal((await api("/api/auth/me", { token })).status, 200);
        }

        const out = await api("/api/auth/logout", { method: "POST", token: second });
        assert.equal(out.status, 200);
        assert.deepEqual(out.body, { message: "Logged out" });
        assert.equal((await stored({ email: u.email })).tokenVersion, 1);

        for (const token of [u.token, second, older]) {
            const res = await api("/api/auth/me", { token });
            assert.equal(res.status, 401);
            assert.deepEqual(res.body, INVALID_TOKEN);
        }

        // A revoked token cannot log out again (and does not bump the version further).
        assert.equal((await api("/api/auth/logout", { method: "POST", token: u.token })).status, 401);
        assert.equal((await stored({ email: u.email })).tokenVersion, 1);

        // A fresh login works and carries the new version.
        const again = await login(u.email);
        assert.equal(again.status, 200);
        assert.equal(jwt.decode(again.body.token).tv, 1);
        assert.equal((await api("/api/auth/me", { token: again.body.token })).status, 200);
    });

    it("one user's logout leaves other users' sessions untouched", async () => {
        const a = await newUser();
        const b = await newUser({ role: "owner" });

        assert.equal((await api("/api/auth/logout", { method: "POST", token: a.token })).status, 200);

        assert.equal((await api("/api/auth/me", { token: a.token })).status, 401);
        assert.equal((await api("/api/auth/me", { token: b.token })).status, 200);
        assert.equal((await stored({ email: b.email })).tokenVersion, 0);
    });

    it("requires a valid token and cannot be used to revoke someone else's sessions", async () => {
        const victim = await newUser();

        const noToken = await api("/api/auth/logout", { method: "POST" });
        assert.equal(noToken.status, 401);
        assert.deepEqual(noToken.body, NO_TOKEN);

        const foreign = forge({ id: victim.id, role: "renter", tv: 0 }, { secret: "another-secret-another-secret-0123456789" });
        assert.equal((await api("/api/auth/logout", { method: "POST", token: foreign })).status, 401);

        // A body naming another user is ignored: only the caller is logged out.
        const attacker = await newUser();
        const res = await api("/api/auth/logout", { method: "POST", token: attacker.token, json: { id: victim.id, userId: victim.id } });
        assert.equal(res.status, 200);

        assert.equal((await stored({ email: victim.email })).tokenVersion, 0);
        assert.equal((await api("/api/auth/me", { token: victim.token })).status, 200);
        assert.equal((await stored({ email: attacker.email })).tokenVersion, 1);
    });
});

/* ======================================================================= */

describe("PUT /api/auth/users/role", () => {
    it("lets an admin change a user's role, revoking that user's existing tokens", async () => {
        const admin = await firstAdmin();
        const renter = await newUser({ name: "Renter Ren" });
        assert.equal((await api("/api/auth/renter-only", { token: renter.token })).status, 200);

        const res = await changeRole(admin.token, { userId: renter.id, role: "owner" });
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, {
            message: "User role updated successfully",
            user: { id: renter.id, name: "Renter Ren", email: renter.email, role: "owner" },
        });
        assertNoSecrets(res.body, "role change");

        const dbUser = await storedById(renter.id);
        assert.equal(dbUser.role, "owner");
        assert.equal(dbUser.tokenVersion, 1);

        // The old token is dead, whatever route it is used on.
        for (const path of ["/api/auth/me", "/api/auth/renter-only", "/api/auth/owner-only"]) {
            const r = await api(path, { token: renter.token });
            assert.equal(r.status, 401, path);
            assert.deepEqual(r.body, INVALID_TOKEN);
        }

        // A fresh login carries the new role.
        const log = await login(renter.email);
        assert.equal(log.body.user.role, "owner");
        assert.equal((await api("/api/auth/owner-only", { token: log.body.token })).status, 200);
        assert.equal((await api("/api/auth/renter-only", { token: log.body.token })).status, 403);

        // The acting admin is unaffected.
        assert.equal((await api("/api/auth/admin-only", { token: admin.token })).status, 200);
        assert.equal((await storedById(admin.id)).tokenVersion, 0);
    });

    it("promoting a user to admin takes effect only after a fresh login", async () => {
        const admin = await firstAdmin();
        const u = await newUser({ role: "owner" });

        assert.equal((await changeRole(admin.token, { userId: u.id, role: "admin" })).status, 200);
        assert.equal(await adminCount(), 2);

        assert.equal((await api("/api/auth/admin-only", { token: u.token })).status, 401);
        const fresh = (await login(u.email)).body.token;
        assert.equal((await api("/api/auth/admin-only", { token: fresh })).status, 200);
        assert.equal((await api("/api/admin/kyc", { token: fresh })).status, 200);
    });

    it("an admin cannot change their own role", async () => {
        const admin = await firstAdmin();
        for (const role of ["renter", "owner", "admin"]) {
            const res = await changeRole(admin.token, { userId: admin.id, role });
            assert.equal(res.status, 400, role);
            assert.deepEqual(res.body, { message: "You cannot change your own role" });
        }
        const dbAdmin = await storedById(admin.id);
        assert.equal(dbAdmin.role, "admin");
        assert.equal(dbAdmin.tokenVersion, 0);
        assert.equal((await api("/api/auth/admin-only", { token: admin.token })).status, 200);
    });

    it("demoting another admin revokes their tokens, and the remaining admin cannot demote themselves", async () => {
        const a = await firstAdmin();
        const b = await promotedAdmin(a);
        assert.equal(await adminCount(), 2);

        const res = await changeRole(a.token, { userId: b.id, role: "renter" });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(await adminCount(), 1);

        // B's admin token is now useless, so B cannot strike back at A.
        const strike = await changeRole(b.token, { userId: a.id, role: "renter" });
        assert.equal(strike.status, 401);
        assert.equal((await api("/api/auth/admin-only", { token: b.token })).status, 401);

        const bAgain = (await login(b.email)).body.token;
        assert.equal((await api("/api/auth/admin-only", { token: bAgain })).status, 403);
        assert.equal((await changeRole(bAgain, { userId: a.id, role: "renter" })).status, 403);

        // The last admin cannot remove themselves either.
        assert.equal((await changeRole(a.token, { userId: a.id, role: "renter" })).status, 400);
        assert.equal(await adminCount(), 1);
        assert.equal((await storedById(a.id)).role, "admin");
    });

    it(
        "two admins demoting each other at the same moment must leave at least one admin",
        { todo: "BUG: last-admin guard in updateUserRole is a non-atomic count-then-update; concurrent mutual demotion leaves zero admins" },
        async () => {
            // The guard is only reachable through a race: sequentially the demoted admin's token is revoked first.
            const rounds = 4;
            const outcomes = [];
            for (let round = 0; round < rounds; round++) {
                if (round > 0) await dropDatabase();
                const a = await firstAdmin();
                const b = await promotedAdmin(a);

                const [ab, ba] = await Promise.all([
                    changeRole(a.token, { userId: b.id, role: "renter" }),
                    changeRole(b.token, { userId: a.id, role: "renter" }),
                ]);
                outcomes.push({ round, statuses: [ab.status, ba.status], admins: await adminCount() });
            }
            for (const o of outcomes) {
                assert.ok(o.admins >= 1, `round ${o.round}: both demotions succeeded (${o.statuses}) and no admin is left`);
                // Exactly one demotion wins; the other is refused by the last-admin guard (409) or a revoked token (401).
                assert.equal(o.statuses.filter((s) => s === 200).length, 1, `round ${o.round}: ${o.statuses}`);
                assert.ok(o.statuses.every((s) => [200, 401, 409].includes(s)), `round ${o.round}: ${o.statuses}`);
            }
        }
    );

    it("returns 404 for a well-formed id that does not exist, including a deleted user", async () => {
        const admin = await firstAdmin();

        const missing = await changeRole(admin.token, { userId: new mongoose.Types.ObjectId().toString(), role: "owner" });
        assert.equal(missing.status, 404);
        assert.deepEqual(missing.body, { message: "User not found" });

        const gone = await newUser();
        await User.deleteOne({ _id: gone.id });
        const res = await changeRole(admin.token, { userId: gone.id, role: "owner" });
        assert.equal(res.status, 404);
        assert.equal(await User.exists({ _id: gone.id }), null, "a role change must not resurrect a deleted user");
    });

    it("rejects malformed ids and roles, including injection-shaped input, and changes nothing", async () => {
        const admin = await firstAdmin();
        const target = await newUser();

        const badIds = [undefined, "", "123", "zzzzzzzzzzzzzzzzzzzzzzzz", `${target.id} `, { $ne: null }, { $gt: "" }, [target.id], 42];
        for (const userId of badIds) {
            const res = await changeRole(admin.token, { userId, role: "admin" });
            assert.equal(res.status, 400, JSON.stringify(userId));
            assert.deepEqual(res.body, { message: "Invalid userId" });
        }

        const badRoles = [undefined, "", "superadmin", "ADMIN", " admin", { $ne: "renter" }, ["admin"], true];
        for (const role of badRoles) {
            const res = await changeRole(admin.token, { userId: target.id, role });
            assert.equal(res.status, 400, JSON.stringify(role));
            assert.deepEqual(res.body, { message: "role must be one of: renter, owner, admin" });
        }

        const dbTarget = await storedById(target.id);
        assert.equal(dbTarget.role, "renter");
        assert.equal(dbTarget.tokenVersion, 0);
        assert.equal(await adminCount(), 1);
        assert.equal((await api("/api/auth/me", { token: target.token })).status, 200);
    });

    it("is forbidden to non-admins, who cannot promote themselves or anyone else", async () => {
        await firstAdmin();
        const renter = await newUser();
        const owner = await newUser({ role: "owner" });

        const attempts = [
            [renter.token, { userId: renter.id, role: "admin" }],
            [renter.token, { userId: owner.id, role: "renter" }],
            [owner.token, { userId: owner.id, role: "admin" }],
            [owner.token, { userId: renter.id, role: "admin" }],
        ];
        for (const [token, json] of attempts) {
            const res = await changeRole(token, json);
            assert.equal(res.status, 403);
            assert.deepEqual(res.body, ACCESS_DENIED);
        }

        const anonymous = await changeRole(undefined, { userId: renter.id, role: "admin" });
        assert.equal(anonymous.status, 401);
        assert.deepEqual(anonymous.body, NO_TOKEN);

        assert.equal((await storedById(renter.id)).role, "renter");
        assert.equal((await storedById(owner.id)).role, "owner");
        assert.equal((await storedById(renter.id)).tokenVersion, 0);
        assert.equal((await storedById(owner.id)).tokenVersion, 0);
        assert.equal(await adminCount(), 1);
    });
});

/* ======================================================================= */

describe("protect trusts the database, not the token's claims", () => {
    it("refuses a renter's token forged to claim admin on every admin route", async () => {
        await firstAdmin();
        const renter = await newUser();
        const victim = await newUser({ role: "owner" });
        const forged = forge({ id: renter.id, role: "admin", tv: 0 });

        // The token is otherwise valid: it authenticates, but as the renter the database says this is.
        const me = await api("/api/auth/me", { token: forged });
        assert.equal(me.status, 200);
        assert.equal(me.body.user.role, "renter");

        for (const path of ["/api/auth/admin-only", "/api/admin/kyc", "/api/admin/equipment"]) {
            const res = await api(path, { token: forged });
            assert.equal(res.status, 403, path);
            assert.deepEqual(res.body, ACCESS_DENIED);
        }
        const promote = await changeRole(forged, { userId: renter.id, role: "admin" });
        assert.equal(promote.status, 403);
        const demote = await changeRole(forged, { userId: victim.id, role: "renter" });
        assert.equal(demote.status, 403);
        const verify = await api(`/api/admin/verify-user/${victim.id}`, { method: "PUT", token: forged, json: { status: "verified" } });
        assert.equal(verify.status, 403);

        assert.equal((await storedById(renter.id)).role, "renter");
        assert.equal((await storedById(victim.id)).role, "owner");
        assert.equal(await adminCount(), 1);
    });

    it("treats the role claim as informational: an admin whose token says renter is still an admin", async () => {
        const admin = await firstAdmin();
        const understated = forge({ id: admin.id, role: "renter", tv: 0 });
        assert.equal((await api("/api/auth/admin-only", { token: understated })).status, 200);
        assert.equal((await api("/api/auth/renter-only", { token: understated })).status, 403);
    });

    it("a demoted admin loses admin access even with a token forged at the current tokenVersion", async () => {
        const a = await firstAdmin();
        const b = await promotedAdmin(a);
        assert.equal((await changeRole(a.token, { userId: b.id, role: "owner" })).status, 200);

        // Registered at 0, promoted to 1, demoted to 2: forge exactly the version the database now holds.
        const { tokenVersion } = await storedById(b.id);
        assert.equal(tokenVersion, 2);
        const forged = forge({ id: b.id, role: "admin", tv: tokenVersion });
        assert.equal((await api("/api/auth/me", { token: forged })).status, 200);
        assert.equal((await api("/api/auth/admin-only", { token: forged })).status, 403);
        assert.equal((await api("/api/auth/owner-only", { token: forged })).status, 200);
    });

    it("refuses tokens whose tokenVersion is stale, ahead, missing or of the wrong type", async () => {
        const u = await newUser();
        for (const tv of [1, -1, "0", null, false, [0]]) {
            const res = await api("/api/auth/me", { token: forge({ id: u.id, role: "renter", tv }) });
            assert.equal(res.status, 401, `tv ${JSON.stringify(tv)}`);
            assert.deepEqual(res.body, INVALID_TOKEN);
        }
        const res = await api("/api/auth/me", { token: forge({ id: u.id, role: "renter" }) });
        assert.equal(res.status, 401, "tv missing");
    });

    it("refuses validly signed tokens with a malformed or unknown id with 401, never 500", async () => {
        const u = await newUser();
        const ids = [undefined, null, 123, "not-an-object-id", { $ne: null }, [u.id], `${u.id}0`, new mongoose.Types.ObjectId().toString()];
        for (const id of ids) {
            const res = await api("/api/auth/me", { token: forge({ id, role: "admin", tv: 0 }) });
            assert.equal(res.status, 401, `id ${JSON.stringify(id)}`);
            assert.deepEqual(res.body, INVALID_TOKEN);
        }
    });

    it("refuses an expired token", async () => {
        const u = await newUser();
        const expired = jwt.sign({ id: u.id, role: "renter", tv: 0, iat: nowSeconds() - 120, exp: nowSeconds() - 60 }, JWT_SECRET, { algorithm: "HS256" });
        const res = await api("/api/auth/me", { token: expired });
        assert.equal(res.status, 401);
        assert.deepEqual(res.body, INVALID_TOKEN);
    });
});

/* ======================================================================= */

describe("deleted users and forged tokens", () => {
    it("refuses a deleted user's token everywhere (user removed via the model)", async () => {
        const admin = await firstAdmin();
        const renter = await newUser();
        const exAdmin = await promotedAdmin(admin);

        // There is no delete-account endpoint, so the deletion happens directly in the database.
        await User.deleteMany({ _id: { $in: [renter.id, exAdmin.id] } });

        for (const [token, path, method] of [
            [renter.token, "/api/auth/me", "GET"],
            [renter.token, "/api/auth/logout", "POST"],
            [renter.token, "/api/kyc/me", "GET"],
            [exAdmin.token, "/api/auth/admin-only", "GET"],
            [exAdmin.token, "/api/admin/kyc", "GET"],
        ]) {
            const res = await api(path, { method, token });
            assert.equal(res.status, 401, `${method} ${path}`);
            assert.deepEqual(res.body, INVALID_TOKEN);
        }
        const res = await changeRole(exAdmin.token, { userId: admin.id, role: "renter" });
        assert.equal(res.status, 401);
        assert.equal((await storedById(admin.id)).role, "admin");
    });

    it("refuses a token signed with another secret, even when it names a real admin", async () => {
        const admin = await firstAdmin();
        const token = forge({ id: admin.id, role: "admin", tv: 0 }, { secret: "not-the-server-secret-not-the-server-secret" });
        for (const path of ["/api/auth/me", "/api/auth/admin-only", "/api/admin/kyc"]) {
            const res = await api(path, { token });
            assert.equal(res.status, 401, path);
            assert.deepEqual(res.body, INVALID_TOKEN);
        }
    });

    it("refuses an unsigned alg:none token", async () => {
        const admin = await firstAdmin();
        const renter = await newUser();
        const iat = nowSeconds();
        for (const payload of [
            { id: admin.id, role: "admin", tv: 0, iat, exp: iat + 3600 },
            { id: renter.id, role: "admin", tv: 0, iat, exp: iat + 3600 },
        ]) {
            const token = unsignedToken(payload);
            for (const path of ["/api/auth/me", "/api/auth/admin-only"]) {
                const res = await api(path, { token });
                assert.equal(res.status, 401, path);
                assert.deepEqual(res.body, INVALID_TOKEN);
            }
            const res = await changeRole(token, { userId: renter.id, role: "admin" });
            assert.equal(res.status, 401);
        }
        // Same with a non-empty junk signature segment.
        const junk = `${unsignedToken({ id: admin.id, role: "admin", tv: 0, iat, exp: iat + 3600 })}c2ln`;
        assert.equal((await api("/api/auth/admin-only", { token: junk })).status, 401);
        assert.equal((await storedById(renter.id)).role, "renter");
    });

    it("refuses tokens signed with another HMAC algorithm, even with the right secret", async () => {
        const admin = await firstAdmin();
        for (const algorithm of ["HS384", "HS512"]) {
            const token = forge({ id: admin.id, role: "admin", tv: 0 }, { algorithm });
            const res = await api("/api/auth/admin-only", { token });
            assert.equal(res.status, 401, algorithm);
            assert.deepEqual(res.body, INVALID_TOKEN);
        }
    });

    it("refuses a real token whose payload was edited after signing", async () => {
        const admin = await firstAdmin();
        const renter = await newUser();
        const [header, payload, signature] = renter.token.split(".");
        const claims = JSON.parse(Buffer.from(payload, "base64url").toString());

        const asAdmin = `${header}.${b64url({ ...claims, role: "admin" })}.${signature}`;
        assert.equal((await api("/api/auth/admin-only", { token: asAdmin })).status, 401);

        const asOtherUser = `${header}.${b64url({ ...claims, id: admin.id })}.${signature}`;
        assert.equal((await api("/api/auth/me", { token: asOtherUser })).status, 401);

        const longerLife = `${header}.${b64url({ ...claims, exp: claims.exp + 365 * 86400 })}.${signature}`;
        assert.equal((await api("/api/auth/me", { token: longerLife })).status, 401);
    });
});

/* ======================================================================= */

describe("POST /api/auth/setup-admin", () => {
    it("refuses a wrong or missing setup token with 403 and creates nothing", async () => {
        const email = uniqueEmail("nope");
        const wrongTokens = [
            "x".repeat(32),
            "",
            SETUP_TOKEN.toUpperCase(),
            `${SETUP_TOKEN}x`,
            SETUP_TOKEN.slice(0, -1),
            `Bearer ${SETUP_TOKEN}`,
            undefined,
        ];
        for (const token of wrongTokens) {
            const res = await setupAdmin({ email }, { token });
            assert.equal(res.status, 403, `token ${JSON.stringify(token)?.slice(0, 20)}`);
            assert.deepEqual(res.body, { message: "Invalid setup token" });
        }

        // The setup token in the body or the query string does not count.
        const inBody = await api(`/api/auth/setup-admin?token=${SETUP_TOKEN}`, {
            method: "POST",
            json: { name: "Root Admin", email, password: PASSWORD, setupToken: SETUP_TOKEN, "x-setup-token": SETUP_TOKEN },
        });
        assert.equal(inBody.status, 403);

        // A valid user token is not a setup token either.
        const renter = await newUser();
        const withJwt = await api("/api/auth/setup-admin", {
            method: "POST",
            token: renter.token,
            headers: { "x-setup-token": renter.token },
            json: { name: "Root Admin", email, password: PASSWORD },
        });
        assert.equal(withJwt.status, 403);

        assert.equal(await adminCount(), 0);
        assert.equal(await User.exists({ email }), null);
        assert.equal(await Setting.exists({ key: ADMIN_MARKER_KEY }), null);
    });

    it("creates the first admin exactly once; every later call gets 409", async () => {
        const email = uniqueEmail("first");
        const res = await setupAdmin({ name: "  First Admin ", email: email.toUpperCase() });

        assert.equal(res.status, 201);
        assertNoSecrets(res.body, "setup-admin");
        const dbAdmin = await stored({ email });
        assert.ok(dbAdmin, "admin must be stored with a normalised email");
        assert.deepEqual(res.body, {
            message: "First admin created successfully",
            user: { id: String(dbAdmin._id), name: "First Admin", email, role: "admin" },
        });
        assert.equal(dbAdmin.role, "admin");
        assert.equal(dbAdmin.tokenVersion, 0);
        assert.match(dbAdmin.password, /^\$2b\$12\$/);
        assert.equal(await bcrypt.compare(PASSWORD, dbAdmin.password), true);
        assert.ok(await Setting.exists({ key: ADMIN_MARKER_KEY }), "the one-time marker must be recorded");

        const log = await login(email);
        assert.equal(log.status, 200);
        assert.equal(log.body.user.role, "admin");
        assert.equal((await api("/api/auth/admin-only", { token: log.body.token })).status, 200);

        for (const again of [{ email: uniqueEmail("second") }, { email }]) {
            const second = await setupAdmin(again);
            assert.equal(second.status, 409);
            assert.deepEqual(second.body, { message: "An admin already exists" });
        }
        assert.equal(await adminCount(), 1);
        assert.equal(await User.countDocuments({}), 1);
    });

    it("stays closed once used, even if every admin later disappears (marker checked, state seeded via the model)", async () => {
        const admin = await firstAdmin();
        await User.deleteOne({ _id: admin.id });
        assert.equal(await adminCount(), 0);

        const res = await setupAdmin({ email: uniqueEmail("late") });
        assert.equal(res.status, 409);
        assert.deepEqual(res.body, { message: "Admin setup already completed" });
        assert.equal(await adminCount(), 0);
    });

    it("validates the input before claiming the one-time setup", async () => {
        const cases = [
            [{ password: "weak" }, "Password must be at least 8 characters"],
            [{ password: { $ne: null } }, "password is required"],
            [{ email: { $gt: "" } }, "email must be text"],
            [{ email: "nope" }, "Enter a valid email address"],
            [{ name: "x" }, "name must be at least 2 characters"],
            [{ name: ["Root"] }, "name must be text"],
        ];
        for (const [override, message] of cases) {
            const res = await setupAdmin(override);
            assert.equal(res.status, 400, JSON.stringify(override));
            assert.deepEqual(res.body, { message });
        }
        assert.equal(await Setting.exists({ key: ADMIN_MARKER_KEY }), null);
        assert.equal(await adminCount(), 0);

        assert.equal((await setupAdmin()).status, 201);
    });

    it("an email already held by a regular account is refused and releases the claim so setup can be retried", async () => {
        const renter = await newUser();
        const res = await setupAdmin({ email: renter.email.toUpperCase() });
        assert.equal(res.status, 409);
        assert.deepEqual(res.body, { message: "An account with this email already exists" });

        const dbRenter = await stored({ email: renter.email });
        assert.equal(dbRenter.role, "renter", "the existing account must not be promoted");
        assert.equal(await User.countDocuments({ email: renter.email }), 1);
        assert.equal(await Setting.exists({ key: ADMIN_MARKER_KEY }), null, "the claim must be released");
        assert.equal(await adminCount(), 0);

        const retry = await setupAdmin({ email: uniqueEmail("retry") });
        assert.equal(retry.status, 201);
        assert.equal(await adminCount(), 1);
    });

    it("five concurrent setup calls create exactly one admin", async () => {
        const emails = Array.from({ length: 5 }, () => uniqueEmail("concurrent"));
        const results = await Promise.all(emails.map((email, i) => setupAdmin({ name: `Admin ${i}`, email })));

        const statuses = results.map((r) => r.status).sort();
        assert.deepEqual(statuses, [201, 409, 409, 409, 409], JSON.stringify(results.map((r) => r.body)));
        for (const r of results.filter((x) => x.status === 409)) {
            assert.ok(
                ["An admin already exists", "Admin setup already completed"].includes(r.body.message),
                r.body.message
            );
        }

        assert.equal(await adminCount(), 1);
        assert.equal(await Setting.countDocuments({ key: ADMIN_MARKER_KEY }), 1);
        const winner = results.find((r) => r.status === 201);
        const dbAdmin = await User.findOne({ role: "admin" }).lean();
        assert.equal(dbAdmin.email, winner.body.user.email);
        assert.equal(await User.countDocuments({}), 1, "losers must not leave accounts behind");
    });

    it("five concurrent calls with the same email also create exactly one admin", async () => {
        const email = uniqueEmail("same");
        const results = await Promise.all(Array.from({ length: 5 }, () => setupAdmin({ email })));
        assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409, 409]);
        assert.equal(await adminCount(), 1);
        assert.equal(await User.countDocuments({ email }), 1);
    });
});
