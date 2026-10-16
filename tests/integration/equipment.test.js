import "../helpers/setEnv.js";
/**
 * End-to-end tests for equipment listings, the category catalogue and the
 * Cloudinary upload signer: who may create, read, update and delete a
 * listing, the moderation workflow (pending -> approved/rejected, re-review
 * after an edit), what the public and owner lists show (never the owner's
 * email or phone, one thumbnail plus imageCount), the search filters, the
 * legacy /equipment aliases, and abuse: other users' ids, wrong roles,
 * stale and forged tokens, injection-shaped and oversize input.
 *
 * Run alone with its own disposable database, for example:
 *   TEST_MONGO_URI=mongodb://127.0.0.1:27018/rentit_it_equipment \
 *     node --test --test-concurrency=1 tests/integration/equipment.test.js
 *
 * Users are created through the public API (register, login, setup-admin)
 * once per run; listings are wiped before every test and re-created through
 * the API (approvals and rejections through the admin endpoints). Only states
 * the API cannot produce are written through the models: a listing stored
 * before `images` and `availability` existed, and a listing whose owner
 * account has been removed.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import env from "../../config/env.js";
import Equipment from "../../Models/equipment.js";
import User from "../../Models/user.js";
import { dropDatabase, startTestServer } from "../helpers/testServer.js";

const JWT_SECRET = process.env.JWT_SECRET;
const SETUP_TOKEN = process.env.SETUP_ADMIN_TOKEN;
const PASSWORD = "Passw0rdOK";

const NO_TOKEN = { message: "Not authorized, no token" };
const INVALID_TOKEN = { message: "Not authorized, invalid token" };
const ACCESS_DENIED = { message: "Access denied" };
const NOT_FOUND = { message: "Equipment not found" };
const INVALID_ID = { message: "Invalid id" };
const TOO_LARGE = { message: "Request body too large" };
const UPLOADS_OFF = { message: "Image uploads are not configured" };

// The catalogue as the onboarding screens spell it; the slug doubles as the id.
const CATALOGUE = [
    ["Equipments", "equipments"],
    ["Power Tools", "power-tools"],
    ["Properties", "properties"],
    ["Camera & Photography", "camera-photography"],
    ["Event & Party Items", "event-party-items"],
    ["Electronics", "electronics"],
    ["Furnitures", "furnitures"],
    ["More", "more"],
];

// A well-formed id that never belongs to a listing.
const MISSING_ID = new mongoose.Types.ObjectId().toHexString();

let server;
let seq = 0;
let listingSeq = 0;

/** Every account created in this run, so the privacy checks can look for all of their contact details. */
const everyone = [];
let admin;
let ownerA;
let ownerB;
let renter;

const api = (path, options) => server.request(path, options);

const uniqueEmail = (tag) => `${tag}.${process.pid}.${++seq}@example.com`;

/* ---------- accounts, through the public API ---------- */

const login = (email) => api("/api/auth/login", { method: "POST", json: { email, password: PASSWORD } });

/** Register + log in. Returns { id, email, phone, name, businessName, role, token }. */
async function newUser({ role = "renter", name = `Test ${role} ${seq + 1}`, phone, businessName } = {}) {
    const email = uniqueEmail(role);
    const body = { name, email, password: PASSWORD, role };
    if (phone) body.phone = phone;
    if (businessName) body.businessName = businessName;
    const reg = await api("/api/auth/register", { method: "POST", json: body });
    assert.equal(reg.status, 201, `register failed: ${JSON.stringify(reg.body)}`);
    const log = await login(email);
    assert.equal(log.status, 200, `login failed: ${JSON.stringify(log.body)}`);
    const user = { id: String(log.body.user.id), email, phone, name, businessName, role, token: log.body.token };
    everyone.push(user);
    return user;
}

/** The first admin, created through setup-admin with the X-Setup-Token header. */
async function firstAdmin() {
    const email = uniqueEmail("admin");
    const res = await api("/api/auth/setup-admin", {
        method: "POST",
        headers: { "x-setup-token": SETUP_TOKEN },
        json: { name: "Root Admin", email, password: PASSWORD },
    });
    assert.equal(res.status, 201, `setup-admin failed: ${JSON.stringify(res.body)}`);
    const log = await login(email);
    assert.equal(log.status, 200);
    const user = { id: String(log.body.user.id), email, name: "Root Admin", role: "admin", token: log.body.token };
    everyone.push(user);
    return user;
}

async function logout(user) {
    const res = await api("/api/auth/logout", { method: "POST", token: user.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
}

async function changeRole(userId, role) {
    const res = await api("/api/auth/users/role", { method: "PUT", token: admin.token, json: { userId, role } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
}

/* ---------- tokens the API never issues ---------- */

const forge = (payload, secret = JWT_SECRET) => jwt.sign(payload, secret, { algorithm: "HS256" });
const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const unsignedToken = (payload) => `${b64url({ alg: "none", typ: "JWT" })}.${b64url(payload)}.`;
const nowSeconds = () => Math.floor(Date.now() / 1000);

/* ---------- images ---------- */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const WEBP_SIGNATURE = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);

const dataUrl = (mime, signature, bytes, fill) =>
    `data:${mime};base64,${Buffer.concat([signature, Buffer.alloc(bytes - signature.length, fill)]).toString("base64")}`;

/** A structurally valid PNG data URL; a different `fill` gives a different image. */
const png = (fill = 1, bytes = 48) => dataUrl("image/png", PNG_SIGNATURE, bytes, fill);
const jpeg = (fill = 1, bytes = 48) => dataUrl("image/jpeg", JPEG_SIGNATURE, bytes, fill);
const webp = (fill = 1, bytes = 48) => dataUrl("image/webp", WEBP_SIGNATURE, bytes, fill);

const MAX_IMAGE_BYTES = 900 * 1024;

/* ---------- listings, through the public API ---------- */

const listingBody = (overrides = {}) => ({
    title: `Honda generator ${++listingSeq}`,
    description: "5kVA petrol generator, serviced monthly",
    price: 15000,
    rentalDeposit: 5000,
    category: "Equipments",
    condition: "Good",
    location: "Ikeja, Lagos",
    specs: ["5kVA", "Petrol"],
    images: [png(1)],
    availability: true,
    ...overrides,
});

const post = (user, body, path = "/api/equipment") => api(path, { method: "POST", token: user?.token, json: body });
const patch = (user, id, body, path = `/api/equipment/${id}`) => api(path, { method: "PATCH", token: user?.token, json: body });
const remove = (user, id, path = `/api/equipment/${id}`) => api(path, { method: "DELETE", token: user?.token });
const detail = (user, id, path = `/api/equipment/${id}`) => api(path, { token: user?.token });
const publicList = (query = "", user, path = "/api/equipment") => api(`${path}${query}`, { token: user?.token });
const mine = (user, query = "", path = "/api/equipment/mine") => api(`${path}${query}`, { token: user?.token });

/** Creates a listing as `owner` and returns the listing from the 201 response. */
async function create(owner, overrides = {}, path = "/api/equipment") {
    const res = await post(owner, listingBody(overrides), path);
    assert.equal(res.status, 201, `create failed: ${JSON.stringify(res.body)}`);
    return res.body.equipment;
}

async function approve(id) {
    const res = await api(`/api/admin/equipment/${id}/approve`, { method: "PUT", token: admin.token });
    assert.equal(res.status, 200, `approve failed: ${JSON.stringify(res.body)}`);
    return res.body.equipment;
}

async function reject(id, reason = "Photos are too blurry") {
    const res = await api(`/api/admin/equipment/${id}/reject`, { method: "PUT", token: admin.token, json: { reason } });
    assert.equal(res.status, 200, `reject failed: ${JSON.stringify(res.body)}`);
    return res.body.equipment;
}

async function approved(owner, overrides) {
    const listing = await create(owner, overrides);
    await approve(listing._id);
    return listing;
}

async function rejected(owner, overrides, reason) {
    const listing = await create(owner, overrides);
    await reject(listing._id, reason);
    return listing;
}

/** Approved, then switched off by its owner: approved but hidden from the public list. */
async function unavailable(owner, overrides) {
    const listing = await approved(owner, overrides);
    const res = await patch(owner, listing._id, { availability: false });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.equipment.status, "approved");
    return listing;
}

/* ---------- reading back ---------- */

const stored = (id) => Equipment.findById(id).lean();
const ids = (res) => res.body.equipment.map((item) => item._id);

/* ---------- response hygiene ---------- */

const CONTACT_KEYS = new Set(["email", "phone", "password", "tokenVersion", "kycDetails", "kycStatus", "address", "lastLoginAt"]);

/** Fails when any user field beyond a display name appears, or any user's email or phone shows up anywhere. */
function assertNoContactDetails(body, label) {
    const walk = (value, path) => {
        if (Array.isArray(value)) {
            value.forEach((item, i) => walk(item, `${path}[${i}]`));
        } else if (value !== null && typeof value === "object") {
            for (const [key, item] of Object.entries(value)) {
                assert.ok(!CONTACT_KEYS.has(key), `${label}: ${path}.${key} must never be exposed`);
                walk(item, `${path}.${key}`);
            }
        }
    };
    walk(body, "body");
    const text = JSON.stringify(body).toLowerCase();
    for (const user of everyone) {
        assert.ok(!text.includes(user.email.toLowerCase()), `${label}: the email of ${user.name} leaked`);
        if (user.phone) {
            assert.ok(!text.includes(user.phone.toLowerCase()), `${label}: the phone of ${user.name} leaked`);
            assert.ok(!text.includes(user.phone.replace(/\D/g, "")), `${label}: the phone digits of ${user.name} leaked`);
        }
    }
}

/** The populated owner is exactly { _id, name, businessName }. */
function assertOwnerSummary(owner, user, label) {
    const expected = { _id: user.id, name: user.name };
    if (user.businessName) expected.businessName = user.businessName;
    assert.deepEqual(owner, expected, `${label}: owner must be shown by name only`);
}

/* ---------- lifecycle ---------- */

before(async () => {
    server = await startTestServer();
    await dropDatabase();
    admin = await firstAdmin();
    ownerA = await newUser({ role: "owner", name: "Ada Owner", phone: "+2348011112222", businessName: "Ada Tools Ltd" });
    ownerB = await newUser({ role: "owner", name: "Bayo Owner", phone: "08033334444", businessName: "Bayo Rentals" });
    renter = await newUser({ role: "renter", name: "Chi Renter", phone: "+2348055556666" });
});

beforeEach(async () => {
    await Equipment.deleteMany({});
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

describe("POST /api/equipment (create)", () => {
    it("lets an owner create a pending listing and stores the validated, normalised fields", async () => {
        const images = [png(1), jpeg(2), webp(3)];
        const res = await post(ownerA, {
            title: "  Makita cordless drill  ",
            description: " 18V, two batteries ",
            price: "12500",
            rentalDeposit: 0,
            category: "power-tools",
            condition: " Like new ",
            location: " Yaba, Lagos ",
            specs: [" 18V ", "", "2 batteries"],
            images,
            availability: true,
        });

        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal(res.body.message, "Equipment listing created");
        const { equipment } = res.body;
        assert.match(equipment._id, /^[a-f\d]{24}$/);
        assert.equal(equipment.title, "Makita cordless drill");
        // The dashboards read name, pricePerDay and image, derived from the stored fields.
        assert.equal(equipment.name, "Makita cordless drill");
        assert.equal(equipment.price, 12500);
        assert.equal(equipment.pricePerDay, 12500);
        assert.equal(equipment.image, images[0]);
        assert.deepEqual(equipment.images, images);
        assert.equal(equipment.category, "Power Tools");
        assert.deepEqual(equipment.specs, ["18V", "2 batteries"]);
        assert.equal(equipment.status, "pending");
        assert.equal(equipment.owner, ownerA.id);
        assert.equal(equipment.__v, undefined);
        assertNoContactDetails(res.body, "create response");

        const row = await stored(equipment._id);
        assert.ok(row, "listing must be persisted");
        assert.equal(row.title, "Makita cordless drill");
        assert.equal(row.description, "18V, two batteries");
        assert.equal(row.price, 12500);
        assert.equal(row.rentalDeposit, 0);
        assert.equal(row.category, "Power Tools");
        assert.equal(row.condition, "Like new");
        assert.equal(row.location, "Yaba, Lagos");
        assert.deepEqual(row.specs, ["18V", "2 batteries"]);
        assert.deepEqual(row.images, images);
        assert.equal(row.availability, true);
        assert.equal(row.status, "pending");
        assert.equal(String(row.owner), ownerA.id);
        assert.equal(row.rejectionReason, "");
        assert.equal(row.reviewedBy, undefined);
        assert.equal(row.reviewedAt, undefined);
        // Derived fields are never stored.
        assert.equal(row.name, undefined);
        assert.equal(row.pricePerDay, undefined);
    });

    it("forces status pending and the caller as owner whatever the client sends", async () => {
        const plantedId = new mongoose.Types.ObjectId().toHexString();
        const res = await post(
            ownerA,
            listingBody({
                _id: plantedId,
                status: "approved",
                owner: ownerB.id,
                reviewedBy: admin.id,
                reviewedAt: "2020-01-01T00:00:00.000Z",
                rejectionReason: "none",
                createdAt: "2000-01-01T00:00:00.000Z",
            })
        );
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal(res.body.equipment.status, "pending");
        assert.equal(res.body.equipment.owner, ownerA.id);
        assert.notEqual(res.body.equipment._id, plantedId);

        const row = await stored(res.body.equipment._id);
        assert.equal(row.status, "pending");
        assert.equal(String(row.owner), ownerA.id);
        assert.equal(row.reviewedBy, undefined);
        assert.equal(row.reviewedAt, undefined);
        assert.equal(row.rejectionReason, "");
        assert.ok(Date.now() - row.createdAt.getTime() < 60_000, "createdAt must be set by the server");
        assert.equal(await Equipment.exists({ _id: plantedId }), null);

        // Nothing was planted on the other owner, and nothing went live.
        assert.equal((await mine(ownerB)).body.total, 0);
        assert.equal((await publicList()).body.total, 0);
    });

    it("refuses renters and admins (403) and anonymous callers (401), storing nothing", async () => {
        const body = listingBody();
        for (const [user, status, expected] of [
            [renter, 403, ACCESS_DENIED],
            [admin, 403, ACCESS_DENIED],
            [undefined, 401, NO_TOKEN],
        ]) {
            const res = await post(user, body);
            assert.equal(res.status, status, user?.role ?? "anonymous");
            assert.deepEqual(res.body, expected);
        }
        assert.equal(await Equipment.countDocuments(), 0);
    });

    it("refuses logged-out, demoted, deleted, expired, forged and unsigned tokens with 401", async () => {
        const loggedOut = await newUser({ role: "owner" });
        await logout(loggedOut);

        const demoted = await newUser({ role: "owner" });
        await changeRole(demoted.id, "renter");

        const deleted = await newUser({ role: "owner" });
        await User.deleteOne({ _id: deleted.id });

        const tokens = {
            "logged out": loggedOut.token,
            "role changed": demoted.token,
            "account deleted": deleted.token,
            expired: forge({ id: ownerA.id, role: "owner", tv: 0, exp: nowSeconds() - 60 }),
            "wrong secret": forge({ id: ownerA.id, role: "owner", tv: 0 }, "x".repeat(48)),
            "stale token version": forge({ id: ownerA.id, role: "owner", tv: 7 }),
            "unsigned (alg none)": unsignedToken({ id: ownerA.id, role: "owner", tv: 0 }),
            "not a jwt": "abc.def.ghi",
        };
        for (const [label, token] of Object.entries(tokens)) {
            const res = await api("/api/equipment", { method: "POST", token, json: listingBody() });
            assert.equal(res.status, 401, label);
            assert.deepEqual(res.body, INVALID_TOKEN, label);
        }
        assert.equal(await Equipment.countDocuments(), 0);

        // The demoted account logs in again as a renter: 403, not a listing.
        const relog = await login(demoted.email);
        const res = await post({ token: relog.body.token }, listingBody());
        assert.equal(res.status, 403);
        assert.equal(await Equipment.countDocuments(), 0);
    });

    it("rejects injection-shaped and invalid values with 400 and stores nothing", async () => {
        const cloudinaryUrl = `https://res.cloudinary.com/demo/image/upload/v1/rentit/equipment/${ownerA.id}/a.jpg`;
        const html = Buffer.from("<html><script>alert(1)</script></html>").toString("base64");
        const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString("base64");
        const sixImages = [1, 2, 3, 4, 5, 6].map((fill) => png(fill));

        const cases = [
            [{ title: { $gt: "" } }, "title must be text"],
            [{ title: ["Generator"] }, "title must be text"],
            [{ title: "ab" }, "title must be at least 3 characters"],
            [{ title: "x".repeat(121) }, "title must be at most 120 characters"],
            [{ title: "   " }, "title is required"],
            [{ title: undefined }, "title is required"],
            [{ title: null }, "title is required"],
            [{ price: { $gt: 0 } }, "price must be a positive number"],
            [{ price: 0 }, "price must be a positive number"],
            [{ price: -5 }, "price must be a positive number"],
            [{ price: "abc" }, "price must be a positive number"],
            [{ price: "Infinity" }, "price must be a positive number"],
            [{ price: true }, "price must be a positive number"],
            [{ price: 1e9 + 1 }, "price must be a positive number"],
            [{ price: undefined }, "price must be a positive number"],
            [{ rentalDeposit: -1 }, "rentalDeposit must be a non-negative number"],
            [{ rentalDeposit: { $ne: 0 } }, "rentalDeposit must be a non-negative number"],
            [{ description: "d".repeat(2001) }, "description must be at most 2000 characters"],
            [{ description: { $where: "1" } }, "description must be text"],
            [{ category: { $ne: "" } }, "category must be text"],
            [{ category: "c".repeat(61) }, "category must be at most 60 characters"],
            [{ condition: "c".repeat(41) }, "condition must be at most 40 characters"],
            [{ location: { $regex: ".*" } }, "location must be text"],
            [{ location: "l".repeat(121) }, "location must be at most 120 characters"],
            [{ specs: "5kVA" }, "specs must be a list"],
            [{ specs: Array.from({ length: 21 }, (_, i) => `spec ${i}`) }, "specs can have at most 20 items"],
            [{ specs: [{ $gt: "" }] }, "specs item must be text"],
            [{ specs: ["s".repeat(101)] }, "specs item must be at most 100 characters"],
            [{ availability: "false" }, "availability must be true or false"],
            [{ availability: 0 }, "availability must be true or false"],
            [{ images: png() }, "images must be a list"],
            [{ images: [...sixImages, png(7)] }, "A listing can have at most 6 images"],
            [{ images: sixImages, image: png(7) }, "A listing can have at most 6 images"],
            [{ images: [{ $gt: "" }] }, "image 1 must be an image"],
            [{ images: [""] }, "image 1 must be an image"],
            [{ images: ["not a url"] }, "image 1 must be an image URL"],
            [{ images: ["javascript:alert(1)"] }, "image 1 must be an image uploaded through RentIt"],
            [{ images: ["http://evil.example/a.png"] }, "image 1 must be an image uploaded through RentIt"],
            [{ images: [cloudinaryUrl] }, "image 1 must be an image uploaded through RentIt"],
            [{ images: [`https://x.example/${"a".repeat(600)}`] }, "image 1 URL is too long"],
            [{ images: [`data:image/svg+xml;base64,${svg}`] }, "image 1 must be a JPEG, PNG or WebP image"],
            [{ images: [`data:image/png;base64,${html}`] }, "image 1 is not a valid PNG image"],
            [{ images: [png().replace("image/png", "image/jpeg")] }, "image 1 is not a valid JPEG image"],
            [{ images: ["data:image/png;base64,@@@@"] }, "image 1 is not valid image data"],
            [{ images: [png(1)], image: "data:text/html;base64,PGh0bWw+" }, "image must be a JPEG, PNG or WebP image"],
        ];
        for (const [overrides, message] of cases) {
            const res = await post(ownerA, listingBody(overrides));
            assert.equal(res.status, 400, `${JSON.stringify(overrides).slice(0, 120)} -> ${JSON.stringify(res.body)}`);
            assert.deepEqual(res.body, { message }, JSON.stringify(overrides).slice(0, 120));
        }
        assert.equal(await Equipment.countDocuments(), 0);
    });

    it("treats a non-object body as empty and answers malformed JSON with 400", async () => {
        const array = await post(ownerA, [listingBody()]);
        assert.equal(array.status, 400);
        assert.deepEqual(array.body, { message: "title is required" });

        const malformed = await api("/api/equipment", {
            method: "POST",
            token: ownerA.token,
            headers: { "content-type": "application/json" },
            body: '{"title": "Generator", ',
        });
        assert.equal(malformed.status, 400);
        assert.deepEqual(malformed.body, { message: "Invalid JSON body" });
        assert.equal(await Equipment.countDocuments(), 0);
    });

    it("accepts six images of the maximum size and refuses one byte more", async () => {
        const biggest = [1, 2, 3, 4, 5, 6].map((fill) => png(fill, MAX_IMAGE_BYTES));
        const res = await post(ownerA, listingBody({ images: biggest }));
        assert.equal(res.status, 201, JSON.stringify(res.body)?.slice(0, 200));
        const row = await stored(res.body.equipment._id);
        assert.equal(row.images.length, 6);
        assert.equal(row.images[5], biggest[5]);

        const tooBig = await post(ownerA, listingBody({ images: [png(9, MAX_IMAGE_BYTES + 1)] }));
        assert.equal(tooBig.status, 400);
        assert.match(tooBig.body.message, /^image 1 is too large/);
        assert.equal(await Equipment.countDocuments(), 1);
    });

    it("answers 413 to a body over 8mb and 401 to an anonymous large body before parsing it", async () => {
        const huge = await post(ownerA, listingBody({ description: "d".repeat(8.5 * 1024 * 1024) }));
        assert.equal(huge.status, 413);
        assert.deepEqual(huge.body, TOO_LARGE);

        // Without a token the 8mb parser never runs: the caller is refused first.
        for (const path of ["/api/equipment", "/equipment/create"]) {
            const anonymous = await post(undefined, listingBody({ description: "d".repeat(2 * 1024 * 1024) }), path);
            assert.equal(anonymous.status, 401, path);
            assert.deepEqual(anonymous.body, NO_TOKEN);
        }
        const forged = await api("/api/equipment", {
            method: "POST",
            token: forge({ id: ownerA.id, role: "owner", tv: 0 }, "y".repeat(48)),
            json: listingBody({ description: "d".repeat(2 * 1024 * 1024) }),
        });
        assert.equal(forged.status, 401);
        assert.deepEqual(forged.body, INVALID_TOKEN);
        assert.equal(await Equipment.countDocuments(), 0);
    });
});

/* ======================================================================= */

describe("GET /api/equipment (public list)", () => {
    it("shows only approved, available listings, newest first, to anonymous users, renters and owners alike", async () => {
        const pending = await create(ownerA);
        const a1 = await approved(ownerA);
        const b1 = await approved(ownerB);
        await rejected(ownerB);
        await unavailable(ownerA);
        const a2 = await approved(ownerA);

        for (const user of [undefined, renter, ownerA, ownerB]) {
            const res = await publicList("", user);
            const label = user?.name ?? "anonymous";
            assert.equal(res.status, 200, label);
            assert.deepEqual(ids(res), [a2._id, b1._id, a1._id], label);
            assert.equal(res.body.total, 3, label);
            assert.equal(res.body.page, 1);
            assert.equal(res.body.limit, 20);
            assert.ok(res.body.equipment.every((item) => item.status === "approved" && item.availability === true), label);
            assert.ok(!ids(res).includes(pending._id), label);
        }
    });

    it("shows the owner by name and business name only: never an email or phone", async () => {
        await approved(ownerA);
        await approved(ownerB);
        for (const user of [undefined, renter, ownerA, admin]) {
            const res = await publicList("", user);
            assert.equal(res.status, 200);
            assert.equal(res.body.equipment.length, 2);
            assertNoContactDetails(res.body, `public list as ${user?.name ?? "anonymous"}`);
            const [newest, oldest] = res.body.equipment;
            assertOwnerSummary(newest.owner, ownerB, "public list");
            assertOwnerSummary(oldest.owner, ownerA, "public list");
        }

        // Positive control: the admin-only review queue does carry owner emails, and the check catches it.
        const review = await api("/api/admin/equipment?status=all", { token: admin.token });
        assert.equal(review.status, 200);
        assert.throws(() => assertNoContactDetails(review.body, "admin review queue"), /email/);
        for (const user of [ownerA, renter]) {
            const res = await api("/api/admin/equipment?status=all", { token: user.token });
            assert.equal(res.status, 403, user.name);
        }
    });

    it("returns a single thumbnail plus imageCount per listing", async () => {
        const images = [png(1), png(2), png(3)];
        await approved(ownerA, { images });
        await approved(ownerA, { images: [] });

        const res = await publicList();
        const [noImages, threeImages] = res.body.equipment;
        assert.deepEqual(threeImages.images, [images[0]]);
        assert.equal(threeImages.image, images[0]);
        assert.equal(threeImages.imageCount, 3);
        assert.deepEqual(noImages.images, []);
        assert.equal(noImages.image, "");
        assert.equal(noImages.imageCount, 0);
    });

    it("keeps a page of maximum-size listings to one thumbnail each", async () => {
        const big = [1, 2, 3, 4, 5, 6].map((fill) => png(fill, MAX_IMAGE_BYTES));
        const listing = await approved(ownerA, { images: big });

        const res = await publicList();
        assert.equal(res.status, 200);
        assert.equal(res.body.equipment[0].imageCount, 6);
        assert.deepEqual(res.body.equipment[0].images, [big[0]]);
        // One ~1.2MB thumbnail (sent as images[0] and as the dashboards' `image`), never all six.
        assert.equal(res.body.equipment[0].image, big[0]);
        assert.ok(JSON.stringify(res.body).length < 2 * big[0].length + 10_000);

        const full = await detail(undefined, listing._id);
        assert.deepEqual(full.body.equipment.images, big);
    });

    it("lets only an admin ask for another status", async () => {
        const pending = await create(ownerA);
        const live = await approved(ownerA);
        const refused = await rejected(ownerB);
        const off = await unavailable(ownerB);

        const asAdmin = (query) => publicList(query, admin);
        assert.deepEqual(ids(await asAdmin("?status=pending")), [pending._id]);
        assert.deepEqual(ids(await asAdmin("?status=REJECTED")), [refused._id]);
        assert.deepEqual(ids(await asAdmin("?status=approved")), [off._id, live._id]);
        const all = await asAdmin("?status=all");
        assert.deepEqual(ids(all), [off._id, refused._id, live._id, pending._id]);
        assert.equal(all.body.total, 4);
        assertNoContactDetails(all.body, "admin status=all");
        // No status: the admin gets the public view too.
        assert.deepEqual(ids(await asAdmin("")), [live._id]);

        for (const query of ["?status=published", "?status=pending&status=all"]) {
            const res = await asAdmin(query);
            assert.equal(res.status, 400, query);
            assert.equal(typeof res.body.message, "string");
        }

        // Everyone else gets the public view whatever they ask for.
        for (const [user, query] of [
            [ownerA, "?status=pending"],
            [ownerB, "?status=all"],
            [renter, "?status=rejected"],
            [undefined, "?status=all"],
            [{ token: forge({ id: ownerA.id, role: "admin", tv: 0 }) }, "?status=all"],
            [{ token: forge({ id: admin.id, role: "admin", tv: 0 }, "z".repeat(48)) }, "?status=all"],
        ]) {
            const res = await publicList(query, user);
            assert.equal(res.status, 200, query);
            assert.deepEqual(ids(res), [live._id], `${user?.name ?? "token"} ${query}`);
        }
    });

    it("paginates newest first with a ceiling on limit", async () => {
        const created = [];
        for (let i = 0; i < 5; i++) created.push((await approved(ownerA))._id);
        const newestFirst = [...created].reverse();

        const pages = [];
        for (const page of [1, 2, 3, 4]) {
            const res = await publicList(`?limit=2&page=${page}`);
            assert.equal(res.status, 200);
            assert.equal(res.body.page, page);
            assert.equal(res.body.limit, 2);
            assert.equal(res.body.total, 5);
            pages.push(ids(res));
        }
        assert.deepEqual(pages, [newestFirst.slice(0, 2), newestFirst.slice(2, 4), newestFirst.slice(4), []]);

        const cases = [
            ["?limit=500", 1, 100],
            ["?limit=0", 1, 20],
            ["?limit=-3", 1, 1],
            ["?limit=abc", 1, 20],
            ["?page=0", 1, 20],
            ["?page=-2", 1, 20],
            ["?page=abc", 1, 20],
            ["?page=1&page=2", 1, 20],
        ];
        for (const [query, page, limit] of cases) {
            const res = await publicList(query);
            assert.equal(res.status, 200, query);
            assert.equal(res.body.page, page, query);
            assert.equal(res.body.limit, limit, query);
        }
        assert.deepEqual(ids(await publicList("?limit=-3")), [newestFirst[0]]);
    });

    it("answers a huge page number with an empty page or a 400, never a 500", { todo: "BUG: ?page is not capped; a 400-digit page parses to Infinity, skip(Infinity) is refused by the database and the API answers 500" }, async () => {
        await approved(ownerA);
        for (const page of ["1" + "0".repeat(20), "9".repeat(400)]) {
            const res = await publicList(`?page=${page}`);
            assert.ok([200, 400].includes(res.status), `page=${page.slice(0, 25)}... answered ${res.status} ${JSON.stringify(res.body)}`);
            if (res.status === 200) assert.deepEqual(res.body.equipment, []);
        }
    });

    describe("filters", () => {
        let drill;
        let camera;
        let generator;
        let welder;
        let tent;

        beforeEach(async () => {
            drill = await approved(ownerA, {
                title: "Makita drill",
                description: "Cordless, two batteries",
                category: "Power Tools",
                location: "Yaba, Lagos",
                price: 5000,
            });
            camera = await approved(ownerB, {
                title: "Canon EOS R6",
                description: "Full-frame body with a DRILLED lens hood",
                category: "camera-photography",
                location: "Wuse, Abuja",
                price: 25000,
            });
            generator = await approved(ownerA, {
                title: "Honda generator",
                description: "5kVA petrol",
                category: "Equipments",
                location: "Ikeja, Lagos",
                price: 15000,
            });
            welder = await approved(ownerB, {
                title: "Arc welder",
                description: "Heavy duty",
                category: "Welders",
                location: "Port Harcourt",
                price: 9999.5,
            });
            tent = await approved(ownerA, {
                title: "Party tent",
                description: "Seats 100",
                category: "Event & Party Items",
                location: "Lekki, Lagos",
                price: 40000,
            });
            // Never part of a public answer, however well it matches.
            await create(ownerA, { title: "Makita drill pending", category: "Power Tools", location: "Yaba, Lagos", price: 5000 });
            await unavailable(ownerA, { title: "Makita drill unavailable", category: "Power Tools", location: "Yaba, Lagos", price: 5000 });
        });

        const search = async (query) => {
            const res = await publicList(query);
            assert.equal(res.status, 200, `${query}: ${JSON.stringify(res.body)}`);
            assert.equal(res.body.total, res.body.equipment.length, query);
            return ids(res);
        };

        it("q matches title, description and category case-insensitively", async () => {
            assert.deepEqual(await search("?q=drill"), [camera._id, drill._id]);
            assert.deepEqual(await search("?q=HONDA"), [generator._id]);
            assert.deepEqual(await search("?q=photo"), [camera._id]);
            assert.deepEqual(await search("?q=%20%20tent%20%20"), [tent._id]);
            assert.deepEqual(await search("?q=nothing-like-this"), []);
            assert.deepEqual(await search("?q="), [tent._id, welder._id, generator._id, camera._id, drill._id]);
        });

        it("category accepts the catalogue slug or name in any case, and free text", async () => {
            for (const value of ["power-tools", "Power%20Tools", "power%20tools", "POWER-TOOLS"]) {
                assert.deepEqual(await search(`?category=${value}`), [drill._id], value);
            }
            assert.deepEqual(await search("?category=camera-photography"), [camera._id]);
            assert.deepEqual(await search("?category=Camera%20%26%20Photography"), [camera._id]);
            assert.deepEqual(await search("?category=event-party-items"), [tent._id]);
            assert.deepEqual(await search("?category=Welders"), [welder._id]);
            assert.deepEqual(await search("?category=properties"), []);
        });

        it("location matches part of the location case-insensitively", async () => {
            assert.deepEqual(await search("?location=lagos"), [tent._id, generator._id, drill._id]);
            assert.deepEqual(await search("?location=ABUJA"), [camera._id]);
            assert.deepEqual(await search("?location=Kano"), []);
        });

        it("minPrice and maxPrice are inclusive and can be used alone", async () => {
            assert.deepEqual(await search("?minPrice=15000"), [tent._id, generator._id, camera._id]);
            assert.deepEqual(await search("?maxPrice=9999.5"), [welder._id, drill._id]);
            assert.deepEqual(await search("?minPrice=5000&maxPrice=15000"), [welder._id, generator._id, drill._id]);
            assert.deepEqual(await search("?minPrice=0"), [tent._id, welder._id, generator._id, camera._id, drill._id]);
            assert.deepEqual(await search("?maxPrice=0"), []);
            assert.deepEqual(await search("?minPrice=20000&maxPrice=10000"), []);
            assert.deepEqual(await search("?minPrice=&maxPrice="), [tent._id, welder._id, generator._id, camera._id, drill._id]);
        });

        it("combines filters with pagination", async () => {
            assert.deepEqual(await search("?q=a&location=lagos&maxPrice=20000&category=equipments"), [generator._id]);
            const res = await publicList("?location=lagos&limit=2&page=2");
            assert.deepEqual(ids(res), [drill._id]);
            assert.equal(res.body.total, 3);
            assertNoContactDetails(res.body, "filtered list");
        });

        it("treats regular-expression metacharacters in q and location as plain text", async () => {
            const literal = await approved(ownerA, {
                title: "Drill (18V) [Pro] a.b",
                description: "C++ manual, 50% off, cost $5 ^_^ back\\slash",
                location: "Lagos (Island) *",
            });
            const plain = await approved(ownerA, { title: "axb tool", description: "nothing special", location: "Island" });

            assert.deepEqual(await search("?q=a.b"), [literal._id]);
            assert.deepEqual(await search("?q=(18V)"), [literal._id]);
            assert.deepEqual(await search("?q=%5BPro%5D"), [literal._id]);
            assert.deepEqual(await search("?q=C%2B%2B"), [literal._id]);
            assert.deepEqual(await search("?q=%245"), [literal._id]);
            assert.deepEqual(await search("?q=%5E_%5E"), [literal._id]);
            assert.deepEqual(await search("?q=back%5Cslash"), [literal._id]);
            assert.deepEqual(await search("?location=(Island)%20*"), [literal._id]);
            // Raw, these would match everything, or be invalid patterns (a 500). Escaped, they only
            // match the one listing that contains them literally.
            const metacharacters = [
                [".*", []],
                ["%5E", [literal._id]],
                ["%24", [literal._id]],
                ["(", [literal._id]],
                ["%5B", [literal._id]],
                ["%5C", [literal._id]],
                ["%2B", [literal._id]],
                ["%3F", []],
                ["*", []],
                ["a%7Cb", []],
                ["x%7B1000%7D", []],
                ["(a%2B)%2B%24", []],
            ];
            for (const [q, expected] of metacharacters) {
                assert.deepEqual(await search(`?q=${q}`), expected, `q=${q}`);
            }
            assert.deepEqual(await search("?location=.*"), []);
            assert.deepEqual(await search("?location=*"), [literal._id]);
            assert.ok((await search("?q=tool")).includes(plain._id));
        });

        it("answers 400 to invalid, repeated and oversize filter values", async () => {
            const cases = [
                ["?q=a&q=b", "q must be text"],
                ["?category=a&category=b", "category must be text"],
                ["?location=a&location=b", "location must be text"],
                ["?minPrice=1&minPrice=2", "minPrice must be a non-negative number"],
                [`?q=${"x".repeat(61)}`, "q must be at most 60 characters"],
                [`?category=${"c".repeat(61)}`, "category must be at most 60 characters"],
                [`?location=${"l".repeat(121)}`, "location must be at most 120 characters"],
                ["?minPrice=abc", "minPrice must be a non-negative number"],
                ["?minPrice=-1", "minPrice must be a non-negative number"],
                ["?maxPrice=Infinity", "maxPrice must be a non-negative number"],
                ["?maxPrice=1e10", "maxPrice must be a non-negative number"],
            ];
            for (const [query, message] of cases) {
                const res = await publicList(query);
                assert.equal(res.status, 400, query.slice(0, 60));
                assert.deepEqual(res.body, { message }, query.slice(0, 60));
            }
        });

        it("never lets operator-shaped query keys widen the result or crash the handler", async () => {
            const publicIds = await search("");
            for (const query of [
                "?q[$ne]=x",
                "?q[$regex]=.*",
                "?category[$ne]=x",
                "?location[$regex]=.*",
                "?minPrice[$gt]=0",
                "?status[$ne]=approved",
                "?availability=false",
                "?owner[$ne]=x",
                "?$where=1",
            ]) {
                for (const user of [undefined, ownerA]) {
                    const res = await publicList(query, user);
                    assert.ok([200, 400].includes(res.status), `${query}: ${res.status}`);
                    if (res.status === 200) {
                        assert.deepEqual(ids(res), publicIds, query);
                        assert.ok(res.body.equipment.every((item) => item.status === "approved" && item.availability), query);
                    }
                }
            }
        });

        it(
            "answers 400 to non-string query values such as ?q[$ne]=x",
            { todo: "BUG: Express 5's default 'simple' query parser keeps ?q[$ne]=x as the literal key 'q[$ne]', so the str() check never sees an object and the request answers 200 with the filter silently ignored" },
            async () => {
                for (const query of ["?q[$ne]=x", "?category[$ne]=x", "?location[$regex]=.*", "?minPrice[$gt]=0", "?maxPrice[$lt]=1"]) {
                    const res = await publicList(query);
                    assert.equal(res.status, 400, `${query} answered ${res.status}`);
                }
            }
        );
    });

    it("still lists a legacy listing stored before images and availability existed", async () => {
        // Rows like this predate the current schema, so the API cannot create them.
        const legacyImage = png(42);
        const { insertedId } = await Equipment.collection.insertOne({
            title: "Legacy welder",
            price: 4000,
            owner: new mongoose.Types.ObjectId(ownerB.id),
            status: "approved",
            image: legacyImage,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        const id = String(insertedId);

        const res = await publicList();
        assert.equal(res.status, 200);
        assert.deepEqual(ids(res), [id]);
        const [item] = res.body.equipment;
        assert.equal(item.image, legacyImage);
        assert.deepEqual(item.images, []);
        assert.equal(item.imageCount, 0);
        assert.equal(item.name, "Legacy welder");
        assert.equal(item.pricePerDay, 4000);
        assertOwnerSummary(item.owner, ownerB, "legacy listing");

        const one = await detail(undefined, id);
        assert.equal(one.status, 200);
        assert.equal(one.body.equipment.image, legacyImage);
    });
});

/* ======================================================================= */

describe("GET /api/equipment/mine", () => {
    it("lists every status of the caller's own listings only, newest first", async () => {
        const a1 = await create(ownerA);
        const a2 = await approved(ownerA);
        const a3 = await rejected(ownerA, {}, "Wrong category");
        const a4 = await unavailable(ownerA);
        const b1 = await approved(ownerB);
        const b2 = await create(ownerB);

        const resA = await mine(ownerA);
        assert.equal(resA.status, 200);
        assert.deepEqual(ids(resA), [a4._id, a3._id, a2._id, a1._id]);
        assert.deepEqual(
            resA.body.equipment.map((item) => [item.status, item.availability]),
            [["approved", false], ["rejected", true], ["approved", true], ["pending", true]]
        );
        assert.equal(resA.body.equipment[1].rejectionReason, "Wrong category");
        assert.equal(resA.body.total, 4);
        for (const item of resA.body.equipment) assertOwnerSummary(item.owner, ownerA, "mine");
        assertNoContactDetails(resA.body, "mine");

        const resB = await mine(ownerB);
        assert.deepEqual(ids(resB), [b2._id, b1._id]);
        assertNoContactDetails(resB.body, "mine");

        const page = await mine(ownerA, "?limit=3&page=2");
        assert.deepEqual(ids(page), [a1._id]);
        assert.equal(page.body.total, 4);
        assert.equal(page.body.limit, 3);
    });

    it("ignores filters that would reach other owners' listings", async () => {
        await create(ownerA);
        await approved(ownerB);
        for (const query of ["?owner=" + ownerB.id, "?status=all", "?owner[$ne]=x", "?q=generator"]) {
            const res = await mine(ownerA, query);
            assert.equal(res.status, 200, query);
            assert.equal(res.body.total, 1, query);
            assert.ok(res.body.equipment.every((item) => item.owner._id === ownerA.id), query);
        }
    });

    it("returns a single thumbnail plus imageCount", async () => {
        const images = [png(1), jpeg(2), webp(3), png(4)];
        await create(ownerA, { images });
        const [item] = (await mine(ownerA)).body.equipment;
        assert.deepEqual(item.images, [images[0]]);
        assert.equal(item.image, images[0]);
        assert.equal(item.imageCount, 4);
    });

    it("refuses renters and admins (403), anonymous and stale tokens (401), on both mounts", async () => {
        const loggedOut = await newUser({ role: "owner" });
        await create(loggedOut);
        await logout(loggedOut);

        for (const path of ["/api/equipment/mine", "/equipment/mine"]) {
            for (const [user, status, body] of [
                [renter, 403, ACCESS_DENIED],
                [admin, 403, ACCESS_DENIED],
                [undefined, 401, NO_TOKEN],
                [loggedOut, 401, INVALID_TOKEN],
            ]) {
                const res = await mine(user, "", path);
                assert.equal(res.status, status, `${path} as ${user?.name ?? "anonymous"}`);
                assert.deepEqual(res.body, body);
            }
        }
    });
});

/* ======================================================================= */

describe("GET /api/equipment/:id (detail)", () => {
    it("shows an approved listing to everyone, with every image and the owner by name only", async () => {
        const images = [png(1), jpeg(2), webp(3)];
        const listing = await approved(ownerA, { images });

        for (const user of [undefined, renter, ownerA, ownerB, admin]) {
            const res = await detail(user, listing._id);
            const label = user?.name ?? "anonymous";
            assert.equal(res.status, 200, label);
            const { equipment } = res.body;
            assert.equal(equipment._id, listing._id);
            assert.equal(equipment.status, "approved");
            assert.deepEqual(equipment.images, images, label);
            assert.equal(equipment.image, images[0]);
            assert.equal(equipment.imageCount, undefined);
            assertOwnerSummary(equipment.owner, ownerA, label);
            assertNoContactDetails(res.body, `detail as ${label}`);
        }
    });

    for (const state of ["pending", "rejected"]) {
        it(`shows a ${state} listing to its owner and admins only; everyone else gets the same 404 as a missing id`, async () => {
            const listing = state === "pending" ? await create(ownerA) : await rejected(ownerA, {}, "Needs real photos");
            const missing = await detail(undefined, MISSING_ID);
            assert.equal(missing.status, 404);
            assert.deepEqual(missing.body, NOT_FOUND);

            for (const user of [ownerA, admin]) {
                const res = await detail(user, listing._id);
                assert.equal(res.status, 200, user.name);
                assert.equal(res.body.equipment.status, state);
                if (state === "rejected") assert.equal(res.body.equipment.rejectionReason, "Needs real photos");
                assertNoContactDetails(res.body, `${state} detail as ${user.name}`);
            }
            for (const user of [undefined, renter, ownerB]) {
                const res = await detail(user, listing._id);
                assert.equal(res.status, 404, user?.name ?? "anonymous");
                assert.deepEqual(res.body, missing.body);
            }
        });
    }

    it("treats a stale or forged token on a read as anonymous", async () => {
        const owner = await newUser({ role: "owner" });
        const listing = await create(owner);
        assert.equal((await detail(owner, listing._id)).status, 200);
        await logout(owner);

        const tokens = [
            owner.token,
            forge({ id: owner.id, role: "owner", tv: 0 }, "w".repeat(48)),
            forge({ id: owner.id, role: "owner", tv: 0, exp: nowSeconds() - 60 }),
            unsignedToken({ id: admin.id, role: "admin", tv: 0 }),
        ];
        for (const token of tokens) {
            const res = await api(`/api/equipment/${listing._id}`, { token });
            assert.equal(res.status, 404);
            assert.deepEqual(res.body, NOT_FOUND);
        }
        // A role claimed in a validly signed token is not trusted: the database says owner.
        const claimsAdmin = forge({ id: ownerB.id, role: "admin", tv: 0 });
        assert.equal((await api(`/api/equipment/${listing._id}`, { token: claimsAdmin })).status, 404);
    });

    it("still opens an approved listing that its owner switched off", async () => {
        const listing = await unavailable(ownerA);
        const res = await detail(undefined, listing._id);
        assert.equal(res.status, 200);
        assert.equal(res.body.equipment.availability, false);
        assert.ok(!ids(await publicList()).includes(listing._id));
    });

    it("hides a pending listing whose owner account was removed from everyone but admins", async () => {
        const owner = await newUser({ role: "owner" });
        const listing = await create(owner);
        // There is no endpoint that deletes an account.
        await User.deleteOne({ _id: owner.id });

        assert.equal((await detail(ownerA, listing._id)).status, 404);
        const asAdmin = await detail(admin, listing._id);
        assert.equal(asAdmin.status, 200);
        assert.equal(asAdmin.body.equipment.owner, null);
    });

    it("answers 400 to malformed and injection-shaped ids", async () => {
        for (const id of ["not-an-id", MISSING_ID.slice(1), `${MISSING_ID}0`, "zzzzzzzzzzzzzzzzzzzzzzzz", "%7B%22%24ne%22%3A1%7D", "%24where"]) {
            for (const path of [`/api/equipment/${id}`, `/equipment/getone/${id}`]) {
                const res = await api(path, { token: admin.token });
                assert.equal(res.status, 400, path);
                assert.deepEqual(res.body, INVALID_ID);
            }
        }
    });
});

/* ======================================================================= */

describe("PATCH /api/equipment/:id (update)", () => {
    it("lets the owner edit a pending listing; it stays pending and the edit is stored", async () => {
        const listing = await create(ownerA);
        const res = await patch(ownerA, listing._id, {
            title: "  Honda EU22i inverter ",
            price: "18000",
            category: "Electronics",
            specs: ["2.2kVA"],
            availability: false,
        });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.message, "Equipment updated");
        assert.equal(res.body.equipment.title, "Honda EU22i inverter");
        assert.equal(res.body.equipment.status, "pending");
        assertNoContactDetails(res.body, "update response");

        const row = await stored(listing._id);
        assert.equal(row.title, "Honda EU22i inverter");
        assert.equal(row.price, 18000);
        assert.equal(row.category, "Electronics");
        assert.deepEqual(row.specs, ["2.2kVA"]);
        assert.equal(row.availability, false);
        assert.equal(row.status, "pending");
        // Untouched fields keep their values.
        assert.equal(row.description, listing.description);
        assert.deepEqual(row.images, listing.images);
        assert.equal(String(row.owner), ownerA.id);
    });

    it("answers 404 to another owner, 403 to renters and admins, 401 anonymously, and changes nothing", async () => {
        const listing = await approved(ownerA);
        const before = await stored(listing._id);

        for (const path of [`/api/equipment/${listing._id}`, `/equipment/update/${listing._id}`, `/equipment/${listing._id}`]) {
            for (const [user, status, body] of [
                [ownerB, 404, NOT_FOUND],
                [renter, 403, ACCESS_DENIED],
                [admin, 403, ACCESS_DENIED],
                [undefined, 401, NO_TOKEN],
            ]) {
                const res = await patch(user, listing._id, { title: "Hijacked", price: 1, owner: user?.id }, path);
                assert.equal(res.status, status, `${path} as ${user?.name ?? "anonymous"}`);
                assert.deepEqual(res.body, body);
            }
        }
        // A role claimed in the token does not make an owner an admin, nor the listing theirs.
        const claimsAdmin = forge({ id: ownerB.id, role: "admin", tv: 0 });
        assert.equal((await patch({ token: claimsAdmin }, listing._id, { title: "Hijacked" })).status, 404);

        assert.deepEqual(await stored(listing._id), before);
    });

    it("answers 404 for a missing listing and 400 for a malformed id", async () => {
        assert.deepEqual((await patch(ownerA, MISSING_ID, { title: "Nothing" })).body, NOT_FOUND);
        const bad = await patch(ownerA, "not-an-id", { title: "Nothing" });
        assert.equal(bad.status, 400);
        assert.deepEqual(bad.body, INVALID_ID);
    });

    const CONTENT_CHANGES = {
        title: { title: "Renamed generator" },
        "title (legacy name)": { name: "Renamed generator" },
        description: { description: "New carburettor" },
        price: { price: 20000 },
        "price (legacy pricePerDay)": { pricePerDay: 20000 },
        rentalDeposit: { rentalDeposit: 9000 },
        category: { category: "power-tools" },
        condition: { condition: "Fair" },
        location: { location: "Lekki, Lagos" },
        specs: { specs: ["7kVA"] },
        images: { images: [png(2), png(3)] },
        "images (legacy single image)": { image: png(4) },
    };
    for (const [label, change] of Object.entries(CONTENT_CHANGES)) {
        it(`sends an approved listing back to review when ${label} changes`, async () => {
            const listing = await approved(ownerA);
            assert.deepEqual(ids(await publicList()), [listing._id]);

            const res = await patch(ownerA, listing._id, change);
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(res.body.equipment.status, "pending");

            const row = await stored(listing._id);
            assert.equal(row.status, "pending");
            // Off the public list and the public detail until an admin approves it again.
            assert.deepEqual(ids(await publicList()), []);
            assert.equal((await detail(undefined, listing._id)).status, 404);
            assert.equal((await detail(ownerA, listing._id)).status, 200);
        });
    }

    it("keeps the change, the moderation history and re-publishes after a fresh approval", async () => {
        const listing = await approved(ownerA);
        const first = await stored(listing._id);
        assert.equal(String(first.reviewedBy), admin.id);

        await patch(ownerA, listing._id, { price: 21000 });
        assert.equal((await stored(listing._id)).price, 21000);
        await approve(listing._id);

        const res = await publicList();
        assert.deepEqual(ids(res), [listing._id]);
        assert.equal(res.body.equipment[0].price, 21000);
    });

    it("keeps an approved listing approved on an availability-only change, even with status sent along", async () => {
        const listing = await approved(ownerA);

        const off = await patch(ownerA, listing._id, { availability: false, status: "approved" });
        assert.equal(off.status, 200);
        assert.equal(off.body.equipment.status, "approved");
        assert.equal(off.body.equipment.availability, false);
        let row = await stored(listing._id);
        assert.equal(row.status, "approved");
        assert.equal(row.availability, false);
        assert.deepEqual(ids(await publicList()), []);
        assert.deepEqual(ids(await mine(ownerA)), [listing._id]);

        const on = await patch(ownerA, listing._id, { availability: true });
        assert.equal(on.body.equipment.status, "approved");
        row = await stored(listing._id);
        assert.equal(row.status, "approved");
        assert.deepEqual(ids(await publicList()), [listing._id]);
    });

    it("re-reviews when availability changes together with content", async () => {
        const listing = await approved(ownerA);
        const res = await patch(ownerA, listing._id, { availability: false, title: "Generator, now cheaper" });
        assert.equal(res.body.equipment.status, "pending");
        assert.equal((await stored(listing._id)).status, "pending");
    });

    it("does not re-review when the submitted values equal the stored ones", async () => {
        const images = [png(5), png(6)];
        const listing = await approved(ownerA, { title: "Bosch drill", price: 15000, category: "Power Tools", specs: ["18V"], images });
        const res = await patch(ownerA, listing._id, {
            title: "  Bosch drill ",
            price: "15000",
            category: "power-tools",
            specs: ["18V", ""],
            images,
            image: images[1],
            description: listing.description,
            availability: true,
        });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.equipment.status, "approved");
        assert.equal((await stored(listing._id)).status, "approved");
        assert.deepEqual(ids(await publicList()), [listing._id]);

        const empty = await patch(ownerA, listing._id, {});
        assert.equal(empty.status, 200);
        assert.equal((await stored(listing._id)).status, "approved");
    });

    it("sends a rejected listing back to review and clears the rejection reason", async () => {
        const listing = await rejected(ownerA, {}, "Photos are too dark");
        assert.equal((await stored(listing._id)).rejectionReason, "Photos are too dark");

        const res = await patch(ownerA, listing._id, { images: [png(8)] });
        assert.equal(res.body.equipment.status, "pending");
        const row = await stored(listing._id);
        assert.equal(row.status, "pending");
        assert.equal(row.rejectionReason, "");
    });

    it("never lets an owner self-approve or reassign a listing", async () => {
        const pending = await create(ownerA);
        const res = await patch(ownerA, pending._id, {
            status: "approved",
            owner: ownerB.id,
            reviewedBy: ownerA.id,
            reviewedAt: new Date().toISOString(),
            rejectionReason: "",
            _id: MISSING_ID,
        });
        assert.equal(res.status, 200);
        let row = await stored(pending._id);
        assert.equal(row.status, "pending");
        assert.equal(String(row.owner), ownerA.id);
        assert.equal(row.reviewedBy, undefined);
        assert.equal(await Equipment.exists({ _id: MISSING_ID }), null);

        const withContent = await patch(ownerA, pending._id, { status: "approved", title: "Approved by me" });
        assert.equal(withContent.body.equipment.status, "pending");

        const refused = await rejected(ownerA);
        await patch(ownerA, refused._id, { status: "approved", availability: false });
        row = await stored(refused._id);
        assert.equal(row.status, "rejected");
        assert.deepEqual(ids(await publicList()), []);
    });

    it("rejects invalid and injection-shaped values with 400 and leaves the listing untouched", async () => {
        const listing = await approved(ownerA);
        const before = await stored(listing._id);
        const cases = [
            [{ price: -1 }, "price must be a positive number"],
            [{ price: null }, "price must be a positive number"],
            [{ title: { $gt: "" } }, "title must be text"],
            [{ title: null }, "title is required"],
            [{ name: "ab" }, "title must be at least 3 characters"],
            [{ category: { $ne: "" } }, "category must be text"],
            [{ specs: "18V" }, "specs must be a list"],
            [{ availability: "true" }, "availability must be true or false"],
            [{ images: [1, 2, 3, 4, 5, 6, 7].map((fill) => png(fill)) }, "A listing can have at most 6 images"],
            [{ image: "https://evil.example/x.png" }, "image must be an image uploaded through RentIt"],
            [{ title: "Valid new title", price: 0 }, "price must be a positive number"],
        ];
        for (const [body, message] of cases) {
            const res = await patch(ownerA, listing._id, body);
            assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
            assert.deepEqual(res.body, { message });
        }
        assert.deepEqual(await stored(listing._id), before);
    });

    it("appends the legacy single image to the existing images, up to six", async () => {
        const listing = await create(ownerA, { images: [png(1), png(2), png(3), png(4), png(5)] });
        const sixth = png(6);
        let res = await patch(ownerA, listing._id, { image: sixth });
        assert.equal(res.status, 200);
        assert.deepEqual((await stored(listing._id)).images, [png(1), png(2), png(3), png(4), png(5), sixth]);

        res = await patch(ownerA, listing._id, { image: png(7) });
        assert.equal(res.status, 400);
        assert.deepEqual(res.body, { message: "A listing can have at most 6 images" });

        res = await patch(ownerA, listing._id, { images: [] });
        assert.equal(res.status, 200);
        assert.deepEqual((await stored(listing._id)).images, []);
        assert.equal(res.body.equipment.image, "");
    });

    it("refuses stale tokens and a demoted owner, and keeps the listing as it was", async () => {
        const owner = await newUser({ role: "owner" });
        const listing = await create(owner);
        const oldToken = owner.token;
        await changeRole(owner.id, "renter");

        let res = await patch({ token: oldToken }, listing._id, { title: "After demotion" });
        assert.equal(res.status, 401);
        assert.deepEqual(res.body, INVALID_TOKEN);

        const relog = await login(owner.email);
        res = await patch({ token: relog.body.token }, listing._id, { title: "After demotion" });
        assert.equal(res.status, 403);
        assert.deepEqual(res.body, ACCESS_DENIED);

        await logout({ token: relog.body.token });
        res = await patch({ token: relog.body.token }, listing._id, { title: "After logout" });
        assert.equal(res.status, 401);

        assert.equal((await stored(listing._id)).title, listing.title);
    });

    it("answers 413 to an update body over 8mb and 401 to an anonymous large body", async () => {
        const listing = await create(ownerA);
        const huge = await patch(ownerA, listing._id, { description: "d".repeat(8.5 * 1024 * 1024) });
        assert.equal(huge.status, 413);
        assert.deepEqual(huge.body, TOO_LARGE);

        const anonymous = await patch(undefined, listing._id, { description: "d".repeat(2 * 1024 * 1024) });
        assert.equal(anonymous.status, 401);
        assert.equal((await stored(listing._id)).description, listing.description);
    });
});

/* ======================================================================= */

describe("DELETE /api/equipment/:id", () => {
    it("lets the owner delete their own listing, after which it is gone everywhere", async () => {
        const listing = await approved(ownerA);
        const keep = await approved(ownerA);

        const res = await remove(ownerA, listing._id);
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { message: "Equipment deleted" });

        assert.equal(await stored(listing._id), null);
        assert.ok(await stored(keep._id));
        assert.equal((await detail(undefined, listing._id)).status, 404);
        assert.equal((await detail(ownerA, listing._id)).status, 404);
        assert.deepEqual(ids(await publicList()), [keep._id]);
        assert.deepEqual(ids(await mine(ownerA)), [keep._id]);

        const again = await remove(ownerA, listing._id);
        assert.equal(again.status, 404);
        assert.deepEqual(again.body, NOT_FOUND);
    });

    it("answers 404 to another owner, 403 to renters, 401 anonymously or with a stale token, and keeps the listing", async () => {
        const listing = await create(ownerA);
        const loggedOut = await newUser({ role: "owner" });
        await logout(loggedOut);
        const claimsAdmin = { name: "owner claiming admin", token: forge({ id: ownerB.id, role: "admin", tv: 0 }) };

        for (const path of [`/api/equipment/${listing._id}`, `/equipment/delete/${listing._id}`, `/equipment/${listing._id}`]) {
            for (const [user, status, body] of [
                [ownerB, 404, NOT_FOUND],
                [claimsAdmin, 404, NOT_FOUND],
                [renter, 403, ACCESS_DENIED],
                [undefined, 401, NO_TOKEN],
                [loggedOut, 401, INVALID_TOKEN],
            ]) {
                const res = await remove(user, listing._id, path);
                assert.equal(res.status, status, `${path} as ${user?.name ?? "anonymous"}`);
                assert.deepEqual(res.body, body);
            }
        }
        assert.ok(await stored(listing._id));
    });

    it("lets an admin delete any listing, in any status", async () => {
        const pending = await create(ownerA);
        const live = await approved(ownerB);
        const refused = await rejected(ownerB);

        for (const listing of [pending, live, refused]) {
            const res = await remove(admin, listing._id);
            assert.equal(res.status, 200, JSON.stringify(res.body));
        }
        assert.equal(await Equipment.countDocuments(), 0);
        assert.deepEqual((await remove(admin, MISSING_ID)).body, NOT_FOUND);
    });

    it("answers 400 to a malformed id", async () => {
        for (const id of ["not-an-id", "%7B%22%24ne%22%3A1%7D"]) {
            const res = await remove(admin, id);
            assert.equal(res.status, 400, id);
            assert.deepEqual(res.body, INVALID_ID);
        }
    });
});

/* ======================================================================= */

describe("legacy /equipment aliases", () => {
    it("/equipment/getall answers exactly like /api/equipment, filters and privacy included", async () => {
        await create(ownerA);
        await approved(ownerA, { title: "Makita drill", category: "power-tools" });
        await approved(ownerB, { title: "Canon camera", category: "Camera & Photography" });

        for (const query of ["", "?q=drill", "?category=camera-photography", "?limit=1&page=2"]) {
            const clean = await publicList(query);
            assert.equal(clean.status, 200);
            for (const path of ["/equipment/getall", "/api/equipment/getall", "/equipment"]) {
                const legacy = await publicList(query, undefined, path);
                assert.equal(legacy.status, 200, path + query);
                assert.deepEqual(legacy.body, clean.body, path + query);
                assertNoContactDetails(legacy.body, path + query);
            }
        }
        assert.equal((await publicList("?q=a&q=b", undefined, "/equipment/getall")).status, 400);
    });

    it("/equipment/getone/:id applies the same visibility as /api/equipment/:id", async () => {
        const pending = await create(ownerA);
        const live = await approved(ownerA, { images: [png(1), png(2)] });

        for (const path of [`/equipment/getone/${live._id}`, `/api/equipment/getone/${live._id}`]) {
            const legacy = await detail(undefined, live._id, path);
            assert.equal(legacy.status, 200);
            assert.deepEqual(legacy.body, (await detail(undefined, live._id)).body);
            assert.equal(legacy.body.equipment.images.length, 2);
        }
        const path = `/equipment/getone/${pending._id}`;
        assert.equal((await detail(undefined, pending._id, path)).status, 404);
        assert.equal((await detail(ownerB, pending._id, path)).status, 404);
        assert.equal((await detail(renter, pending._id, path)).status, 404);
        assert.equal((await detail(ownerA, pending._id, path)).status, 200);
        assert.equal((await detail(admin, pending._id, path)).status, 200);
        assert.deepEqual((await detail(undefined, MISSING_ID, `/equipment/getone/${MISSING_ID}`)).body, NOT_FOUND);
    });

    it("/equipment/create accepts the legacy field names and applies the same rules", async () => {
        const image = png(3);
        const res = await post(
            ownerA,
            { name: "Legacy drill", pricePerDay: "7000", image, status: "approved", owner: ownerB.id },
            "/equipment/create"
        );
        assert.equal(res.status, 201, JSON.stringify(res.body));
        const row = await stored(res.body.equipment._id);
        assert.equal(row.title, "Legacy drill");
        assert.equal(row.price, 7000);
        assert.deepEqual(row.images, [image]);
        assert.equal(row.status, "pending");
        assert.equal(String(row.owner), ownerA.id);

        // Same root path on the legacy mount.
        const root = await post(ownerA, listingBody({ status: "approved" }), "/equipment");
        assert.equal(root.status, 201);
        assert.equal(root.body.equipment.status, "pending");

        for (const [user, status] of [[renter, 403], [admin, 403], [undefined, 401]]) {
            assert.equal((await post(user, listingBody(), "/equipment/create")).status, status);
        }
        assert.equal((await post(ownerA, listingBody({ title: { $gt: "" } }), "/equipment/create")).status, 400);
        assert.equal(await Equipment.countDocuments(), 2);
    });

    it("/equipment/update/:id applies ownership and the re-review rule", async () => {
        const listing = await approved(ownerA);
        const path = `/equipment/update/${listing._id}`;

        assert.deepEqual((await patch(ownerB, listing._id, { title: "Mine now" }, path)).body, NOT_FOUND);

        const availability = await patch(ownerA, listing._id, { availability: false }, path);
        assert.equal(availability.status, 200);
        assert.equal(availability.body.equipment.status, "approved");

        const content = await patch(ownerA, listing._id, { pricePerDay: 99 }, path);
        assert.equal(content.status, 200);
        assert.equal(content.body.equipment.status, "pending");
        const row = await stored(listing._id);
        assert.equal(row.price, 99);
        assert.equal(row.status, "pending");
    });

    it("/equipment/delete/:id lets the owner and admins delete and nobody else", async () => {
        const a = await create(ownerA);
        const b = await approved(ownerB);
        assert.equal((await remove(ownerB, a._id, `/equipment/delete/${a._id}`)).status, 404);
        assert.equal((await remove(renter, a._id, `/equipment/delete/${a._id}`)).status, 403);
        assert.equal((await remove(ownerA, a._id, `/equipment/delete/${a._id}`)).status, 200);
        assert.equal((await remove(admin, b._id, `/equipment/delete/${b._id}`)).status, 200);
        assert.equal(await Equipment.countDocuments(), 0);
    });
});

/* ======================================================================= */

describe("GET /api/categories", () => {
    it("serves the fixed catalogue on every path, without authentication", async () => {
        const expected = CATALOGUE.map(([name, slug]) => ({ id: slug, name, slug }));
        for (const path of ["/api/categories", "/api/categories/getall", "/category", "/category/getall"]) {
            for (const user of [undefined, renter, { token: "garbage" }]) {
                const res = await api(path, { token: user?.token });
                assert.equal(res.status, 200, path);
                assert.deepEqual(res.body, { categories: expected }, path);
            }
        }
    });

    it("is read-only", async () => {
        for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
            const res = await api("/api/categories", { method, token: admin.token, json: { name: "Boats" } });
            assert.equal(res.status, 404, method);
        }
        assert.equal((await api("/category/getall")).body.categories.length, 8);
    });
});

/* ======================================================================= */

describe("POST /api/uploads/sign", () => {
    const sign = (user, json = { purpose: "equipment" }) => api("/api/uploads/sign", { method: "POST", token: user?.token, json });

    it("answers 503 to owners and admins while Cloudinary is not configured", async () => {
        assert.equal(env.cloudinary.enabled, false, "precondition: these tests expect no CLOUDINARY_* configuration");
        for (const user of [ownerA, admin]) {
            const res = await sign(user);
            assert.equal(res.status, 503, user.name);
            assert.deepEqual(res.body, UPLOADS_OFF);
        }
    });

    it("refuses anonymous callers and stale tokens (401) and renters (403)", async () => {
        const loggedOut = await newUser({ role: "owner" });
        await logout(loggedOut);

        for (const [user, status, body] of [
            [undefined, 401, NO_TOKEN],
            [loggedOut, 401, INVALID_TOKEN],
            [{ token: forge({ id: ownerA.id, role: "owner", tv: 0 }, "v".repeat(48)) }, 401, INVALID_TOKEN],
            [renter, 403, ACCESS_DENIED],
            [{ token: forge({ id: renter.id, role: "owner", tv: 0 }) }, 403, ACCESS_DENIED],
        ]) {
            const res = await sign(user);
            assert.equal(res.status, status, user?.name ?? "token");
            assert.deepEqual(res.body, body);
        }
    });

    it("validates the purpose before anything else and caps the body at 100kb", async () => {
        for (const json of [{}, { purpose: "avatar" }, { purpose: { $ne: "" } }, { purpose: ["equipment"] }]) {
            const res = await sign(ownerA, json);
            assert.equal(res.status, 400, JSON.stringify(json));
            assert.deepEqual(res.body, { message: "purpose must be one of: equipment" });
        }
        const big = await sign(ownerA, { purpose: "equipment", pad: "p".repeat(150 * 1024) });
        assert.equal(big.status, 413);
        assert.deepEqual(big.body, TOO_LARGE);
    });
});
