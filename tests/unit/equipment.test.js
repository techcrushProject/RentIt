import "../helpers/setEnv.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { after, afterEach, before, describe, it, mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HttpError } from "../../utils/httpError.js";

// config/env.js reads the environment once, at import time, so Cloudinary has to
// be configured before any app module loads. Everything below is imported dynamically for that reason.
const CLOUD_NAME = "demo-cloud";
const API_KEY = "123456789012345";
const API_SECRET = "super-secret-api-secret";
process.env.CLOUDINARY_CLOUD_NAME = CLOUD_NAME;
process.env.CLOUDINARY_API_KEY = API_KEY;
process.env.CLOUDINARY_API_SECRET = API_SECRET;

const { default: Equipment, MAX_IMAGES } = await import("../../Models/equipment.js");
const { CATEGORIES } = await import("../../config/categories.js");
const { signParams } = await import("../../utils/cloudinarySign.js");
const controller = await import("../../Controllers/equipmentController.js");
const { default: equipmentRouter } = await import("../../Routes/equipmentRoutes.js");
const { default: protect, optionalAuth } = await import("../../Middleware/authMiddleware.js");
const { createApp } = await import("../../app.js");

const { createEquipment, deleteEquipment, getEquipment, getMyEquipment, listEquipment, updateEquipment } = controller;

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const USER_ID = "64b7f0c2a1b2c3d4e5f60718";
const OTHER_ID = "64b7f0c2a1b2c3d4e5f60719";
const ADMIN_ID = "64b7f0c2a1b2c3d4e5f60721";
const LISTING_ID = "64b7f0c2a1b2c3d4e5f60720";

const ownerUser = { id: USER_ID, role: "owner" };
const otherOwner = { id: OTHER_ID, role: "owner" };
const adminUser = { id: ADMIN_ID, role: "admin" };
const renterUser = { id: OTHER_ID, role: "renter" };

/* ---------- helpers ---------- */

// Stubs are plain assignments onto the real model, undone after every test.
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

/** Any database call fails the test: proves a request was refused before it got that far. */
function forbidDatabase() {
    for (const name of ["create", "find", "findOne", "findById", "countDocuments", "deleteOne", "updateOne"]) {
        stub(Equipment, name, () => {
            throw new Error(`unexpected database call: Equipment.${name}`);
        });
    }
}

/** A chainable stand-in for a Mongoose query: records the chain and resolves to `result` when awaited. */
function fakeQuery(result) {
    const calls = {};
    const query = {
        calls,
        sort: (arg) => ((calls.sort = arg), query),
        skip: (arg) => ((calls.skip = arg), query),
        limit: (arg) => ((calls.limit = arg), query),
        populate: (...args) => ((calls.populate = args), query),
        then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    };
    return query;
}

function fakeRes() {
    return {
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

async function run(handler, req) {
    const res = fakeRes();
    await handler({ params: {}, query: {}, body: {}, ...req }, res);
    return res;
}

/** Runs a handler that must refuse the request, and returns the HttpError it threw. */
async function refused(handler, req) {
    try {
        await run(handler, req);
    } catch (err) {
        assert.ok(err instanceof HttpError, `expected an HttpError, got: ${err?.stack ?? err}`);
        return err;
    }
    return assert.fail("expected the handler to throw an HttpError");
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A structurally valid PNG data URL of `bytes` decoded bytes; `fill` makes different images differ. */
const pngDataUrl = (bytes = 16, fill = 1) =>
    `data:image/png;base64,${Buffer.concat([PNG_SIGNATURE, Buffer.alloc(bytes - PNG_SIGNATURE.length, fill)]).toString("base64")}`;

const IMG_A = pngDataUrl(16, 1);
const IMG_B = pngDataUrl(24, 2);
const cloudinaryUrl = (name = "a.jpg") => `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/v1/rentit/equipment/${USER_ID}/${name}`;

const sha1 = (text) => createHash("sha1").update(text).digest("hex");

/** A real (unsaved) document, so Mongoose does the change tracking and casting. */
function listing(overrides = {}) {
    const doc = new Equipment({
        _id: LISTING_ID,
        title: "Honda generator",
        description: "5kVA petrol generator",
        price: 15000,
        rentalDeposit: 5000,
        category: "Equipments",
        condition: "Brand new",
        location: "Lagos",
        specs: ["5kVA"],
        images: [IMG_A],
        availability: true,
        owner: USER_ID,
        status: "approved",
        rejectionReason: "",
        reviewedBy: ADMIN_ID,
        reviewedAt: new Date("2025-01-01T00:00:00Z"),
        ...overrides,
    });
    doc.save = mock.fn(async () => doc);
    return doc;
}

/* ---------- Cloudinary signature ---------- */

describe("signParams", () => {
    it("signs the Cloudinary documentation example", () => {
        const eager = "w_400,h_300,c_pad|w_260,h_200,c_crop";
        const withEager = signParams({ eager, public_id: "sample_image", timestamp: 1315060510 }, "abcd");
        // Independently: printf 'eager=...&public_id=sample_image&timestamp=1315060510abcd' | sha1sum
        assert.equal(withEager, "bfd09f95f331f558cbd1320e67aa8d488770583e");

        // b4ad47fb... is the digest of the same example WITHOUT the eager parameter.
        const withoutEager = signParams({ public_id: "sample_image", timestamp: 1315060510 }, "abcd");
        assert.equal(withoutEager, "b4ad47fb4e25c7bf5f92a20089f9db59bc302313");
    });

    it("drops empty values, sorts keys alphabetically and appends the secret", () => {
        const params = { timestamp: 10, folder: "f", empty: "", nothing: undefined, missing: null, allowed_formats: "jpg" };
        assert.equal(signParams(params, "s3cret"), sha1("allowed_formats=jpg&folder=f&timestamp=10s3cret"));
        assert.deepEqual(Object.keys(params), ["timestamp", "folder", "empty", "nothing", "missing", "allowed_formats"]);
    });

    it("keeps zero and false, which are real values", () => {
        assert.equal(signParams({ a: 0, b: false }, "k"), sha1("a=0&b=falsek"));
    });
});

/* ---------- signUpload (env is frozen at import, so each configuration runs in a child process) ---------- */

/** Runs signUpload once per body in a fresh process whose environment holds exactly `cloudinary`. */
function runSignUpload(cloudinary, bodies, userId = USER_ID) {
    const script = `
        import { signUpload } from ${JSON.stringify(pathToFileURL(`${ROOT}/Controllers/uploadController.js`).href)};
        const results = [];
        for (const body of JSON.parse(process.env.SIGN_BODIES)) {
            const res = { status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
            try {
                signUpload({ user: { id: process.env.SIGN_USER }, body }, res);
                results.push({ status: res.statusCode, body: res.body });
            } catch (err) {
                results.push({ status: err.status, body: { message: err.message } });
            }
        }
        console.log(JSON.stringify(results));
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        // cwd outside the repo so a developer's .env cannot leak into the child.
        cwd: tmpdir(),
        encoding: "utf8",
        timeout: 30_000,
        env: {
            PATH: process.env.PATH,
            NODE_ENV: "test",
            MONGO_URI: process.env.MONGO_URI,
            JWT_SECRET: process.env.JWT_SECRET,
            ...cloudinary,
            SIGN_BODIES: JSON.stringify(bodies),
            SIGN_USER: userId,
        },
    });
    assert.equal(child.status, 0, child.stderr);
    return { results: JSON.parse(child.stdout), output: child.stdout + child.stderr };
}

describe("signUpload", () => {
    const configured = {
        CLOUDINARY_CLOUD_NAME: CLOUD_NAME,
        CLOUDINARY_API_KEY: API_KEY,
        CLOUDINARY_API_SECRET: API_SECRET,
    };

    it("signs a server-chosen folder for the caller and never reveals the secret", () => {
        const started = Math.floor(Date.now() / 1000);
        const { results, output } = runSignUpload(configured, [
            { purpose: "equipment" },
            // A client-chosen folder or format must be ignored.
            { purpose: "equipment", folder: "../../admin", allowed_formats: "exe", timestamp: 1 },
        ]);
        const finished = Math.floor(Date.now() / 1000);

        for (const { status, body } of results) {
            assert.equal(status, 200);
            assert.deepEqual(Object.keys(body).sort(), [
                "allowedFormats",
                "apiKey",
                "cloudName",
                "folder",
                "maxBytes",
                "signature",
                "timestamp",
                "uploadUrl",
            ]);
            assert.equal(body.cloudName, CLOUD_NAME);
            assert.equal(body.apiKey, API_KEY);
            assert.equal(body.folder, `rentit/equipment/${USER_ID}`);
            assert.equal(body.allowedFormats, "jpg,jpeg,png,webp");
            assert.equal(body.uploadUrl, `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`);
            assert.equal(body.maxBytes, 5 * 1024 * 1024);
            assert.ok(Number.isInteger(body.timestamp) && body.timestamp >= started && body.timestamp <= finished);
            // Recomputed here from the documented algorithm, not with the code under test.
            assert.equal(
                body.signature,
                sha1(`allowed_formats=jpg,jpeg,png,webp&folder=rentit/equipment/${USER_ID}&timestamp=${body.timestamp}${API_SECRET}`)
            );
            assert.ok(!JSON.stringify(body).includes(API_SECRET));
        }
        assert.ok(!output.includes(API_SECRET), "the API secret must not be printed or logged");
    });

    it("uses the id of the authenticated user in the folder", () => {
        const { results } = runSignUpload(configured, [{ purpose: "equipment" }], OTHER_ID);
        assert.equal(results[0].body.folder, `rentit/equipment/${OTHER_ID}`);
    });

    it("rejects any purpose other than equipment", () => {
        const { results } = runSignUpload(configured, [
            {},
            { purpose: "kyc" },
            { purpose: ["equipment"] },
            { purpose: { $ne: "" } },
            { purpose: 1 },
        ]);
        for (const { status, body } of results) {
            assert.equal(status, 400);
            assert.match(body.message, /purpose/);
        }
    });

    it("answers 503 when Cloudinary is not configured", () => {
        const { results, output } = runSignUpload({}, [{ purpose: "equipment" }]);
        assert.deepEqual(results[0], { status: 503, body: { message: "Image uploads are not configured" } });
        assert.ok(!output.includes(API_SECRET));
    });
});

/* ---------- model ---------- */

describe("Equipment model", () => {
    const valid = () => new Equipment({ title: "Drill", price: 100, owner: USER_ID });

    it("starts pending, available and with empty optional fields", () => {
        const doc = valid();
        assert.equal(doc.validateSync(), undefined);
        assert.equal(doc.status, "pending");
        assert.equal(doc.availability, true);
        assert.equal(doc.rentalDeposit, 0);
        assert.equal(doc.description, "");
        assert.equal(doc.rejectionReason, "");
        assert.deepEqual([...doc.specs], []);
        assert.deepEqual([...doc.images], []);
    });

    it("enforces the field bounds", () => {
        const cases = [
            ["title", { title: "ab" }],
            ["title", { title: "x".repeat(121) }],
            ["title", { title: "" }],
            ["price", { price: 0 }],
            ["price", { price: -5 }],
            ["price", { price: undefined }],
            ["rentalDeposit", { rentalDeposit: -1 }],
            ["description", { description: "x".repeat(2001) }],
            ["category", { category: "x".repeat(61) }],
            ["condition", { condition: "x".repeat(41) }],
            ["location", { location: "x".repeat(121) }],
            ["rejectionReason", { rejectionReason: "x".repeat(501) }],
            ["status", { status: "published" }],
            ["owner", { owner: undefined }],
            ["specs", { specs: Array.from({ length: 21 }, (_, i) => `spec ${i}`) }],
            ["specs.0", { specs: ["x".repeat(101)] }],
            ["images", { images: Array.from({ length: MAX_IMAGES + 1 }, (_, i) => `image-${i}`) }],
        ];
        for (const [path, overrides] of cases) {
            const doc = new Equipment({ title: "Drill", price: 100, owner: USER_ID, ...overrides });
            const error = doc.validateSync();
            assert.ok(error?.errors[path], `${path} should be invalid for ${JSON.stringify(overrides).slice(0, 60)}`);
        }
    });

    it("accepts values at the limits", () => {
        const doc = new Equipment({
            title: "abc",
            price: 0.01,
            owner: USER_ID,
            description: "x".repeat(2000),
            category: "x".repeat(60),
            condition: "x".repeat(40),
            location: "x".repeat(120),
            specs: Array.from({ length: 20 }, () => "x".repeat(100)),
            images: Array.from({ length: MAX_IMAGES }, (_, i) => `image-${i}`),
        });
        assert.equal(doc.validateSync(), undefined);
    });

    it("adds name, pricePerDay and image to JSON and removes __v", () => {
        const doc = Equipment.hydrate({
            _id: LISTING_ID,
            title: "Honda generator",
            price: 15000,
            images: [IMG_A, IMG_B],
            owner: USER_ID,
            __v: 3,
        });
        const json = JSON.parse(JSON.stringify(doc));
        assert.equal(json.name, "Honda generator");
        assert.equal(json.pricePerDay, 15000);
        assert.equal(json.image, IMG_A);
        assert.equal(json.title, "Honda generator");
        assert.equal(json.price, 15000);
        assert.ok(!("__v" in json));
    });

    it("gives an empty image string when there are no images", () => {
        assert.equal(JSON.parse(JSON.stringify(valid())).image, "");
    });

    it("still shows the single image of listings created before `images` existed", () => {
        const doc = Equipment.hydrate({ _id: LISTING_ID, title: "Old", price: 1, image: "data:image/png;base64,AAAA", owner: USER_ID });
        assert.equal(JSON.parse(JSON.stringify(doc)).image, "data:image/png;base64,AAAA");
    });

    it("indexes the public listing query and the owner", () => {
        const indexes = Equipment.schema.indexes().map(([fields]) => fields);
        assert.deepEqual(indexes.find((fields) => "availability" in fields), { status: 1, availability: 1, createdAt: -1 });
        assert.ok(indexes.some((fields) => fields.owner === 1));
        assert.ok(indexes.some((fields) => fields.status === 1 && Object.keys(fields).length === 1));
    });

    it("does not recompile when imported twice", async () => {
        const again = await import("../../Models/equipment.js?again");
        assert.equal(again.default, Equipment);
    });
});

/* ---------- catalogue ---------- */

describe("category catalogue", () => {
    it("keeps the exact names used by the onboarding screens", () => {
        assert.deepEqual(
            CATEGORIES.map((c) => c.name),
            [
                "Equipments",
                "Power Tools",
                "Properties",
                "Camera & Photography",
                "Event & Party Items",
                "Electronics",
                "Furnitures",
                "More",
            ]
        );
    });

    it("uses the slug as a stable id", () => {
        for (const category of CATEGORIES) {
            assert.deepEqual(Object.keys(category).sort(), ["id", "name", "slug"]);
            assert.equal(category.id, category.slug);
            assert.match(category.slug, /^[a-z]+(-[a-z]+)*$/);
        }
        assert.equal(new Set(CATEGORIES.map((c) => c.slug)).size, CATEGORIES.length);
        assert.equal(CATEGORIES.find((c) => c.name === "Camera & Photography").slug, "camera-photography");
    });
});

/* ---------- listEquipment ---------- */

describe("listEquipment", () => {
    function stubList(docs = [], total = docs.length) {
        const state = { filters: [], counts: [], query: undefined };
        stub(Equipment, "find", (filter) => {
            state.filters.push(filter);
            state.query = fakeQuery(docs);
            return state.query;
        });
        stub(Equipment, "countDocuments", async (filter) => {
            state.counts.push(filter);
            return total;
        });
        return state;
    }

    const PUBLIC_FILTER = { status: "approved", availability: { $ne: false } };

    it("shows the public only approved, available listings, newest first, owner name only", async () => {
        const docs = [{ title: "a" }, { title: "b" }];
        const state = stubList(docs, 42);

        const res = await run(listEquipment, {});

        assert.equal(res.statusCode, 200);
        // List views carry a thumbnail list plus the full image count.
        assert.deepEqual(res.body, { equipment: docs.map((d) => ({ ...d, images: [], imageCount: 0 })), page: 1, limit: 20, total: 42 });
        assert.deepEqual(state.filters, [PUBLIC_FILTER]);
        assert.deepEqual(state.counts, [PUBLIC_FILTER]);
        assert.deepEqual(state.query.calls.sort, { createdAt: -1, _id: -1 });
        assert.equal(state.query.calls.skip, 0);
        assert.equal(state.query.calls.limit, 20);
        // The select string is the whole privacy guarantee: no email, no phone.
        assert.deepEqual(state.query.calls.populate, ["owner", "name businessName"]);
        assert.ok(!/email|phone/.test(state.query.calls.populate[1]));
    });

    it("paginates with a hard ceiling", async () => {
        const state = stubList();
        const res = await run(listEquipment, { query: { page: "3", limit: "500" } });
        assert.equal(res.body.page, 3);
        assert.equal(res.body.limit, 100);
        assert.equal(state.query.calls.skip, 200);
        assert.equal(state.query.calls.limit, 100);
    });

    it("applies the text, category, location and price filters", async () => {
        const state = stubList();
        await run(listEquipment, {
            query: { q: "drill", category: "power-tools", location: "Lagos", minPrice: "1000", maxPrice: "5000" },
        });

        const [filter] = state.filters;
        assert.equal(filter.status, "approved");
        assert.deepEqual(filter.availability, { $ne: false });
        assert.equal(filter.$or.length, 3);
        assert.deepEqual(filter.$or.map((clause) => Object.keys(clause)[0]), ["title", "description", "category"]);
        for (const clause of filter.$or) {
            const pattern = Object.values(clause)[0];
            assert.ok(pattern instanceof RegExp);
            assert.equal(pattern.source, "drill");
            assert.equal(pattern.flags, "i");
        }
        // The catalogue slug is mapped to the stored name.
        assert.equal(filter.category, "Power Tools");
        assert.ok(filter.location instanceof RegExp && filter.location.test("lagos island"));
        assert.deepEqual(filter.price, { $gte: 1000, $lte: 5000 });
    });

    it("supports a one-sided price range and free-text categories", async () => {
        const state = stubList();
        await run(listEquipment, { query: { maxPrice: "0", category: "Welders" } });
        assert.deepEqual(state.filters[0].price, { $lte: 0 });
        assert.equal(state.filters[0].category, "Welders");
    });

    it("escapes regular-expression characters in q and location", async () => {
        const state = stubList();
        await run(listEquipment, { query: { q: "a.b(c)*+?[x]|^$\\", location: "(.*)" } });

        const [filter] = state.filters;
        const pattern = filter.$or[0].title;
        assert.ok(pattern.test("A.B(C)*+?[X]|^$\\"));
        assert.ok(!pattern.test("axb(c)"));
        assert.ok(!filter.location.test("anything"));
        assert.ok(filter.location.test("(.*)"));
    });

    it("answers 400 when a query value is not a plain string", async () => {
        forbidDatabase();
        const bad = [
            { q: ["a", "b"] },
            { q: { $ne: "" } },
            { q: "x".repeat(61) },
            { category: ["a"] },
            { category: { $gt: "" } },
            { location: ["Lagos"] },
            { location: { $regex: ".*" } },
            { minPrice: ["1"] },
            { minPrice: "abc" },
            { minPrice: "-1" },
            { maxPrice: { $gt: 1 } },
            { maxPrice: "Infinity" },
        ];
        for (const query of bad) {
            const err = await refused(listEquipment, { query });
            assert.equal(err.status, 400, JSON.stringify(query));
        }
    });

    it("lets only an admin choose the status", async () => {
        const state = stubList();

        await run(listEquipment, { user: adminUser, query: { status: "pending" } });
        await run(listEquipment, { user: adminUser, query: { status: "REJECTED" } });
        await run(listEquipment, { user: adminUser, query: { status: "all" } });
        await run(listEquipment, { user: adminUser, query: {} });
        // Everyone else gets the public view whatever they ask for.
        await run(listEquipment, { user: ownerUser, query: { status: "pending" } });
        await run(listEquipment, { user: renterUser, query: { status: "all" } });
        await run(listEquipment, { query: { status: "rejected" } });

        assert.deepEqual(state.filters, [
            { status: "pending" },
            { status: "rejected" },
            {},
            PUBLIC_FILTER,
            PUBLIC_FILTER,
            PUBLIC_FILTER,
            PUBLIC_FILTER,
        ]);
    });

    it("rejects an unknown or non-string status from an admin", async () => {
        forbidDatabase();
        for (const status of ["published", ["pending"], { $ne: "approved" }]) {
            const err = await refused(listEquipment, { user: adminUser, query: { status } });
            assert.equal(err.status, 400);
        }
    });
});

describe("getMyEquipment", () => {
    it("lists every status of the caller's own listings only", async () => {
        const filters = [];
        const docs = [{ status: "pending" }, { status: "rejected" }];
        let query;
        stub(Equipment, "find", (filter) => {
            filters.push(filter);
            query = fakeQuery(docs);
            return query;
        });
        stub(Equipment, "countDocuments", async (filter) => {
            filters.push(filter);
            return 2;
        });

        const res = await run(getMyEquipment, { user: ownerUser, query: { page: "2", limit: "5" } });

        assert.deepEqual(filters, [{ owner: USER_ID }, { owner: USER_ID }]);
        assert.deepEqual(res.body, { equipment: docs.map((d) => ({ ...d, images: [], imageCount: 0 })), page: 2, limit: 5, total: 2 });
        assert.equal(query.calls.skip, 5);
        assert.deepEqual(query.calls.sort, { createdAt: -1, _id: -1 });
    });
});

/* ---------- getEquipment ---------- */

describe("getEquipment", () => {
    const withStatus = (status) => ({ status, owner: { _id: USER_ID, name: "Ada" } });

    function stubFind(doc) {
        const ids = [];
        stub(Equipment, "findById", (id) => {
            ids.push(id);
            return fakeQuery(doc);
        });
        return ids;
    }

    const viewers = {
        anonymous: undefined,
        "another renter": renterUser,
        "another owner": otherOwner,
        "the owner": ownerUser,
        "an admin": adminUser,
    };
    const canSee = {
        anonymous: ["approved"],
        "another renter": ["approved"],
        "another owner": ["approved"],
        "the owner": ["approved", "pending", "rejected"],
        "an admin": ["approved", "pending", "rejected"],
    };

    for (const [viewer, user] of Object.entries(viewers)) {
        for (const status of ["approved", "pending", "rejected"]) {
            const allowed = canSee[viewer].includes(status);
            it(`${allowed ? "shows" : "hides"} a ${status} listing ${allowed ? "to" : "from"} ${viewer}`, async () => {
                const doc = withStatus(status);
                stubFind(doc);
                if (allowed) {
                    const res = await run(getEquipment, { user, params: { id: LISTING_ID } });
                    assert.equal(res.statusCode, 200);
                    assert.equal(res.body.equipment, doc);
                } else {
                    const err = await refused(getEquipment, { user, params: { id: LISTING_ID } });
                    assert.equal(err.status, 404);
                    assert.equal(err.message, "Equipment not found");
                }
            });
        }
    }

    it("gives a missing listing the same answer as a hidden one", async () => {
        stubFind(null);
        const err = await refused(getEquipment, { user: adminUser, params: { id: LISTING_ID } });
        assert.equal(err.status, 404);
        assert.equal(err.message, "Equipment not found");
    });

    it("recognises the owner when the reference is not populated", async () => {
        stubFind(listing({ status: "pending" }));
        const res = await run(getEquipment, { user: ownerUser, params: { id: LISTING_ID } });
        assert.equal(res.statusCode, 200);
        const err = await refused(getEquipment, { user: otherOwner, params: { id: LISTING_ID } });
        assert.equal(err.status, 404);
    });

    it("populates the owner with name and businessName only", async () => {
        let query;
        stub(Equipment, "findById", () => ((query = fakeQuery(withStatus("approved"))), query));
        await run(getEquipment, { params: { id: LISTING_ID } });
        assert.deepEqual(query.calls.populate, ["owner", "name businessName"]);
    });

    it("validates the id before touching the database", async () => {
        forbidDatabase();
        for (const id of ["abc", "{}", "64b7f0c2a1b2c3d4e5f6071", `${LISTING_ID}0`, ["x"], { $ne: "" }, undefined]) {
            const err = await refused(getEquipment, { params: { id } });
            assert.equal(err.status, 400);
        }
    });
});

/* ---------- createEquipment ---------- */

describe("createEquipment", () => {
    function stubCreate() {
        const created = [];
        stub(Equipment, "create", async (data) => {
            created.push(data);
            return { _id: LISTING_ID, ...data };
        });
        return created;
    }

    const base = { title: "Honda generator", price: 15000 };

    it("creates a pending listing owned by the caller", async () => {
        const created = stubCreate();
        const res = await run(createEquipment, {
            user: ownerUser,
            body: {
                title: "  Honda generator  ",
                description: "5kVA",
                price: "15000",
                rentalDeposit: 5000,
                category: "Equipments",
                condition: "Brand new",
                location: "Lagos",
                specs: ["5kVA", "  ", "Petrol"],
                images: [IMG_A],
                availability: false,
            },
        });

        assert.equal(res.statusCode, 201);
        assert.equal(res.body.message, "Equipment listing created");
        assert.deepEqual(created, [
            {
                title: "Honda generator",
                description: "5kVA",
                price: 15000,
                rentalDeposit: 5000,
                category: "Equipments",
                condition: "Brand new",
                location: "Lagos",
                specs: ["5kVA", "Petrol"],
                images: [IMG_A],
                availability: false,
                owner: USER_ID,
                status: "pending",
            },
        ]);
        assert.equal(res.body.equipment._id, LISTING_ID);
    });

    it("only sends the fields the client provided", async () => {
        const created = stubCreate();
        await run(createEquipment, { user: ownerUser, body: base });
        assert.deepEqual(created, [{ title: "Honda generator", price: 15000, owner: USER_ID, status: "pending" }]);
    });

    it("ignores status, owner and review fields sent by the client", async () => {
        const created = stubCreate();
        await run(createEquipment, {
            user: ownerUser,
            body: {
                ...base,
                status: "approved",
                owner: OTHER_ID,
                reviewedBy: OTHER_ID,
                reviewedAt: "2020-01-01",
                rejectionReason: "nope",
                _id: OTHER_ID,
                createdAt: "2020-01-01",
                __proto__: { admin: true },
                $set: { status: "approved" },
            },
        });
        assert.deepEqual(Object.keys(created[0]).sort(), ["owner", "price", "status", "title"]);
        assert.equal(created[0].owner, USER_ID);
        assert.equal(created[0].status, "pending");
    });

    it("accepts the legacy name and pricePerDay fields", async () => {
        const created = stubCreate();
        await run(createEquipment, { user: ownerUser, body: { name: "Drill", pricePerDay: 2500 } });
        assert.equal(created[0].title, "Drill");
        assert.equal(created[0].price, 2500);

        await run(createEquipment, { user: ownerUser, body: { title: "Saw", name: "Ignored", price: 1, pricePerDay: 999 } });
        assert.equal(created[1].title, "Saw");
        assert.equal(created[1].price, 1);
    });

    it("appends the legacy single image to images", async () => {
        const created = stubCreate();
        await run(createEquipment, { user: ownerUser, body: { ...base, image: IMG_B } });
        await run(createEquipment, { user: ownerUser, body: { ...base, images: [IMG_A], image: IMG_B } });
        await run(createEquipment, { user: ownerUser, body: { ...base, images: [IMG_A], image: IMG_A } });
        await run(createEquipment, { user: ownerUser, body: { ...base, image: "" } });
        await run(createEquipment, { user: ownerUser, body: { ...base, image: null } });

        assert.deepEqual(created[0].images, [IMG_B]);
        assert.deepEqual(created[1].images, [IMG_A, IMG_B]);
        assert.deepEqual(created[2].images, [IMG_A]);
        assert.ok(!("images" in created[3]));
        assert.ok(!("images" in created[4]));
    });

    it("accepts Cloudinary URLs of our own cloud and data URLs of up to 900KB", async () => {
        const created = stubCreate();
        const url = cloudinaryUrl();
        // 900KB keeps six inline images under the 8mb JSON body limit after base64 encoding.
        const atLimit = pngDataUrl(900 * 1024, 3);
        await run(createEquipment, { user: ownerUser, body: { ...base, images: [url, atLimit] } });
        assert.deepEqual(created[0].images, [url, atLimit]);
    });

    it("only accepts Cloudinary images from the uploader's own folder", async () => {
        forbidDatabase();
        const base64Url = (path) => `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/${path}`;
        const stolen = [
            base64Url(`v1/rentit/equipment/${OTHER_ID}/a.jpg`), // another owner's upload
            base64Url("v1/a.jpg"), // outside any folder
            base64Url(`v1/rentit/equipment/${USER_ID}x/a.jpg`), // prefix trick
            base64Url(`v1/rentit/equipment/${USER_ID}/../${OTHER_ID}/a.jpg`), // traversal
            `${cloudinaryUrl()}?x=1`, // query strings are not ours
            `${cloudinaryUrl()}#frag`,
        ];
        for (const image of stolen) {
            const err = await refused(createEquipment, { user: ownerUser, body: { ...base, images: [image] } });
            assert.equal(err.status, 400, image);
        }
    });

    it("accepts at most six images", async () => {
        const created = stubCreate();
        const six = Array.from({ length: MAX_IMAGES }, (_, i) => pngDataUrl(16 + i, i + 1));
        await run(createEquipment, { user: ownerUser, body: { ...base, images: six } });
        assert.equal(created[0].images.length, MAX_IMAGES);

        forbidDatabase();
        const seven = [...six, pngDataUrl(40, 9)];
        assert.equal((await refused(createEquipment, { user: ownerUser, body: { ...base, images: seven } })).status, 400);
        // The legacy image counts towards the same limit.
        assert.equal((await refused(createEquipment, { user: ownerUser, body: { ...base, images: six, image: IMG_B } })).status, 400);
    });

    it("rejects bad images", async () => {
        forbidDatabase();
        const svg = `data:image/svg+xml;base64,${Buffer.from("<svg onload=alert(1)/>").toString("base64")}`;
        const fakePng = `data:image/png;base64,${Buffer.from("<html><script>alert(1)</script></html>").toString("base64")}`;
        const tooBig = pngDataUrl(900 * 1024 + 1, 4);
        const bad = [
            "not a url",
            "http://res.cloudinary.com/demo-cloud/image/upload/a.jpg",
            "https://res.cloudinary.com/other-cloud/image/upload/v1/a.jpg",
            "https://evil.example/demo-cloud/image/upload/a.jpg",
            "https://res.cloudinary.com.evil.example/demo-cloud/image/upload/a.jpg",
            "javascript:alert(1)",
            svg,
            fakePng,
            tooBig,
            42,
            { url: IMG_A },
            ["x"],
            null,
            "",
        ];
        for (const image of bad) {
            const err = await refused(createEquipment, { user: ownerUser, body: { ...base, images: [image] } });
            assert.equal(err.status, 400, String(image).slice(0, 60));
        }
        // The legacy field goes through the same validation.
        for (const image of [svg, tooBig, 42, { a: 1 }]) {
            const err = await refused(createEquipment, { user: ownerUser, body: { ...base, image } });
            assert.equal(err.status, 400);
        }
        assert.equal((await refused(createEquipment, { user: ownerUser, body: { ...base, images: IMG_A } })).status, 400);
        assert.equal((await refused(createEquipment, { user: ownerUser, body: { ...base, images: { 0: IMG_A } } })).status, 400);
    });

    it("maps a catalogue slug to the category name and keeps other text", async () => {
        const created = stubCreate();
        await run(createEquipment, { user: ownerUser, body: { ...base, category: "camera-photography" } });
        await run(createEquipment, { user: ownerUser, body: { ...base, category: "power tools" } });
        await run(createEquipment, { user: ownerUser, body: { ...base, category: "Welding rigs" } });
        assert.deepEqual(created.map((c) => c.category), ["Camera & Photography", "Power Tools", "Welding rigs"]);
    });

    it("rejects invalid or injected values without touching the database", async () => {
        forbidDatabase();
        const bad = [
            {},
            { price: 100 },
            { title: "Drill" },
            { ...base, title: "ab" },
            { ...base, title: "x".repeat(121) },
            { ...base, title: { $gt: "" } },
            { ...base, title: ["Drill"] },
            { ...base, title: 12345 },
            { ...base, price: 0 },
            { ...base, price: -1 },
            { ...base, price: "abc" },
            { ...base, price: { $gt: 0 } },
            { ...base, price: [10] },
            { ...base, price: true },
            { ...base, price: null },
            { ...base, rentalDeposit: -1 },
            { ...base, rentalDeposit: "lots" },
            { ...base, description: { a: 1 } },
            { ...base, description: "x".repeat(2001) },
            { ...base, category: { $ne: "" } },
            { ...base, category: "x".repeat(61) },
            { ...base, condition: "x".repeat(41) },
            { ...base, location: ["Lagos"] },
            { ...base, location: "x".repeat(121) },
            { ...base, specs: "5kVA" },
            { ...base, specs: { 0: "5kVA" } },
            { ...base, specs: [{ a: 1 }] },
            { ...base, specs: [1] },
            { ...base, specs: ["x".repeat(101)] },
            { ...base, specs: Array.from({ length: 21 }, (_, i) => `s${i}`) },
            { ...base, availability: "yes" },
            { ...base, availability: 1 },
            { ...base, availability: null },
        ];
        for (const body of bad) {
            const err = await refused(createEquipment, { user: ownerUser, body });
            assert.equal(err.status, 400, JSON.stringify(body).slice(0, 80));
        }
    });

    it("treats a missing or non-object body as empty", async () => {
        forbidDatabase();
        for (const body of [undefined, null, "title=Drill", ["Drill"], 5]) {
            const err = await refused(createEquipment, { user: ownerUser, body });
            assert.equal(err.status, 400);
        }
    });
});

/* ---------- updateEquipment ---------- */

describe("updateEquipment", () => {
    function stubFindOne(doc) {
        const filters = [];
        stub(Equipment, "findOne", async (filter) => {
            filters.push(filter);
            return doc;
        });
        return filters;
    }

    const update = (body, user = ownerUser) => run(updateEquipment, { user, params: { id: LISTING_ID }, body });

    it("only finds listings that belong to the caller", async () => {
        const filters = stubFindOne(null);

        const err = await refused(updateEquipment, { user: otherOwner, params: { id: LISTING_ID }, body: { title: "Hijack" } });
        assert.equal(err.status, 404);
        assert.equal(err.message, "Equipment not found");
        assert.deepEqual(filters, [{ _id: LISTING_ID, owner: OTHER_ID }]);

        // An admin is not an owner: no special path to edit someone else's content.
        const adminErr = await refused(updateEquipment, { user: adminUser, params: { id: LISTING_ID }, body: { title: "Hijack" } });
        assert.equal(adminErr.status, 404);
        assert.deepEqual(filters[1], { _id: LISTING_ID, owner: ADMIN_ID });
    });

    it("validates the id before touching the database", async () => {
        forbidDatabase();
        for (const id of ["abc", ["x"], { $ne: "" }, undefined]) {
            const err = await refused(updateEquipment, { user: ownerUser, params: { id }, body: { title: "Drill" } });
            assert.equal(err.status, 400);
        }
    });

    it("sends an approved listing back to review when its content changes", async () => {
        const doc = listing({ status: "approved" });
        stubFindOne(doc);

        const res = await update({ title: "Honda generator 7kVA" });

        assert.equal(res.statusCode, 200);
        assert.equal(res.body.message, "Equipment updated");
        assert.equal(res.body.equipment, doc);
        assert.equal(doc.title, "Honda generator 7kVA");
        assert.equal(doc.status, "pending");
        assert.equal(doc.rejectionReason, "");
        assert.equal(doc.save.mock.callCount(), 1);
    });

    it("sends a rejected listing back to review and clears the reason", async () => {
        const doc = listing({ status: "rejected", rejectionReason: "Photos are blurry" });
        stubFindOne(doc);

        await update({ images: [IMG_B] });

        assert.equal(doc.status, "pending");
        assert.equal(doc.rejectionReason, "");
        assert.deepEqual([...doc.images], [IMG_B]);
    });

    it("keeps a pending listing pending", async () => {
        const doc = listing({ status: "pending" });
        stubFindOne(doc);
        await update({ price: 20000 });
        assert.equal(doc.status, "pending");
        assert.equal(doc.price, 20000);
    });

    const changedValues = {
        title: "A different title",
        description: "A different description",
        price: 16000,
        rentalDeposit: 6000,
        category: "Power Tools",
        condition: "Fairly used",
        location: "Abuja",
        specs: ["6kVA"],
        images: [IMG_B],
    };
    for (const [field, value] of Object.entries(changedValues)) {
        it(`re-reviews an approved listing when ${field} changes`, async () => {
            const doc = listing({ status: "approved" });
            stubFindOne(doc);
            await update({ [field]: value });
            assert.equal(doc.status, "pending");
        });
    }

    it("does not re-review when the request changes nothing", async () => {
        const doc = listing({ status: "approved" });
        stubFindOne(doc);

        await update({
            title: "Honda generator",
            description: "5kVA petrol generator",
            price: "15000",
            rentalDeposit: 5000,
            category: "equipments",
            condition: "Brand new",
            location: "Lagos",
            specs: ["5kVA"],
            images: [IMG_A],
            availability: true,
        });

        assert.equal(doc.status, "approved");
    });

    it("keeps the status on an availability-only change, even with the status the dashboard sends along", async () => {
        for (const status of ["approved", "rejected", "pending"]) {
            const doc = listing({ status, rejectionReason: status === "rejected" ? "Blurry" : "" });
            stubFindOne(doc);

            await update({ availability: false, status: "unavailable" });

            assert.equal(doc.availability, false);
            assert.equal(doc.status, status);
            assert.equal(doc.rejectionReason, status === "rejected" ? "Blurry" : "");
        }
    });

    it("re-reviews when availability changes together with content", async () => {
        const doc = listing({ status: "approved" });
        stubFindOne(doc);
        await update({ availability: false, price: 1 });
        assert.equal(doc.status, "pending");
        assert.equal(doc.availability, false);
    });

    it("ignores status, owner and review fields", async () => {
        const doc = listing({ status: "rejected", rejectionReason: "Blurry" });
        stubFindOne(doc);

        await update({ status: "approved", owner: OTHER_ID, reviewedBy: OTHER_ID, reviewedAt: "2030-01-01", rejectionReason: "", _id: OTHER_ID });

        assert.equal(doc.status, "rejected");
        assert.equal(doc.rejectionReason, "Blurry");
        assert.equal(String(doc.owner), USER_ID);
        assert.equal(String(doc.reviewedBy), ADMIN_ID);
        assert.equal(doc.reviewedAt.toISOString(), "2025-01-01T00:00:00.000Z");
        assert.equal(String(doc._id), LISTING_ID);
    });

    it("cannot self-approve through a content edit", async () => {
        const doc = listing({ status: "rejected", rejectionReason: "Blurry" });
        stubFindOne(doc);
        await update({ title: "Better title", status: "approved" });
        assert.equal(doc.status, "pending");
    });

    it("appends the legacy single image to the existing images", async () => {
        const doc = listing({ images: [IMG_A] });
        stubFindOne(doc);
        await update({ image: IMG_B });
        assert.deepEqual([...doc.images], [IMG_A, IMG_B]);
        assert.equal(doc.status, "pending");
    });

    it("treats a legacy image that is already there as no change", async () => {
        const doc = listing({ images: [IMG_A], status: "approved" });
        stubFindOne(doc);
        await update({ image: IMG_A });
        assert.deepEqual([...doc.images], [IMG_A]);
        assert.equal(doc.status, "approved");
    });

    it("applies nothing when the body has no writable fields", async () => {
        const doc = listing({ status: "approved" });
        stubFindOne(doc);
        const res = await update({ status: "pending", unknown: 1 });
        assert.equal(res.statusCode, 200);
        assert.equal(doc.status, "approved");
    });

    it("rejects invalid values and leaves the listing untouched", async () => {
        const bad = [
            { title: "ab" },
            { title: { $gt: "" } },
            { title: "" },
            { price: 0 },
            { price: "free" },
            { rentalDeposit: -5 },
            { specs: "x" },
            { availability: "false" },
            { images: [IMG_A, IMG_B, IMG_A, IMG_B, IMG_A, IMG_B, pngDataUrl(40, 7)] },
            { images: ["javascript:alert(1)"] },
            { image: 5 },
            { category: ["x"] },
        ];
        for (const body of bad) {
            const doc = listing({ status: "approved" });
            stubFindOne(doc);
            const err = await refused(updateEquipment, { user: ownerUser, params: { id: LISTING_ID }, body });
            assert.equal(err.status, 400, JSON.stringify(body).slice(0, 80));
            assert.equal(doc.save.mock.callCount(), 0);
            assert.equal(doc.status, "approved");
            assert.equal(doc.title, "Honda generator");
        }
    });
});

/* ---------- deleteEquipment ---------- */

describe("deleteEquipment", () => {
    function stubDelete(deletedCount) {
        const filters = [];
        stub(Equipment, "deleteOne", async (filter) => {
            filters.push(filter);
            return { acknowledged: true, deletedCount };
        });
        return filters;
    }

    const remove = (user) => run(deleteEquipment, { user, params: { id: LISTING_ID } });

    it("lets an owner delete their own listing", async () => {
        const filters = stubDelete(1);
        const res = await remove(ownerUser);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, { message: "Equipment deleted" });
        assert.deepEqual(filters, [{ _id: LISTING_ID, owner: USER_ID }]);
    });

    it("lets an admin delete any listing", async () => {
        const filters = stubDelete(1);
        const res = await remove(adminUser);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(filters, [{ _id: LISTING_ID }]);
    });

    it("answers 404 for a listing that is missing or belongs to someone else", async () => {
        stubDelete(0);
        for (const user of [ownerUser, adminUser]) {
            const err = await refused(deleteEquipment, { user, params: { id: LISTING_ID } });
            assert.equal(err.status, 404);
            assert.equal(err.message, "Equipment not found");
        }
    });

    it("validates the id before touching the database", async () => {
        forbidDatabase();
        for (const id of ["abc", ["x"], { $ne: "" }, undefined]) {
            const err = await refused(deleteEquipment, { user: adminUser, params: { id } });
            assert.equal(err.status, 400);
        }
    });
});

/* ---------- route wiring ---------- */

describe("equipment routes", () => {
    const layers = equipmentRouter.stack.filter((layer) => layer.route).map((layer) => ({
        path: layer.route.path,
        method: Object.keys(layer.route.methods)[0],
        handlers: layer.route.stack.map((s) => s.handle),
    }));
    const find = (method, path) => layers.find((l) => l.method === method && l.path === path);

    /** Runs a role guard against a user of each role and returns the roles it lets through. */
    function admittedRoles(guard) {
        return ["renter", "owner", "admin"].filter((role) => {
            const res = fakeRes();
            const next = mock.fn();
            guard({ user: { id: USER_ID, role } }, res, next);
            if (next.mock.callCount() === 1) return true;
            assert.equal(res.statusCode, 403);
            return false;
        });
    }

    const table = [
        // method, path, auth middleware, handler, roles allowed (null: public)
        ["get", "/", optionalAuth, controller.listEquipment, null],
        ["get", "/getall", optionalAuth, controller.listEquipment, null],
        ["get", "/getone/:id", optionalAuth, controller.getEquipment, null],
        ["get", "/:id", optionalAuth, controller.getEquipment, null],
        ["get", "/mine", protect, controller.getMyEquipment, ["owner"]],
        ["post", "/", protect, controller.createEquipment, ["owner"]],
        ["post", "/create", protect, controller.createEquipment, ["owner"]],
        ["patch", "/:id", protect, controller.updateEquipment, ["owner"]],
        ["patch", "/update/:id", protect, controller.updateEquipment, ["owner"]],
        ["delete", "/:id", protect, controller.deleteEquipment, ["owner", "admin"]],
        ["delete", "/delete/:id", protect, controller.deleteEquipment, ["owner", "admin"]],
    ];

    for (const [method, path, auth, handler, roles] of table) {
        it(`${method.toUpperCase()} ${path} is wired to ${handler.name} behind the right guards`, () => {
            const route = find(method, path);
            assert.ok(route, "route is missing");
            assert.equal(route.handlers.at(0), auth);
            assert.equal(route.handlers.at(-1), handler);
            if (roles === null) {
                assert.equal(route.handlers.length, 2);
            } else {
                assert.equal(route.handlers.length, 3);
                assert.deepEqual(admittedRoles(route.handlers[1]), roles);
            }
        });
    }

    it("registers exactly these routes", () => {
        assert.equal(layers.length, table.length);
    });

    it("registers the fixed paths before the generic /:id routes", () => {
        const index = (method, path) => layers.findIndex((l) => l.method === method && l.path === path);
        for (const path of ["/", "/getall", "/mine", "/getone/:id"]) {
            assert.ok(index("get", path) < index("get", "/:id"), `GET ${path} must come before GET /:id`);
        }
        assert.ok(index("patch", "/update/:id") < index("patch", "/:id"));
        assert.ok(index("delete", "/delete/:id") < index("delete", "/:id"));
    });
});

describe("mounted API", () => {
    let server;
    let base;

    before(async () => {
        server = await new Promise((resolve) => {
            const s = createApp({ rateLimit: false }).listen(0, "127.0.0.1", () => resolve(s));
        });
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => new Promise((resolve) => server.close(resolve)));

    const call = async (path, method = "GET", body) => {
        const res = await fetch(base + path, {
            method,
            headers: body ? { "Content-Type": "application/json" } : {},
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(15_000),
        });
        return { status: res.status, json: await res.json().catch(() => undefined) };
    };

    it("serves the catalogue on both mounts and both paths", async () => {
        for (const path of ["/api/categories", "/api/categories/getall", "/category", "/category/getall"]) {
            const res = await call(path);
            assert.equal(res.status, 200, path);
            assert.deepEqual(res.json, { categories: CATEGORIES.map(({ id, name, slug }) => ({ id, name, slug })) });
        }
    });

    it("requires authentication for every write, on both mounts", async () => {
        const writes = [
            ["POST", "/api/equipment"],
            ["POST", "/equipment"],
            ["POST", "/equipment/create"],
            ["PATCH", `/api/equipment/${LISTING_ID}`],
            ["PATCH", `/equipment/update/${LISTING_ID}`],
            ["DELETE", `/api/equipment/${LISTING_ID}`],
            ["DELETE", `/equipment/delete/${LISTING_ID}`],
            ["GET", "/api/equipment/mine"],
            ["GET", "/equipment/mine"],
            ["POST", "/api/uploads/sign"],
        ];
        for (const [method, path] of writes) {
            const res = await call(path, method, method === "GET" ? undefined : { purpose: "equipment" });
            assert.equal(res.status, 401, `${method} ${path}`);
            assert.ok(typeof res.json?.message === "string");
        }
    });

    it("reads /mine as a route, not as an id, and validates ids on the public routes", async () => {
        for (const path of ["/api/equipment/not-an-id", "/equipment/not-an-id", "/equipment/getone/not-an-id"]) {
            const res = await call(path);
            assert.equal(res.status, 400, path);
            assert.deepEqual(res.json, { message: "Invalid id" });
        }
    });

    it("answers a malformed query with a JSON 400 before any database access", async () => {
        const res = await call("/api/equipment?minPrice=abc");
        assert.equal(res.status, 400);
        assert.equal(typeof res.json.message, "string");
        const repeated = await call("/equipment/getall?q=a&q=b");
        assert.equal(repeated.status, 400);
    });
});

describe("toListItem", () => {
    it("keeps only the first image and reports how many there are", async () => {
        const { toListItem } = await import("../../Controllers/equipmentController.js");
        const doc = { toJSON: () => ({ title: "x", images: ["a", "b", "c"], image: "a" }) };
        assert.deepEqual(toListItem(doc), { title: "x", images: ["a"], image: "a", imageCount: 3 });
        assert.deepEqual(toListItem({ title: "plain" }), { title: "plain", images: [], imageCount: 0 });
    });
});
