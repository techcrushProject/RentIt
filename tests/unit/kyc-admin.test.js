import "../helpers/setEnv.js";
import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import express from "express";
import {
    approveEquipment,
    getKycDocument,
    getKycSubmissions,
    listEquipmentForReview,
    rejectEquipment,
    reviewEquipment,
    verifyUserKyc,
} from "../../Controllers/adminControllers.js";
import { getMyKyc, submitKyc } from "../../Controllers/kycController.js";
import protect from "../../Middleware/authMiddleware.js";
import { errorHandler } from "../../Middleware/errorMiddleware.js";
import Equipment from "../../Models/equipment.js";
import User from "../../Models/user.js";
import adminRouter from "../../Routes/adminRoutes.js";
import kycRouter from "../../Routes/kycRoutes.js";
import { HttpError } from "../../utils/httpError.js";
import { signToken } from "../../utils/token.js";

const USER_ID = "64b7f0c2a1b2c3d4e5f60718";
const OTHER_ID = "64b7f0c2a1b2c3d4e5f60719";
const ADMIN_ID = "64b7f0c2a1b2c3d4e5f6071a";
const EQUIPMENT_ID = "64b7f0c2a1b2c3d4e5f6071b";
const MB = 1024 * 1024;

/* ---------- helpers ---------- */

// Stubs are plain assignments onto the real model objects, undone after every test.
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

/** Records calls to a stubbed static and returns the list of argument arrays. */
function record(target, name, impl) {
    const calls = [];
    stub(target, name, (...args) => {
        calls.push(args);
        return impl(...args);
    });
    return calls;
}

/** Makes any database call fail the test, to prove a code path is rejected before the database. */
function forbidDatabase() {
    const boom = (what) => () => {
        throw new Error(`unexpected database call: ${what}`);
    };
    for (const [label, model] of [["User", User], ["Equipment", Equipment]]) {
        for (const name of ["find", "findById", "findOne", "updateOne", "countDocuments"]) {
            stub(model, name, boom(`${label}.${name}`));
        }
    }
}

/** A chainable, awaitable stand-in for a Mongoose query that remembers how it was built. */
function fakeQuery(result) {
    const query = { calls: [], staticCalls: [] };
    for (const name of ["select", "sort", "skip", "limit", "lean", "populate"]) {
        query[name] = (...args) => {
            query.calls.push([name, ...args]);
            return query;
        };
    }
    query.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
    return query;
}

function stubQuery(model, name, result) {
    const query = fakeQuery(result);
    stub(model, name, (...args) => {
        query.staticCalls.push(args);
        return query;
    });
    return query;
}

const callsTo = (query, name) => query.calls.filter(([n]) => n === name).map(([, ...args]) => args);
const selectArg = (query) => callsTo(query, "select")[0][0];

const fakeRes = () => ({
    statusCode: undefined,
    body: undefined,
    headers: {},
    status(code) {
        this.statusCode = code;
        return this;
    },
    json(body) {
        this.body = body;
        return this;
    },
    set(fields) {
        for (const [key, value] of Object.entries(fields)) this.headers[key.toLowerCase()] = value;
        return this;
    },
    send(body) {
        this.body = body;
        return this;
    },
});

const OWNER = { id: USER_ID, role: "owner" };
const ADMIN = { id: ADMIN_ID, role: "admin" };

const fakeReq = (over = {}) => ({ headers: {}, query: {}, params: {}, body: undefined, user: OWNER, ...over });

async function call(handler, over) {
    const res = fakeRes();
    await handler(fakeReq(over), res);
    return res;
}

async function assertHttpError(promise, status, message) {
    await assert.rejects(promise, (err) => {
        assert.ok(err instanceof HttpError, `expected an HttpError, got ${err}`);
        assert.equal(err.status, status);
        if (message instanceof RegExp) assert.match(err.message, message);
        else if (message !== undefined) assert.equal(err.message, message);
        return true;
    });
}

/** Calls the handler and expects a client error without ever touching the database. */
async function assertRejected(handler, over, status, message) {
    const mark = restores.length;
    forbidDatabase();
    try {
        await assertHttpError(call(handler, over), status, message);
    } finally {
        while (restores.length > mark) restores.pop()();
    }
}

/* ---------- image fixtures ---------- */

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

const pngBytes = (size = 64) => Buffer.concat([PNG_HEAD, Buffer.alloc(size - PNG_HEAD.length, 1)]);
const jpegBytes = (size = 48) => Buffer.concat([JPEG_HEAD, Buffer.alloc(size - JPEG_HEAD.length, 2)]);
const dataUrl = (bytes, type = "png") => `data:image/${type};base64,${bytes.toString("base64")}`;

const DOCUMENT_BYTES = pngBytes(64);
const SELFIE_BYTES = jpegBytes(48);
const DOCUMENT_URL = dataUrl(DOCUMENT_BYTES);
const SELFIE_URL = dataUrl(SELFIE_BYTES, "jpeg");
const HTML_AS_PNG = dataUrl(Buffer.from("<html><script>alert(document.cookie)</script></html>"));

const validKyc = (over = {}) => ({
    documentType: "NIN",
    documentNumber: "12345678901",
    documentUrl: DOCUMENT_URL,
    selfieUrl: SELFIE_URL,
    address: "12 Marina Road, Lagos",
    ...over,
});

const NON_STRINGS = [123, true, ["NIN"], { $ne: null }, { $gt: "" }];

/* ---------- submitKyc ---------- */

describe("submitKyc", () => {
    it("stores the submission with an atomic precondition and responds with the new status", async () => {
        const updates = record(User, "updateOne", async () => ({ modifiedCount: 1 }));
        const res = await call(submitKyc, { body: validKyc() });

        assert.equal(updates.length, 1);
        const [filter, update] = updates[0];
        assert.deepEqual(filter, { _id: USER_ID, kycStatus: { $in: ["not_submitted", "rejected", "resubmit"] } });

        const { kycDetails, ...rest } = update.$set;
        assert.ok(kycDetails.submittedAt instanceof Date);
        assert.deepEqual(kycDetails, {
            idType: "NIN",
            idNumber: "12345678901",
            documentUrl: DOCUMENT_URL,
            selfieUrl: SELFIE_URL,
            documentMime: "image/png",
            selfieMime: "image/jpeg",
            documentBytes: DOCUMENT_BYTES.length,
            selfieBytes: SELFIE_BYTES.length,
            address: "12 Marina Road, Lagos",
            submittedAt: kycDetails.submittedAt,
        });
        assert.deepEqual(rest, {
            kycStatus: "under_review",
            kycRejectionReason: "",
            isVerified: false,
            address: "12 Marina Road, Lagos",
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, {
            message: "KYC submitted successfully",
            kyc: { status: "under_review", submittedAt: kycDetails.submittedAt },
        });
    });

    it("leaves the profile address alone when none was provided", async () => {
        const updates = record(User, "updateOne", async () => ({ modifiedCount: 1 }));
        await call(submitKyc, { body: validKyc({ address: undefined }) });
        const { $set } = updates[0][1];
        assert.equal("address" in $set, false);
        assert.equal($set.kycDetails.address, "");
    });

    it("accepts every documented document type, including the legacy values", async () => {
        const types = [
            "NIN",
            "Voter's card",
            "Driver's licence",
            "International passport",
            "national_id",
            "voters_card",
            "drivers_license",
            "passport",
        ];
        record(User, "updateOne", async () => ({ modifiedCount: 1 }));
        for (const documentType of types) {
            const res = await call(submitKyc, { body: validKyc({ documentType }) });
            assert.equal(res.statusCode, 200, documentType);
        }
    });

    it("takes the user id from the token, never from the body", async () => {
        const updates = record(User, "updateOne", async () => ({ modifiedCount: 1 }));
        await call(submitKyc, { body: validKyc({ _id: OTHER_ID, kycStatus: "verified", isVerified: true }) });
        assert.equal(updates[0][0]._id, USER_ID);
        assert.equal(updates[0][1].$set.kycStatus, "under_review");
        assert.equal(updates[0][1].$set.isVerified, false);
    });

    it("answers 409 when the atomic update matches nothing (already under review or verified)", async () => {
        const updates = record(User, "updateOne", async () => ({ modifiedCount: 0 }));
        // Only the single conditional write may happen: no read-then-write race window.
        stub(User, "findById", () => {
            throw new Error("must not read before writing");
        });
        await assertHttpError(call(submitKyc, { body: validKyc() }), 409, "KYC is already under review or verified");
        assert.equal(updates.length, 1);
    });

    it("never lets under_review or verified satisfy the write precondition", async () => {
        const updates = record(User, "updateOne", async () => ({ modifiedCount: 1 }));
        await call(submitKyc, { body: validKyc() });
        const allowed = updates[0][0].kycStatus.$in;
        assert.equal(allowed.includes("under_review"), false);
        assert.equal(allowed.includes("verified"), false);
    });

    it("rejects non-string and missing fields before touching the database", async () => {
        for (const field of ["documentType", "documentNumber", "documentUrl", "selfieUrl"]) {
            for (const value of [...NON_STRINGS, undefined, null, ""]) {
                await assertRejected(submitKyc, { body: validKyc({ [field]: value }) }, 400);
            }
        }
        for (const value of [123, ["a"], { $ne: "" }]) {
            await assertRejected(submitKyc, { body: validKyc({ address: value }) }, 400, "address must be text");
        }
    });

    it("rejects a missing or non-object body", async () => {
        for (const body of [undefined, null, "NIN", 42, []]) {
            await assertRejected(submitKyc, { body }, 400);
        }
    });

    it("rejects unknown document types and badly sized numbers or addresses", async () => {
        await assertRejected(submitKyc, { body: validKyc({ documentType: "Library card" }) }, 400, /documentType must be one of/);
        await assertRejected(submitKyc, { body: validKyc({ documentType: "nin" }) }, 400);
        await assertRejected(submitKyc, { body: validKyc({ documentNumber: "123" }) }, 400, /at least 4/);
        await assertRejected(submitKyc, { body: validKyc({ documentNumber: "1".repeat(41) }) }, 400, /at most 40/);
        await assertRejected(submitKyc, { body: validKyc({ documentNumber: "    " }) }, 400);
        await assertRejected(submitKyc, { body: validKyc({ address: "x".repeat(201) }) }, 400, /at most 200/);
    });

    it("accepts the boundary lengths", async () => {
        record(User, "updateOne", async () => ({ modifiedCount: 1 }));
        const body = validKyc({ documentNumber: "1234", address: "x".repeat(200) });
        assert.equal((await call(submitKyc, { body })).statusCode, 200);
        const long = validKyc({ documentNumber: "1".repeat(40) });
        assert.equal((await call(submitKyc, { body: long })).statusCode, 200);
    });

    it("refuses remote URLs for identity images", async () => {
        const remote = [
            "https://res.cloudinary.com/demo/image/upload/v1/id.png",
            "http://example.com/id.png",
            "//example.com/id.png",
            "file:///etc/passwd",
        ];
        for (const url of remote) {
            await assertRejected(submitKyc, { body: validKyc({ documentUrl: url }) }, 400, /must be a JPEG, PNG or WebP image/);
            await assertRejected(submitKyc, { body: validKyc({ selfieUrl: url }) }, 400, /must be a JPEG, PNG or WebP image/);
        }
    });

    it("refuses data URLs that are not JPEG, PNG or WebP", async () => {
        const svg = `data:image/svg+xml;base64,${Buffer.from("<svg onload=alert(1)/>").toString("base64")}`;
        const gif = `data:image/gif;base64,${Buffer.from("GIF89a").toString("base64")}`;
        const html = `data:text/html;base64,${Buffer.from("<script>alert(1)</script>").toString("base64")}`;
        for (const url of [svg, gif, html, "data:image/png;base64,", "data:image/png,rawtext"]) {
            await assertRejected(submitKyc, { body: validKyc({ documentUrl: url }) }, 400);
            await assertRejected(submitKyc, { body: validKyc({ selfieUrl: url }) }, 400);
        }
    });

    it("refuses malformed base64", async () => {
        for (const url of ["data:image/png;base64,@@@@", "data:image/png;base64,abc", "data:image/png;base64,QUJD=QUJD"]) {
            await assertRejected(submitKyc, { body: validKyc({ documentUrl: url }) }, 400, /not valid image data/);
        }
    });

    it("refuses HTML disguised as a PNG", async () => {
        await assertRejected(submitKyc, { body: validKyc({ documentUrl: HTML_AS_PNG }) }, 400, /not a valid PNG image/);
        await assertRejected(submitKyc, { body: validKyc({ selfieUrl: HTML_AS_PNG }) }, 400, /not a valid PNG image/);
    });

    it("refuses an image whose real type differs from the declared one", async () => {
        const pngLabelledJpeg = dataUrl(DOCUMENT_BYTES, "jpeg");
        await assertRejected(submitKyc, { body: validKyc({ documentUrl: pngLabelledJpeg }) }, 400, /not a valid JPEG image/);
    });

    it("refuses images over 2MB decoded, and accepts exactly 2MB", async () => {
        const justOver = dataUrl(pngBytes(2 * MB + 1));
        const wayOver = dataUrl(pngBytes(3 * MB));
        for (const url of [justOver, wayOver]) {
            await assertRejected(submitKyc, { body: validKyc({ documentUrl: url }) }, 400, /too large/);
            await assertRejected(submitKyc, { body: validKyc({ selfieUrl: url }) }, 400, /too large/);
        }
        const updates = record(User, "updateOne", async () => ({ modifiedCount: 1 }));
        const res = await call(submitKyc, { body: validKyc({ documentUrl: dataUrl(pngBytes(2 * MB)) }) });
        assert.equal(res.statusCode, 200);
        assert.equal(updates[0][1].$set.kycDetails.documentBytes, 2 * MB);
    });
});

/* ---------- getMyKyc ---------- */

describe("getMyKyc", () => {
    it("answers 404 with the exact text the frontend matches when nothing was submitted", async () => {
        stubQuery(User, "findById", { kycStatus: "not_submitted", kycDetails: {} });
        await assertHttpError(call(getMyKyc), 404, "KYC record not found");
    });

    it("answers 404 for a user who no longer exists", async () => {
        stubQuery(User, "findById", null);
        await assertHttpError(call(getMyKyc), 404, "KYC record not found");
    });

    it("returns the summary without image data or the document number", async () => {
        const submittedAt = new Date("2025-03-01T10:00:00Z");
        const query = stubQuery(User, "findById", {
            _id: USER_ID,
            kycStatus: "rejected",
            kycRejectionReason: "Photo is blurry",
            kycDetails: {
                idType: "NIN",
                idNumber: "12345678901",
                documentUrl: DOCUMENT_URL,
                selfieUrl: SELFIE_URL,
                address: "12 Marina Road",
                submittedAt,
                documentBytes: 64,
                selfieBytes: 48,
            },
        });
        const res = await call(getMyKyc);

        assert.equal(res.statusCode, 200);
        assert.deepEqual(Object.keys(res.body), ["kyc"]);
        assert.deepEqual(res.body.kyc, {
            status: "rejected",
            rejectionReason: "Photo is blurry",
            documentType: "NIN",
            address: "12 Marina Road",
            submittedAt,
            hasDocument: true,
            hasSelfie: true,
        });
        const json = JSON.stringify(res.body);
        assert.equal(json.includes("data:image"), false);
        assert.equal(json.includes("12345678901"), false);

        assert.deepEqual(query.staticCalls, [[USER_ID]]);
        // Selecting the whole kycDetails subdocument would load the image data URLs from the database.
        const fields = selectArg(query).split(/\s+/);
        assert.equal(fields.includes("kycDetails"), false);
        assert.equal(fields.some((f) => f.startsWith("+") || /documentUrl|selfieUrl|idNumber/.test(f)), false);
    });

    it("reports missing images as false", async () => {
        stubQuery(User, "findById", { kycStatus: "under_review", kycDetails: { idType: "passport" } });
        const res = await call(getMyKyc);
        assert.equal(res.body.kyc.hasDocument, false);
        assert.equal(res.body.kyc.hasSelfie, false);
        assert.equal(res.body.kyc.rejectionReason, "");
    });
});

/* ---------- getKycSubmissions ---------- */

const kycRow = (over = {}) => ({
    _id: OTHER_ID,
    name: "Ada Obi",
    email: "ada@example.com",
    phone: "08012345678",
    role: "owner",
    kycStatus: "under_review",
    kycRejectionReason: "",
    createdAt: new Date("2025-01-01T00:00:00Z"),
    kycDetails: {
        idType: "NIN",
        idNumber: "12345678901",
        documentBytes: 64,
        selfieBytes: 48,
        address: "12 Marina Road",
        submittedAt: new Date("2025-02-01T00:00:00Z"),
    },
    ...over,
});

describe("getKycSubmissions", () => {
    function stubList(rows = [kycRow()], total = rows.length) {
        const query = stubQuery(User, "find", rows);
        const counts = record(User, "countDocuments", async () => total);
        return { query, counts };
    }

    it("lists all submitted statuses by default, newest first, with paging metadata", async () => {
        const { query, counts } = stubList([kycRow()], 41);
        const res = await call(getKycSubmissions, { user: ADMIN });

        const everySubmitted = { kycStatus: { $in: ["under_review", "verified", "rejected", "resubmit"] } };
        assert.deepEqual(query.staticCalls, [[everySubmitted]]);
        assert.deepEqual(counts, [[everySubmitted]]);
        assert.deepEqual(callsTo(query, "sort"), [[{ "kycDetails.submittedAt": -1, _id: -1 }]]);
        assert.deepEqual(callsTo(query, "skip"), [[0]]);
        assert.deepEqual(callsTo(query, "limit"), [[20]]);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.page, 1);
        assert.equal(res.body.limit, 20);
        assert.equal(res.body.total, 41);
    });

    it("shapes each row and points at the protected image endpoints", async () => {
        stubList([kycRow()]);
        const res = await call(getKycSubmissions, { user: ADMIN });
        assert.deepEqual(res.body.kyc, [
            {
                id: OTHER_ID,
                name: "Ada Obi",
                email: "ada@example.com",
                phone: "08012345678",
                address: "12 Marina Road",
                role: "owner",
                status: "under_review",
                documentType: "NIN",
                documentNumber: "12345678901",
                hasDocument: true,
                hasSelfie: true,
                documentPath: `/admin/kyc/${OTHER_ID}/document`,
                selfiePath: `/admin/kyc/${OTHER_ID}/selfie`,
                submittedAt: new Date("2025-02-01T00:00:00Z"),
                rejectionReason: "",
            },
        ]);
    });

    it("falls back gracefully for sparse legacy rows", async () => {
        stubList([kycRow({ phone: undefined, kycDetails: undefined, address: "Top level" })]);
        const [row] = (await call(getKycSubmissions, { user: ADMIN })).body.kyc;
        assert.equal(row.phone, "");
        assert.equal(row.address, "Top level");
        assert.equal(row.documentType, "");
        assert.equal(row.documentNumber, "");
        assert.equal(row.hasDocument, false);
        assert.equal(row.hasSelfie, false);
        assert.deepEqual(row.submittedAt, new Date("2025-01-01T00:00:00Z"));
    });

    it("never contains image data, only opting the document number into the query", async () => {
        // Even if a row somehow arrived with the image fields, the response is built from a whitelist.
        const leaky = kycRow({ kycDetails: { ...kycRow().kycDetails, documentUrl: DOCUMENT_URL, selfieUrl: SELFIE_URL } });
        const { query } = stubList([leaky]);
        const res = await call(getKycSubmissions, { user: ADMIN });

        const json = JSON.stringify(res.body);
        assert.equal(json.includes("data:image"), false);
        assert.equal(json.includes("base64"), false);
        assert.equal(/documentUrl|selfieUrl/.test(json), false);
        assert.deepEqual(callsTo(query, "select"), [["+kycDetails.idNumber"]]);
    });

    it("filters by a single status", async () => {
        for (const status of ["under_review", "verified", "rejected", "resubmit"]) {
            const { query } = stubList([]);
            await call(getKycSubmissions, { user: ADMIN, query: { status } });
            assert.deepEqual(query.staticCalls[0][0], { kycStatus: status });
        }
        const { query } = stubList([]);
        await call(getKycSubmissions, { user: ADMIN, query: { status: "all" } });
        assert.deepEqual(query.staticCalls[0][0].kycStatus, { $in: ["under_review", "verified", "rejected", "resubmit"] });
    });

    it("rejects unknown statuses, including not_submitted, and non-string values", async () => {
        for (const status of ["pending", "not_submitted", "$ne", ["verified", "rejected"], { $ne: "verified" }, 5]) {
            await assertRejected(getKycSubmissions, { user: ADMIN, query: { status } }, 400);
        }
    });

    it("searches name or email with a regex-escaped, case-insensitive pattern", async () => {
        const { query, counts } = stubList([]);
        const q = "a.b+(c)[d]*^$|\\";
        await call(getKycSubmissions, { user: ADMIN, query: { q } });

        const filter = query.staticCalls[0][0];
        assert.equal(filter.$or.length, 2);
        const [byName, byEmail] = filter.$or;
        assert.ok(byName.name instanceof RegExp);
        assert.ok(byEmail.email instanceof RegExp);
        const pattern = byName.name;
        assert.equal(pattern.flags, "i");
        assert.equal(pattern.test(`xx${q}yy`), true);
        assert.equal(pattern.test("aXb"), false);
        assert.equal(byEmail.email.source, pattern.source);
        // The count must use the same filter as the page, or total would not match the results.
        assert.deepEqual(counts[0][0], filter);
    });

    it("cannot be made to run a catch-all regex", async () => {
        const { query } = stubList([]);
        await call(getKycSubmissions, { user: ADMIN, query: { q: ".*" } });
        const pattern = query.staticCalls[0][0].$or[0].name;
        assert.equal(pattern.test("anything at all"), false);
    });

    it("rejects a search term that is too long or not text", async () => {
        await assertRejected(getKycSubmissions, { user: ADMIN, query: { q: "x".repeat(61) } }, 400, /at most 60/);
        for (const q of [{ $ne: "" }, ["a", "b"], 12]) {
            await assertRejected(getKycSubmissions, { user: ADMIN, query: { q } }, 400);
        }
        stubList([]);
        assert.equal((await call(getKycSubmissions, { user: ADMIN, query: { q: "x".repeat(60) } })).statusCode, 200);
    });

    it("pages with a hard ceiling of 100", async () => {
        const { query } = stubList([], 0);
        const res = await call(getKycSubmissions, { user: ADMIN, query: { page: "3", limit: "5" } });
        assert.deepEqual(callsTo(query, "skip"), [[10]]);
        assert.deepEqual(callsTo(query, "limit"), [[5]]);
        assert.equal(res.body.page, 3);
        assert.equal(res.body.limit, 5);

        const big = stubList([], 0).query;
        const capped = await call(getKycSubmissions, { user: ADMIN, query: { limit: "100000" } });
        assert.deepEqual(callsTo(big, "limit"), [[100]]);
        assert.equal(capped.body.limit, 100);
    });
});

/* ---------- getKycDocument ---------- */

describe("getKycDocument", () => {
    const EXPECTED_HEADERS = (mime, kind) => ({
        "content-type": mime,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-disposition": `inline; filename="kyc-${kind}"`,
        "content-security-policy": "default-src 'none'; sandbox",
    });

    it("sends the decoded bytes with the verified mime type and locked-down headers", async () => {
        const query = stubQuery(User, "findById", { kycDetails: { documentUrl: DOCUMENT_URL } });
        const res = await call(getKycDocument("document"), { user: ADMIN, params: { id: OTHER_ID } });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.headers, EXPECTED_HEADERS("image/png", "document"));
        assert.ok(Buffer.isBuffer(res.body));
        assert.ok(res.body.equals(DOCUMENT_BYTES));
        assert.deepEqual(query.staticCalls, [[OTHER_ID]]);
        assert.deepEqual(callsTo(query, "select"), [["+kycDetails.documentUrl"]]);
    });

    it("serves the selfie from its own field", async () => {
        const query = stubQuery(User, "findById", { kycDetails: { documentUrl: DOCUMENT_URL, selfieUrl: SELFIE_URL } });
        const res = await call(getKycDocument("selfie"), { user: ADMIN, params: { id: OTHER_ID } });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.headers, EXPECTED_HEADERS("image/jpeg", "selfie"));
        assert.ok(res.body.equals(SELFIE_BYTES));
        assert.deepEqual(callsTo(query, "select"), [["+kycDetails.selfieUrl"]]);
    });

    it("takes the mime type from the image bytes, not from stored metadata", async () => {
        stubQuery(User, "findById", { kycDetails: { documentUrl: SELFIE_URL, documentMime: "text/html" } });
        const res = await call(getKycDocument("document"), { user: ADMIN, params: { id: OTHER_ID } });
        assert.equal(res.headers["content-type"], "image/jpeg");
    });

    it("answers 404 when the user or the image is absent", async () => {
        for (const found of [null, {}, { kycDetails: {} }, { kycDetails: { documentUrl: "" } }]) {
            stubQuery(User, "findById", found);
            await assertHttpError(
                call(getKycDocument("document"), { user: ADMIN, params: { id: OTHER_ID } }),
                404,
                "KYC document not found"
            );
        }
        stubQuery(User, "findById", { kycDetails: { documentUrl: DOCUMENT_URL } });
        await assertHttpError(
            call(getKycDocument("selfie"), { user: ADMIN, params: { id: OTHER_ID } }),
            404,
            "KYC selfie not found"
        );
    });

    it("refuses to serve stored data that is not a real image", async () => {
        stubQuery(User, "findById", { kycDetails: { documentUrl: HTML_AS_PNG } });
        const res = fakeRes();
        await assertHttpError(getKycDocument("document")(fakeReq({ user: ADMIN, params: { id: OTHER_ID } }), res), 404);
        assert.equal(res.body, undefined);
        assert.deepEqual(res.headers, {});
    });

    it("rejects invalid ids before the database", async () => {
        for (const id of ["abc", "../../etc/passwd", "64b7f0c2a1b2c3d4e5f6071", `${OTHER_ID}0`, { $ne: null }, ["x"], undefined]) {
            await assertRejected(getKycDocument("document"), { user: ADMIN, params: { id } }, 400, "Invalid id");
        }
    });

    it("refuses to be wired to an unknown kind", () => {
        assert.throws(() => getKycDocument("passport"), /Unknown KYC image kind/);
        assert.throws(() => getKycDocument(undefined), /Unknown KYC image kind/);
    });
});

/* ---------- verifyUserKyc ---------- */

describe("verifyUserKyc", () => {
    const verify = (body, id = OTHER_ID) => call(verifyUserKyc, { user: ADMIN, params: { id }, body });

    it("verifies by default and clears any rejection reason", async () => {
        const updates = record(User, "updateOne", async () => ({ matchedCount: 1, modifiedCount: 1 }));
        const res = await verify(undefined);

        assert.deepEqual(updates[0][0], { _id: OTHER_ID, kycStatus: { $ne: "not_submitted" } });
        assert.deepEqual(updates[0][1], { $set: { kycStatus: "verified", isVerified: true, kycRejectionReason: "" } });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, {
            message: "User KYC verified",
            kyc: { id: OTHER_ID, status: "verified", rejectionReason: "" },
        });
    });

    it("ignores a rejectionReason (of any type) when verifying", async () => {
        const updates = record(User, "updateOne", async () => ({ matchedCount: 1 }));
        await verify({ status: "verified", rejectionReason: { $ne: "" } });
        await verify({ status: "verified", rejectionReason: "stale text" });
        for (const [, update] of updates) assert.equal(update.$set.kycRejectionReason, "");
    });

    it("stores the trimmed reason for rejected and resubmit, with isVerified false", async () => {
        const updates = record(User, "updateOne", async () => ({ matchedCount: 1 }));
        for (const status of ["rejected", "resubmit"]) {
            const res = await verify({ status, rejectionReason: "  Photo is blurry  " });
            assert.equal(res.body.message, `User KYC ${status}`);
            assert.deepEqual(res.body.kyc, { id: OTHER_ID, status, rejectionReason: "Photo is blurry" });
        }
        assert.deepEqual(updates[0][1].$set, { kycStatus: "rejected", isVerified: false, kycRejectionReason: "Photo is blurry" });
        assert.equal(updates[1][1].$set.kycStatus, "resubmit");
    });

    it("accepts the status in any letter case, as the previous implementation did", async () => {
        record(User, "updateOne", async () => ({ matchedCount: 1 }));
        assert.equal((await verify({ status: "Verified" })).body.kyc.status, "verified");
        assert.equal((await verify({ status: "" })).body.kyc.status, "verified");
    });

    it("answers 404 when the user does not exist or never submitted KYC", async () => {
        // One conditional update covers both cases: the filter excludes not_submitted users.
        record(User, "updateOne", async () => ({ matchedCount: 0, modifiedCount: 0 }));
        await assertHttpError(verify({ status: "verified" }), 404, "KYC submission not found");
    });

    it("still succeeds when the status is unchanged (matched but not modified)", async () => {
        record(User, "updateOne", async () => ({ matchedCount: 1, modifiedCount: 0 }));
        assert.equal((await verify({ status: "verified" })).statusCode, 200);
    });

    it("rejects bad ids, statuses and reasons before the database", async () => {
        const cases = [
            [{ params: { id: "nope" }, body: {} }, "Invalid id"],
            [{ params: { id: { $ne: null } }, body: {} }, "Invalid id"],
            [{ params: { id: OTHER_ID }, body: { status: "approved" } }, /status must be one of/],
            [{ params: { id: OTHER_ID }, body: { status: "not_submitted" } }, /status must be one of/],
            [{ params: { id: OTHER_ID }, body: { status: { $ne: "x" } } }, /status must be text/],
            [{ params: { id: OTHER_ID }, body: { status: ["verified"] } }, /status must be text/],
            [{ params: { id: OTHER_ID }, body: { status: 1 } }, /status must be text/],
            [{ params: { id: OTHER_ID }, body: { status: "rejected" } }, "rejectionReason is required"],
            [{ params: { id: OTHER_ID }, body: { status: "resubmit", rejectionReason: "   " } }, "rejectionReason is required"],
            [{ params: { id: OTHER_ID }, body: { status: "rejected", rejectionReason: "no" } }, /at least 3/],
            [{ params: { id: OTHER_ID }, body: { status: "rejected", rejectionReason: "x".repeat(501) } }, /at most 500/],
            [{ params: { id: OTHER_ID }, body: { status: "rejected", rejectionReason: { $ne: "" } } }, /must be text/],
            [{ params: { id: OTHER_ID }, body: { status: "resubmit", rejectionReason: ["a", "b"] } }, /must be text/],
        ];
        for (const [over, message] of cases) {
            await assertRejected(verifyUserKyc, { user: ADMIN, ...over }, 400, message);
        }
    });

    it("accepts a 500 character reason", async () => {
        record(User, "updateOne", async () => ({ matchedCount: 1 }));
        const res = await verify({ status: "rejected", rejectionReason: "x".repeat(500) });
        assert.equal(res.body.kyc.rejectionReason.length, 500);
    });
});

/* ---------- equipment review ---------- */

describe("listEquipmentForReview", () => {
    function stubEquipmentList(docs = [{ _id: EQUIPMENT_ID }], total = docs.length) {
        const query = stubQuery(Equipment, "find", docs);
        const counts = record(Equipment, "countDocuments", async () => total);
        return { query, counts };
    }

    it("defaults to pending listings, newest first, with the owner's public details", async () => {
        const docs = [{ _id: EQUIPMENT_ID, status: "pending" }];
        const { query, counts } = stubEquipmentList(docs, 9);
        const res = await call(listEquipmentForReview, { user: ADMIN });

        assert.deepEqual(query.staticCalls, [[{ status: "pending" }]]);
        assert.deepEqual(counts, [[{ status: "pending" }]]);
        assert.deepEqual(callsTo(query, "sort"), [[{ createdAt: -1, _id: -1 }]]);
        assert.deepEqual(callsTo(query, "populate"), [["owner", "name email businessName"]]);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, { equipment: docs.map((d) => ({ ...d, images: [], imageCount: 0 })), page: 1, limit: 20, total: 9 });
    });

    it("filters by status, or lists everything for all", async () => {
        for (const status of ["pending", "approved", "rejected"]) {
            const { query } = stubEquipmentList([]);
            await call(listEquipmentForReview, { user: ADMIN, query: { status } });
            assert.deepEqual(query.staticCalls[0][0], { status });
        }
        const { query } = stubEquipmentList([]);
        await call(listEquipmentForReview, { user: ADMIN, query: { status: "all" } });
        assert.deepEqual(query.staticCalls[0][0], {});
    });

    it("pages with a ceiling and rejects bad statuses", async () => {
        const { query } = stubEquipmentList([]);
        await call(listEquipmentForReview, { user: ADMIN, query: { page: "2", limit: "500" } });
        assert.deepEqual(callsTo(query, "skip"), [[100]]);
        assert.deepEqual(callsTo(query, "limit"), [[100]]);

        for (const status of ["live", { $ne: "pending" }, ["pending"], 1]) {
            await assertRejected(listEquipmentForReview, { user: ADMIN, query: { status } }, 400);
        }
    });
});

describe("approveEquipment", () => {
    it("records the decision with updateOne, then returns the stored listing", async () => {
        const stored = { _id: EQUIPMENT_ID, status: "approved" };
        const updates = record(Equipment, "updateOne", async () => ({ matchedCount: 1 }));
        const reads = record(Equipment, "findById", async () => stored);
        const res = await call(approveEquipment, { user: ADMIN, params: { id: EQUIPMENT_ID } });

        assert.deepEqual(updates[0][0], { _id: EQUIPMENT_ID });
        const { $set } = updates[0][1];
        assert.equal($set.status, "approved");
        assert.equal($set.rejectionReason, "");
        assert.equal($set.reviewedBy, ADMIN_ID);
        assert.ok($set.reviewedAt instanceof Date);
        assert.deepEqual(reads, [[EQUIPMENT_ID]]);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, { message: "Equipment approved and live!", equipment: stored });
    });

    it("answers 404 for an unknown listing", async () => {
        record(Equipment, "updateOne", async () => ({ matchedCount: 0 }));
        record(Equipment, "findById", async () => null);
        await assertHttpError(call(approveEquipment, { user: ADMIN, params: { id: EQUIPMENT_ID } }), 404, "Equipment not found");
    });

    it("rejects invalid ids before the database", async () => {
        for (const id of ["12", "undefined", { $gt: "" }, [EQUIPMENT_ID]]) {
            await assertRejected(approveEquipment, { user: ADMIN, params: { id } }, 400, "Invalid id");
        }
    });
});

describe("rejectEquipment", () => {
    it("requires a reason and stores it with the decision", async () => {
        const stored = { _id: EQUIPMENT_ID, status: "rejected" };
        const updates = record(Equipment, "updateOne", async () => ({ matchedCount: 1 }));
        record(Equipment, "findById", async () => stored);
        const res = await call(rejectEquipment, {
            user: ADMIN,
            params: { id: EQUIPMENT_ID },
            body: { reason: "  Photos do not show the item  " },
        });

        const { $set } = updates[0][1];
        assert.equal($set.status, "rejected");
        assert.equal($set.rejectionReason, "Photos do not show the item");
        assert.equal($set.reviewedBy, ADMIN_ID);
        assert.ok($set.reviewedAt instanceof Date);
        assert.deepEqual(res.body, { message: "Equipment rejected", equipment: stored });
    });

    it("rejects missing, short, long and non-text reasons before the database", async () => {
        const params = { id: EQUIPMENT_ID };
        await assertRejected(rejectEquipment, { user: ADMIN, params, body: undefined }, 400, "reason is required");
        await assertRejected(rejectEquipment, { user: ADMIN, params, body: {} }, 400, "reason is required");
        await assertRejected(rejectEquipment, { user: ADMIN, params, body: { reason: "  " } }, 400, "reason is required");
        await assertRejected(rejectEquipment, { user: ADMIN, params, body: { reason: "no" } }, 400, /at least 3/);
        await assertRejected(rejectEquipment, { user: ADMIN, params, body: { reason: "x".repeat(501) } }, 400, /at most 500/);
        await assertRejected(rejectEquipment, { user: ADMIN, params, body: { reason: { $ne: "" } } }, 400, /must be text/);
        await assertRejected(rejectEquipment, { user: ADMIN, params: { id: "bad" }, body: { reason: "valid reason" } }, 400, "Invalid id");
    });

    it("answers 404 for an unknown listing", async () => {
        record(Equipment, "updateOne", async () => ({ matchedCount: 0 }));
        record(Equipment, "findById", async () => null);
        await assertHttpError(
            call(rejectEquipment, { user: ADMIN, params: { id: EQUIPMENT_ID }, body: { reason: "Not suitable" } }),
            404,
            "Equipment not found"
        );
    });
});

describe("reviewEquipment", () => {
    const review = (body, id = EQUIPMENT_ID) => call(reviewEquipment, { user: ADMIN, params: { id }, body });

    it("delegates approved to the approve logic", async () => {
        const stored = { _id: EQUIPMENT_ID, status: "approved" };
        const updates = record(Equipment, "updateOne", async () => ({ matchedCount: 1 }));
        record(Equipment, "findById", async () => stored);
        const res = await review({ status: "approved", reason: "ignored" });

        assert.equal(updates[0][1].$set.status, "approved");
        assert.equal(updates[0][1].$set.rejectionReason, "");
        assert.deepEqual(res.body, { message: "Equipment approved and live!", equipment: stored });
    });

    it("delegates rejected to the reject logic, reason included", async () => {
        const stored = { _id: EQUIPMENT_ID, status: "rejected" };
        const updates = record(Equipment, "updateOne", async () => ({ matchedCount: 1 }));
        record(Equipment, "findById", async () => stored);
        const res = await review({ status: "rejected", reason: "Missing documents" });

        assert.equal(updates[0][1].$set.status, "rejected");
        assert.equal(updates[0][1].$set.rejectionReason, "Missing documents");
        assert.deepEqual(res.body, { message: "Equipment rejected", equipment: stored });
    });

    it("rejects bad statuses and a missing rejection reason before the database", async () => {
        const params = { id: EQUIPMENT_ID };
        for (const status of [undefined, "", "pending", "APPROVED", { $ne: "x" }, ["approved"], 1]) {
            await assertRejected(reviewEquipment, { user: ADMIN, params, body: { status } }, 400, /status must be one of: approved, rejected/);
        }
        await assertRejected(reviewEquipment, { user: ADMIN, params, body: undefined }, 400, /status must be one of/);
        await assertRejected(reviewEquipment, { user: ADMIN, params, body: { status: "rejected" } }, 400, "reason is required");
        await assertRejected(reviewEquipment, { user: ADMIN, params: { id: "bad" }, body: { status: "approved" } }, 400, "Invalid id");
    });
});

/* ---------- route wiring ---------- */

const describeRoutes = (router) =>
    router.stack
        .filter((layer) => layer.route)
        .map((layer) => ({
            method: Object.keys(layer.route.methods)[0].toUpperCase(),
            path: layer.route.path,
            handlers: layer.route.stack.map((item) => item.handle),
        }));

/** Runs an authorizeRoles guard against a request with the given user. */
function runGuard(guard, user) {
    const res = fakeRes();
    const nextCalls = [];
    guard(fakeReq({ user }), res, (...args) => nextCalls.push(args));
    return { res, passed: nextCalls.length === 1 };
}

describe("kycRoutes", () => {
    const routes = describeRoutes(kycRouter);
    const find = (method, path) => routes.find((r) => r.method === method && r.path === path);

    it("exposes exactly GET /me and POST /", () => {
        assert.deepEqual(routes.map((r) => `${r.method} ${r.path}`).sort(), ["GET /me", "POST /"]);
    });

    it("authenticates GET /me", () => {
        assert.deepEqual(find("GET", "/me").handlers, [protect, getMyKyc]);
    });

    it("authenticates POST / and limits it to owners and renters", () => {
        const [first, guard, last, ...rest] = find("POST", "/").handlers;
        assert.equal(first, protect);
        assert.equal(last, submitKyc);
        assert.equal(rest.length, 0);
        assert.equal(runGuard(guard, { role: "owner" }).passed, true);
        assert.equal(runGuard(guard, { role: "renter" }).passed, true);
        const admin = runGuard(guard, { role: "admin" });
        assert.equal(admin.passed, false);
        assert.equal(admin.res.statusCode, 403);
        const anonymous = runGuard(guard, undefined);
        assert.equal(anonymous.res.statusCode, 401);
    });
});

describe("adminRoutes", () => {
    it("guards the whole router with protect, then an admin-only check, before any route", () => {
        const [first, second, ...routeLayers] = adminRouter.stack;
        assert.equal(first.route, undefined);
        assert.equal(second.route, undefined);
        assert.equal(first.handle, protect);
        assert.ok(routeLayers.length > 0);
        assert.ok(routeLayers.every((layer) => layer.route));

        const guard = second.handle;
        assert.equal(runGuard(guard, { role: "admin" }).passed, true);
        for (const role of ["owner", "renter"]) {
            const outcome = runGuard(guard, { role });
            assert.equal(outcome.passed, false, role);
            assert.equal(outcome.res.statusCode, 403);
            assert.deepEqual(outcome.res.body, { message: "Access denied" });
        }
        const anonymous = runGuard(guard, undefined);
        assert.equal(anonymous.res.statusCode, 401);
        assert.deepEqual(anonymous.res.body, { message: "Not authenticated" });
    });

    it("registers exactly the expected endpoints, each with a single handler", () => {
        const routes = describeRoutes(adminRouter);
        assert.deepEqual(
            routes.map((r) => `${r.method} ${r.path}`),
            [
                "GET /kyc",
                "GET /kyc/:id/document",
                "GET /kyc/:id/selfie",
                "PUT /verify-user/:id",
                "GET /equipment",
                "PUT /equipment/:id/approve",
                "PUT /equipment/:id/reject",
                "PUT /equipment/:id/review",
            ]
        );
        assert.ok(routes.every((r) => r.handlers.length === 1));
        const handler = (method, path) => routes.find((r) => r.method === method && r.path === path).handlers[0];
        assert.equal(handler("GET", "/kyc"), getKycSubmissions);
        assert.equal(handler("PUT", "/verify-user/:id"), verifyUserKyc);
        assert.equal(handler("GET", "/equipment"), listEquipmentForReview);
        assert.equal(handler("PUT", "/equipment/:id/approve"), approveEquipment);
        assert.equal(handler("PUT", "/equipment/:id/reject"), rejectEquipment);
        assert.equal(handler("PUT", "/equipment/:id/review"), reviewEquipment);
    });
});

/* ---------- over real HTTP (still no database) ---------- */

describe("admin API over HTTP", () => {
    const app = express();
    app.use(express.json());
    app.use("/api/admin", adminRouter);
    app.use(errorHandler);
    const serverReady = new Promise((resolve) => {
        const server = app.listen(0, "127.0.0.1", () => resolve(server));
    });
    after(async () => {
        const server = await serverReady;
        await new Promise((resolve) => server.close(resolve));
    });

    const account = (id, role) => ({ _id: id, role, name: role, email: `${role}@example.com`, kycStatus: "verified", isVerified: true, tokenVersion: 0 });
    const tokens = {
        admin: signToken(account(ADMIN_ID, "admin")),
        owner: signToken(account(USER_ID, "owner")),
    };

    /** The auth middleware and the handlers share one findById stub, keyed by user id. */
    function stubUsers() {
        const docs = {
            [ADMIN_ID]: account(ADMIN_ID, "admin"),
            [USER_ID]: account(USER_ID, "owner"),
            [OTHER_ID]: { _id: OTHER_ID, kycDetails: { documentUrl: DOCUMENT_URL, selfieUrl: SELFIE_URL } },
        };
        stub(User, "findById", (id) => fakeQuery(docs[id] ?? null));
    }

    /** Everything except the auth lookup: proves a refused request never reaches an admin query. */
    function forbidAdminQueries() {
        for (const [model, names] of [[User, ["find", "updateOne", "countDocuments"]], [Equipment, ["find", "updateOne", "findById", "countDocuments"]]]) {
            for (const name of names) {
                stub(model, name, () => {
                    throw new Error(`unexpected database call: ${name}`);
                });
            }
        }
    }

    async function request(path, { method = "GET", token, json } = {}) {
        const { port } = await serverReady.then((server) => server.address());
        const headers = {};
        if (token) headers.authorization = `Bearer ${token}`;
        if (json !== undefined) headers["content-type"] = "application/json";
        const res = await fetch(`http://127.0.0.1:${port}/api/admin${path}`, {
            method,
            headers,
            body: json === undefined ? undefined : JSON.stringify(json),
            signal: AbortSignal.timeout(10_000),
        });
        return res;
    }

    it("refuses anonymous callers and non-admins before any admin query runs", async () => {
        stubUsers();
        forbidAdminQueries();
        const anonymous = await request("/kyc");
        assert.equal(anonymous.status, 401);
        const owner = await request("/kyc", { token: tokens.owner });
        assert.equal(owner.status, 403);
        assert.deepEqual(await owner.json(), { message: "Access denied" });
        const put = await request(`/verify-user/${OTHER_ID}`, { method: "PUT", token: tokens.owner, json: {} });
        assert.equal(put.status, 403);
    });

    it("streams a KYC image as bytes with hardened headers for an admin", async () => {
        stubUsers();
        const doc = await request(`/kyc/${OTHER_ID}/document`, { token: tokens.admin });
        assert.equal(doc.status, 200);
        assert.equal(doc.headers.get("content-type"), "image/png");
        assert.equal(doc.headers.get("cache-control"), "private, no-store");
        assert.equal(doc.headers.get("x-content-type-options"), "nosniff");
        assert.equal(doc.headers.get("content-disposition"), 'inline; filename="kyc-document"');
        assert.equal(doc.headers.get("content-security-policy"), "default-src 'none'; sandbox");
        assert.ok(Buffer.from(await doc.arrayBuffer()).equals(DOCUMENT_BYTES));

        const selfie = await request(`/kyc/${OTHER_ID}/selfie`, { token: tokens.admin });
        assert.equal(selfie.status, 200);
        assert.equal(selfie.headers.get("content-type"), "image/jpeg");
        assert.ok(Buffer.from(await selfie.arrayBuffer()).equals(SELFIE_BYTES));
    });

    it("returns JSON errors for bad ids, unknown users and bad bodies", async () => {
        stubUsers();
        const badId = await request("/kyc/not-an-id/document", { token: tokens.admin });
        assert.equal(badId.status, 400);
        assert.deepEqual(await badId.json(), { message: "Invalid id" });

        const missing = await request(`/kyc/${EQUIPMENT_ID}/document`, { token: tokens.admin });
        assert.equal(missing.status, 404);
        assert.deepEqual(await missing.json(), { message: "KYC document not found" });

        const badStatus = await request(`/verify-user/${OTHER_ID}`, { method: "PUT", token: tokens.admin, json: { status: "maybe" } });
        assert.equal(badStatus.status, 400);

        const noReason = await request(`/equipment/${EQUIPMENT_ID}/review`, { method: "PUT", token: tokens.admin, json: { status: "rejected" } });
        assert.equal(noReason.status, 400);
        assert.deepEqual(await noReason.json(), { message: "reason is required" });
    });

    it("never leaks the message of an unexpected failure", async () => {
        stubUsers();
        stub(User, "updateOne", async () => {
            throw new Error("E11000 secret connection string mongodb://user:pass@host");
        });
        stub(console, "error", () => {});
        const res = await request(`/verify-user/${OTHER_ID}`, { method: "PUT", token: tokens.admin, json: { status: "verified" } });
        assert.equal(res.status, 500);
        assert.deepEqual(await res.json(), { message: "Internal server error" });
    });
});
