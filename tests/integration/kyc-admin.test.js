import "../helpers/setEnv.js";
/**
 * End to end: KYC submission (POST /api/kyc, GET /api/kyc/me) and the admin
 * review routes (KYC list, KYC images, verify-user, equipment review) against
 * the real app and the disposable MongoDB named by TEST_MONGO_URI.
 *
 * The blocks run in order on one database and build on each other: every
 * person's expected KYC state is tracked on its record below (`status`, `kyc`)
 * and only changes when the API answered 200.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import zlib from "node:zlib";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { dropDatabase, startTestServer } from "../helpers/testServer.js";
import Equipment from "../../Models/equipment.js";
import User from "../../Models/user.js";

/* ---------- real, tiny images built from bytes ---------- */

const MiB = 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
}

/** A decodable 8-bit RGB PNG of one flat colour. `padTo` grows it to exactly that many bytes with a tEXt chunk. */
function makePng(width, height, [r, g, b], { padTo } = {}) {
    const header = Buffer.alloc(13); // compression, filter and interlace methods stay 0
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8; // bit depth
    header[9] = 2; // colour type: truecolour
    const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
    const pixels = zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
    const parts = [PNG_SIGNATURE, pngChunk("IHDR", header), pngChunk("IDAT", pixels)];
    const end = pngChunk("IEND", Buffer.alloc(0));
    if (padTo) {
        const keyword = Buffer.from("Comment\0", "latin1");
        const used = parts.reduce((n, part) => n + part.length, 0) + end.length + 12 + keyword.length;
        assert.ok(padTo >= used, "padTo is smaller than the bare image");
        parts.push(pngChunk("tEXt", Buffer.concat([keyword, Buffer.alloc(padTo - used, 0x2e)])));
    }
    return Buffer.concat([...parts, end]);
}

// A complete 1x1 baseline JPEG (SOI, JFIF APP0, DQT, SOF0, DHT, SOS, EOI), 287 bytes.
const JPEG_1PX = Buffer.from(
    "ffd8ffe000104a46494600010100000100010000ffdb004300100b0c0e0c0a100e0d0e1211101318281a181616183123251d283a333d3c" +
        "3933383740485c4e404457453738506d51575f626768673e4d71797064785c656763ffdb0043011112121815182f1a1a2f634238426363" +
        "636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363ffc0001108000100" +
        "0103012200021101031101ffc4001500010100000000000000000000000000000005ffc40014100100000000000000000000000000000000" +
        "ffc4001501010100000000000000000000000000000306ffc40014110100000000000000000000000000000000ffda000c03010002110311" +
        "003f00920014efffd9",
    "hex"
);

/** The same JPEG with a COM segment after APP0: still a valid file, with distinct bytes. */
function makeJpeg(comment) {
    const app0End = 4 + JPEG_1PX.readUInt16BE(4);
    const payload = Buffer.from(comment, "latin1");
    const marker = Buffer.from([0xff, 0xfe, 0, 0]);
    marker.writeUInt16BE(payload.length + 2, 2);
    return Buffer.concat([JPEG_1PX.subarray(0, app0End), marker, payload, JPEG_1PX.subarray(app0End)]);
}

let seq = 0;
const nextPng = () => {
    seq += 1;
    return makePng(1 + (seq % 3), 1 + (seq % 2), [(seq * 37) % 256, (seq * 91) % 256, (seq * 53) % 256]);
};
const nextJpeg = () => {
    seq += 1;
    return makeJpeg(`rentit kyc test image ${seq}`);
};

const mimeOf = (buf) => (buf[0] === 0xff ? "image/jpeg" : "image/png");
const toDataUrl = (buf, mime = mimeOf(buf)) => `data:${mime};base64,${buf.toString("base64")}`;

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.domain)"><script>alert(1)</script></svg>');
const HTML = Buffer.from("<!doctype html><html><script>alert(1)</script></html>");

/* ---------- people ---------- */

const PASSWORD = "Sturdy-Passw0rd";

const admin = { name: "Ada Admin", email: "ada.admin@example.com", role: "admin" };
const alice = { name: "Alice Renter", email: "alice.renter@example.com", role: "renter", phone: "+2348011111111" };
const bob = { name: "Bob Owner", email: "bob.owner@example.com", role: "owner", businessName: "Bob's Plant Hire" };
const carol = { name: "Carol Fresh", email: "carol.fresh@example.com", role: "renter" }; // never submits KYC
const gina = { name: "Gina Listing", email: "gina.listing@example.com", role: "renter" };
const hank = { name: "Hank Listing", email: "hank.listing@example.com", role: "owner" };
const ivy = { name: "Ivy Listing", email: "ivy.listing@example.com", role: "renter" };
const dana = { name: "Dana (Parens) Star", email: "dana.star@example.com", role: "renter" };
const leo = { name: "Leo Legacy", email: "leo.legacy@example.com", role: "renter" }; // legacy KYC row, seeded
const lena = { name: "Lena Brokenimage", email: "lena.broken@example.com", role: "renter" }; // seeded only, never logs in

const people = [alice, bob, carol, gina, hank, ivy, dana, leo, lena];
for (const person of [admin, ...people]) person.status = "not_submitted";

/* ---------- helpers ---------- */

let server;
const api = (path, options) => server.request(path, options);

async function login(person) {
    const res = await api("/api/auth/login", { method: "POST", json: { email: person.email, password: PASSWORD } });
    assert.equal(res.status, 200, `login ${person.email}: ${JSON.stringify(res.body)}`);
    person.id = String(res.body.user.id);
    person.token = res.body.token;
    return person;
}

async function register(person) {
    const { name, email, role, phone, businessName } = person;
    const res = await api("/api/auth/register", {
        method: "POST",
        json: { name, email, password: PASSWORD, role, phone, businessName },
    });
    assert.equal(res.status, 201, `register ${email}: ${JSON.stringify(res.body)}`);
    return login(person);
}

/** POST /api/kyc as `person`. On 200 it records what was uploaded, so later tests know what to expect. */
async function submitKyc(person, options = {}) {
    const {
        document = nextPng(),
        selfie = nextJpeg(),
        documentType = "NIN",
        documentNumber = `ID-${person.email.split("@")[0]}-${++seq}`,
        address,
        extra = {},
    } = options;
    const json = { ...extra, documentType, documentNumber, documentUrl: toDataUrl(document), selfieUrl: toDataUrl(selfie) };
    if (address !== undefined) json.address = address;
    const res = await api("/api/kyc", { method: "POST", token: person.token, json });
    if (res.status === 200) {
        person.status = "under_review";
        person.kyc = { document, selfie, documentType, documentNumber: documentNumber.trim() };
    }
    return res;
}

/** PUT /api/admin/verify-user/:id. On 200 it records the new status. */
async function decide(person, json, token = admin.token) {
    const res = await api(`/api/admin/verify-user/${person.id}`, { method: "PUT", token, json });
    if (res.status === 200) person.status = res.body.kyc.status;
    return res;
}

const listKyc = (query = "", token = admin.token) => api(`/api/admin/kyc${query}`, { token });

/** The stored user with every select:false field, straight from the database. */
const readUser = (id) =>
    User.findById(id).select("+kycDetails.idNumber +kycDetails.documentUrl +kycDetails.selfieUrl +tokenVersion").lean();

/** GET that keeps the body as raw bytes (server.request decodes it as text). */
async function fetchRaw(path, token) {
    const res = await fetch(server.baseUrl + path, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(15_000),
    });
    return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
}

const sortedIds = (items) => items.map((item) => String(item.id ?? item._id)).sort();
const submittedIds = (status) =>
    people.filter((p) => p.status !== "not_submitted" && (!status || p.status === status)).map((p) => p.id).sort();

function assertNoKycSecrets(body, label = "response") {
    const text = JSON.stringify(body);
    assert.ok(!text.includes("data:image"), `${label} must not carry image data URLs`);
    assert.ok(!text.includes("iVBORw0KGgo") && !text.includes("/9j/"), `${label} must not carry base64 image bytes`);
    for (const key of ["documentUrl", "selfieUrl", "idNumber", "password", "tokenVersion"]) {
        assert.ok(!text.includes(`"${key}"`), `${label} must not include "${key}"`);
    }
    assert.ok(!/\$2[aby]\$\d\d\$/.test(text), `${label} must not include a password hash`);
}

function assertNoDocumentNumber(body, person, label = "response") {
    assert.ok(!JSON.stringify(body).includes(person.kyc.documentNumber), `${label} must not reveal the document number`);
}

/* ---------- lifecycle ---------- */

before(async () => {
    server = await startTestServer();
    await dropDatabase();
    const setup = await api("/api/auth/setup-admin", {
        method: "POST",
        headers: { "x-setup-token": process.env.SETUP_ADMIN_TOKEN },
        json: { name: admin.name, email: admin.email, password: PASSWORD },
    });
    assert.equal(setup.status, 201, JSON.stringify(setup.body));
    await Promise.all([login(admin), ...people.filter((p) => p !== lena).map(register)]);
});

after(async () => {
    if (!server) return;
    try {
        await dropDatabase();
    } finally {
        await server.close();
    }
});

/* ---------- POST /api/kyc ---------- */

describe("POST /api/kyc: submitting KYC", () => {
    const validBody = () => ({
        documentType: "NIN",
        documentNumber: "12345678901",
        documentUrl: toDataUrl(nextPng()),
        selfieUrl: toDataUrl(nextJpeg()),
        address: "1 Test Street",
    });

    it("refuses anonymous callers and bad tokens with 401", async () => {
        const anon = await api("/api/kyc", { method: "POST", json: validBody() });
        assert.equal(anon.status, 401);
        assert.deepEqual(anon.body, { message: "Not authorized, no token" });

        const junk = await api("/api/kyc", { method: "POST", token: "not.a.jwt", json: validBody() });
        assert.equal(junk.status, 401);
        assert.deepEqual(junk.body, { message: "Not authorized, invalid token" });

        const wrongScheme = await api("/api/kyc", {
            method: "POST",
            headers: { authorization: `Basic ${alice.token}` },
            json: validBody(),
        });
        assert.equal(wrongScheme.status, 401);
    });

    it("refuses admins with 403: only renters and owners submit KYC", async () => {
        const res = await api("/api/kyc", { method: "POST", token: admin.token, json: validBody() });
        assert.equal(res.status, 403);
        assert.deepEqual(res.body, { message: "Access denied" });
        assert.equal((await readUser(admin.id)).kycStatus, "not_submitted");
    });

    it("rejects invalid, disguised and injection-shaped input with 400 and stores nothing", async () => {
        const png = nextPng();
        const jpg = nextJpeg();
        const cases = [
            ["missing documentType", { documentType: undefined }, /^documentType must be one of: /],
            ["unknown documentType", { documentType: "Library card" }, /^documentType must be one of: /],
            ["operator object as documentType", { documentType: { $ne: null } }, /^documentType must be one of: /],
            ["array as documentType", { documentType: ["NIN"] }, /^documentType must be one of: /],
            ["missing documentNumber", { documentNumber: undefined }, /^documentNumber is required$/],
            ["blank documentNumber", { documentNumber: "    " }, /^documentNumber is required$/],
            ["short documentNumber", { documentNumber: "123" }, /^documentNumber must be at least 4 characters$/],
            ["oversize documentNumber", { documentNumber: "9".repeat(41) }, /^documentNumber must be at most 40 characters$/],
            ["operator object as documentNumber", { documentNumber: { $gt: "" } }, /^documentNumber must be text$/],
            ["number as documentNumber", { documentNumber: 12345678 }, /^documentNumber must be text$/],
            ["oversize address", { address: "x".repeat(201) }, /^address must be at most 200 characters$/],
            ["missing document", { documentUrl: undefined }, /^ID document must be an image$/],
            ["missing selfie", { selfieUrl: undefined }, /^Selfie must be an image$/],
            ["operator object as document", { documentUrl: { $regex: "." } }, /^ID document must be an image$/],
            [
                "remote URL as document",
                { documentUrl: "https://res.cloudinary.com/demo/image/upload/id.png" },
                /^ID document must be a JPEG, PNG or WebP image$/,
            ],
            ["GIF document", { documentUrl: toDataUrl(Buffer.from("GIF89a\x01\x00\x01\x00"), "image/gif") }, /^ID document must be a JPEG, PNG or WebP image$/],
            ["SVG document", { documentUrl: toDataUrl(SVG, "image/svg+xml") }, /^ID document must be a JPEG, PNG or WebP image$/],
            ["SVG disguised as PNG", { documentUrl: toDataUrl(SVG, "image/png") }, /^ID document is not a valid PNG image$/],
            ["HTML disguised as JPEG", { selfieUrl: toDataUrl(HTML, "image/jpeg") }, /^Selfie is not a valid JPEG image$/],
            ["PNG bytes declared as JPEG", { documentUrl: toDataUrl(png, "image/jpeg") }, /^ID document is not a valid JPEG image$/],
            ["JPEG bytes declared as PNG", { selfieUrl: toDataUrl(jpg, "image/png") }, /^Selfie is not a valid PNG image$/],
            ["JPEG bytes declared as WebP", { selfieUrl: toDataUrl(jpg, "image/webp") }, /^Selfie is not a valid WEBP image$/],
            ["non-base64 characters", { documentUrl: "data:image/png;base64,%%%%" }, /^ID document is not valid image data$/],
            ["empty image data", { documentUrl: "data:image/png;base64," }, /^ID document is not valid image data$/],
            [
                "base64 with line breaks",
                { documentUrl: `data:image/png;base64,${png.toString("base64").replace(/(.{8})/g, "$1\n")}` },
                /^ID document is not valid image data$/,
            ],
            [
                "document one byte over 2 MiB",
                { documentUrl: toDataUrl(makePng(1, 1, [1, 2, 3], { padTo: 2 * MiB + 1 })) },
                /^ID document is too large$/,
            ],
            [
                "document of 3 MiB",
                { documentUrl: toDataUrl(makePng(1, 1, [1, 2, 3], { padTo: 3 * MiB })) },
                /^ID document is too large \(max 2MB\)$/,
            ],
            [
                "selfie of 3 MiB",
                { selfieUrl: toDataUrl(makePng(1, 1, [1, 2, 3], { padTo: 3 * MiB })) },
                /^Selfie is too large \(max 2MB\)$/,
            ],
        ];
        for (const [label, overrides, message] of cases) {
            // JSON.stringify drops undefined values, so "missing" really is absent from the body.
            const res = await api("/api/kyc", { method: "POST", token: alice.token, json: { ...validBody(), ...overrides } });
            assert.equal(res.status, 400, `${label}: ${JSON.stringify(res.body)}`);
            assert.match(res.body.message, message, label);
        }

        const stored = await readUser(alice.id);
        assert.equal(stored.kycStatus, "not_submitted");
        assert.equal(stored.isVerified, false);
        assert.equal(stored.kycDetails?.submittedAt, undefined);
        assert.equal(stored.kycDetails?.documentUrl, undefined);
        assert.equal(stored.kycDetails?.idNumber, undefined);
    });

    it("rejects bodies that are not a JSON object with 400", async () => {
        const array = await api("/api/kyc", { method: "POST", token: alice.token, json: [validBody()] });
        assert.equal(array.status, 400);
        assert.match(array.body.message, /^documentType must be one of/);

        const headers = { "content-type": "application/json" };
        const scalar = await api("/api/kyc", { method: "POST", token: alice.token, body: '"hello"', headers });
        assert.equal(scalar.status, 400);
        assert.deepEqual(scalar.body, { message: "Invalid JSON body" });

        const malformed = await api("/api/kyc", { method: "POST", token: alice.token, body: '{"documentType": "NIN",', headers });
        assert.equal(malformed.status, 400);
        assert.deepEqual(malformed.body, { message: "Invalid JSON body" });

        assert.equal((await readUser(alice.id)).kycStatus, "not_submitted");
    });

    it("answers 413 to a body over 8mb, and 401 to an anonymous large body before parsing it", async () => {
        const huge = JSON.stringify({ ...validBody(), documentUrl: `data:image/png;base64,${"A".repeat(8.5 * MiB)}` });
        const headers = { "content-type": "application/json" };

        const signedIn = await api("/api/kyc", { method: "POST", token: alice.token, body: huge, headers });
        assert.equal(signedIn.status, 413);
        assert.deepEqual(signedIn.body, { message: "Request body too large" });

        const anon = await api("/api/kyc", { method: "POST", body: huge, headers });
        assert.equal(anon.status, 401);
        assert.deepEqual(anon.body, { message: "Not authorized, no token" });

        assert.equal((await readUser(alice.id)).kycStatus, "not_submitted");
    });

    it("accepts a renter's PNG document and JPEG selfie and stores exactly what was sent", async () => {
        const document = nextPng();
        const selfie = nextJpeg();
        const startedAt = Date.now();
        const res = await submitKyc(alice, {
            document,
            selfie,
            documentType: "NIN",
            documentNumber: "  NIN-7700112233  ",
            address: "  12 Marina Road, Lagos  ",
        });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.deepEqual(Object.keys(res.body).sort(), ["kyc", "message"]);
        assert.equal(res.body.message, "KYC submitted successfully");
        assert.deepEqual(Object.keys(res.body.kyc).sort(), ["status", "submittedAt"]);
        assert.equal(res.body.kyc.status, "under_review");
        const submittedAt = new Date(res.body.kyc.submittedAt);
        assert.ok(submittedAt.getTime() >= startedAt - 1000 && submittedAt.getTime() <= Date.now() + 1000);
        assertNoKycSecrets(res.body, "submit response");
        assertNoDocumentNumber(res.body, alice, "submit response");

        const stored = await readUser(alice.id);
        assert.equal(stored.kycStatus, "under_review");
        assert.equal(stored.isVerified, false);
        assert.equal(stored.kycRejectionReason, "");
        assert.equal(stored.address, "12 Marina Road, Lagos");
        const details = stored.kycDetails;
        assert.equal(details.idType, "NIN");
        assert.equal(details.idNumber, "NIN-7700112233");
        assert.equal(details.documentUrl, toDataUrl(document));
        assert.equal(details.selfieUrl, toDataUrl(selfie));
        assert.equal(details.documentMime, "image/png");
        assert.equal(details.selfieMime, "image/jpeg");
        assert.equal(details.documentBytes, document.length);
        assert.equal(details.selfieBytes, selfie.length);
        assert.equal(details.address, "12 Marina Road, Lagos");
        assert.equal(new Date(details.submittedAt).toISOString(), submittedAt.toISOString());
        alice.firstDocument = document;
    });

    it("accepts an owner and a legacy document type, ignoring fields a client must not set", async () => {
        const res = await submitKyc(bob, {
            document: nextJpeg(),
            selfie: nextPng(),
            documentType: "drivers_license",
            extra: {
                kycStatus: "verified",
                isVerified: true,
                kycRejectionReason: "none",
                role: "admin",
                userId: carol.id,
                _id: carol.id,
                kycDetails: { idNumber: "HIJACKED", documentBytes: 0 },
            },
        });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.kyc.status, "under_review");

        const stored = await readUser(bob.id);
        assert.equal(stored.kycStatus, "under_review");
        assert.equal(stored.isVerified, false);
        assert.equal(stored.role, "owner");
        assert.equal(stored.kycRejectionReason, "");
        assert.equal(stored.kycDetails.idType, "drivers_license");
        assert.equal(stored.kycDetails.idNumber, bob.kyc.documentNumber);
        assert.equal(stored.kycDetails.documentMime, "image/jpeg");
        assert.equal(stored.kycDetails.selfieMime, "image/png");
        assert.equal(stored.kycDetails.documentBytes, bob.kyc.document.length);

        // The ids in the body did not redirect the write to another account.
        const other = await readUser(carol.id);
        assert.equal(other.kycStatus, "not_submitted");
        assert.equal(other.kycDetails?.idNumber, undefined);
    });

    it("accepts an image of exactly 2 MiB, the documented limit", async () => {
        const document = makePng(1, 1, [9, 9, 9], { padTo: 2 * MiB });
        assert.equal(document.length, 2 * MiB);
        const res = await submitKyc(gina, { document, selfie: nextJpeg(), documentType: "Voter's card" });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        const stored = await readUser(gina.id);
        assert.equal(stored.kycDetails.documentBytes, 2 * MiB);
        assert.equal(stored.kycDetails.idType, "Voter's card");
    });

    it("answers 409 to a second submission while the first is under review, keeping the first", async () => {
        const res = await submitKyc(alice, { documentNumber: "NIN-0000000000" });
        assert.equal(res.status, 409);
        assert.deepEqual(res.body, { message: "KYC is already under review or verified" });

        const stored = await readUser(alice.id);
        assert.equal(stored.kycStatus, "under_review");
        assert.equal(stored.kycDetails.idNumber, "NIN-7700112233");
        assert.equal(stored.kycDetails.documentUrl, toDataUrl(alice.kyc.document));
        assert.equal(stored.kycDetails.selfieUrl, toDataUrl(alice.kyc.selfie));

        assert.equal((await submitKyc(bob)).status, 409);
    });
});

/* ---------- GET /api/kyc/me ---------- */

describe("GET /api/kyc/me", () => {
    it("refuses anonymous callers with 401", async () => {
        assert.equal((await api("/api/kyc/me")).status, 401);
        assert.equal((await api("/api/kyc/me", { token: `${alice.token}x` })).status, 401);
    });

    it("answers 404 to users who never submitted, admins included", async () => {
        for (const person of [carol, admin]) {
            const res = await api("/api/kyc/me", { token: person.token });
            assert.equal(res.status, 404, person.email);
            assert.deepEqual(res.body, { message: "KYC record not found" });
        }
    });

    it("returns the status and metadata, but never the images or the document number", async () => {
        const res = await api("/api/kyc/me", { token: alice.token });
        assert.equal(res.status, 200);
        const stored = await readUser(alice.id);
        assert.deepEqual(res.body, {
            kyc: {
                status: "under_review",
                rejectionReason: "",
                documentType: "NIN",
                address: "12 Marina Road, Lagos",
                submittedAt: stored.kycDetails.submittedAt.toISOString(),
                hasDocument: true,
                hasSelfie: true,
            },
        });
        assertNoKycSecrets(res.body, "/api/kyc/me");
        assertNoDocumentNumber(res.body, alice, "/api/kyc/me");
    });

    it("the profile and login responses do not leak KYC images or the document number either", async () => {
        const me = await api("/api/auth/me", { token: alice.token });
        assert.equal(me.status, 200);
        assert.equal(me.body.user.kycStatus, "under_review");
        assert.equal(me.body.user.isVerified, false);
        assertNoKycSecrets(me.body, "/api/auth/me");
        assertNoDocumentNumber(me.body, alice, "/api/auth/me");

        const signIn = await api("/api/auth/login", { method: "POST", json: { email: alice.email, password: PASSWORD } });
        assert.equal(signIn.status, 200);
        assertNoKycSecrets(signIn.body.user, "login response");
        assertNoDocumentNumber(signIn.body, alice, "login response");
    });
});

/* ---------- PUT /api/admin/verify-user/:id ---------- */

describe("PUT /api/admin/verify-user/:id", () => {
    it("refuses anonymous callers, renters and owners, even on their own record", async () => {
        const path = (person) => `/api/admin/verify-user/${person.id}`;
        const json = { status: "verified" };
        assert.equal((await api(path(alice), { method: "PUT", json })).status, 401);
        for (const [caller, target] of [[alice, alice], [alice, bob], [bob, bob], [bob, alice]]) {
            const res = await api(path(target), { method: "PUT", token: caller.token, json });
            assert.equal(res.status, 403, `${caller.email} -> ${target.email}`);
            assert.deepEqual(res.body, { message: "Access denied" });
        }
        for (const person of [alice, bob]) {
            const stored = await readUser(person.id);
            assert.equal(stored.kycStatus, "under_review");
            assert.equal(stored.isVerified, false);
        }
    });

    it("validates the decision and the reason, changing nothing on 400", async () => {
        const cases = [
            [{ status: "rejected" }, /^rejectionReason is required$/],
            [{ status: "resubmit" }, /^rejectionReason is required$/],
            [{ status: "rejected", rejectionReason: "    " }, /^rejectionReason is required$/],
            [{ status: "rejected", rejectionReason: " ab " }, /^rejectionReason must be at least 3 characters$/],
            [{ status: "resubmit", rejectionReason: "r".repeat(501) }, /^rejectionReason must be at most 500 characters$/],
            [{ status: "rejected", rejectionReason: { $ne: "" } }, /^rejectionReason must be text$/],
            [{ status: "rejected", rejectionReason: ["Blurry photo"] }, /^rejectionReason must be text$/],
            [{ status: "not_submitted" }, /^status must be one of: verified, rejected, resubmit$/],
            [{ status: "under_review" }, /^status must be one of: verified, rejected, resubmit$/],
            [{ status: "approved" }, /^status must be one of: verified, rejected, resubmit$/],
            [{ status: { $ne: "rejected" } }, /^status must be text$/],
            [{ status: ["verified"] }, /^status must be text$/],
            [{ status: "v".repeat(21) }, /^status must be at most 20 characters$/],
        ];
        for (const [json, message] of cases) {
            const res = await decide(alice, json);
            assert.equal(res.status, 400, `${JSON.stringify(json).slice(0, 80)}: ${JSON.stringify(res.body)}`);
            assert.match(res.body.message, message);
        }
        const stored = await readUser(alice.id);
        assert.equal(stored.kycStatus, "under_review");
        assert.equal(stored.isVerified, false);
        assert.equal(stored.kycRejectionReason, "");
    });

    it("answers 413 to an oversize body: the admin routes keep the 100kb limit", async () => {
        const res = await decide(alice, { status: "rejected", rejectionReason: "x".repeat(150 * 1024) });
        assert.equal(res.status, 413);
        assert.equal((await readUser(alice.id)).kycStatus, "under_review");
    });

    it("answers 400 to malformed ids and 404 to unknown or never-submitted users", async () => {
        for (const id of ["123", "z".repeat(24), `${alice.id}0`, encodeURIComponent('{"$ne":null}')]) {
            const res = await api(`/api/admin/verify-user/${id}`, { method: "PUT", token: admin.token, json: { status: "verified" } });
            assert.equal(res.status, 400, id);
            assert.deepEqual(res.body, { message: "Invalid id" });
        }
        const unknown = { id: new mongoose.Types.ObjectId().toString() };
        for (const person of [unknown, carol, admin]) {
            const res = await decide(person, { status: "verified" });
            assert.equal(res.status, 404, person.email ?? "unknown id");
            assert.deepEqual(res.body, { message: "KYC submission not found" });
        }
        const stored = await readUser(carol.id);
        assert.equal(stored.kycStatus, "not_submitted");
        assert.equal(stored.isVerified, false);
        assert.equal(await User.exists({ _id: unknown.id }), null);
    });

    it("rejects with a trimmed reason, which the user then sees", async () => {
        const res = await decide(alice, { status: "rejected", rejectionReason: "  The document photo is blurry  " });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.deepEqual(res.body, {
            message: "User KYC rejected",
            kyc: { id: alice.id, status: "rejected", rejectionReason: "The document photo is blurry" },
        });
        assertNoKycSecrets(res.body, "verify-user response");

        const stored = await readUser(alice.id);
        assert.equal(stored.kycStatus, "rejected");
        assert.equal(stored.isVerified, false);
        assert.equal(stored.kycRejectionReason, "The document photo is blurry");

        const me = await api("/api/kyc/me", { token: alice.token });
        assert.equal(me.body.kyc.status, "rejected");
        assert.equal(me.body.kyc.rejectionReason, "The document photo is blurry");
    });

    it("lets a rejected user submit again, clearing the reason and replacing the images", async () => {
        const document = nextJpeg();
        const selfie = nextPng();
        const res = await submitKyc(alice, { document, selfie, documentType: "International passport", documentNumber: "A12345678" });
        assert.equal(res.status, 200, JSON.stringify(res.body));

        const stored = await readUser(alice.id);
        assert.equal(stored.kycStatus, "under_review");
        assert.equal(stored.kycRejectionReason, "");
        assert.equal(stored.isVerified, false);
        assert.equal(stored.kycDetails.idType, "International passport");
        assert.equal(stored.kycDetails.idNumber, "A12345678");
        assert.equal(stored.kycDetails.documentUrl, toDataUrl(document));
        assert.equal(stored.kycDetails.documentMime, "image/jpeg");
        assert.equal(stored.kycDetails.selfieMime, "image/png");

        const me = await api("/api/kyc/me", { token: alice.token });
        assert.equal(me.body.kyc.status, "under_review");
        assert.equal(me.body.kyc.rejectionReason, "");
        assert.equal(me.body.kyc.documentType, "International passport");
    });

    it("asks for a resubmission with a reason, after which the user may submit again", async () => {
        const res = await decide(alice, { status: "resubmit", rejectionReason: "Your face must be visible in the selfie" });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.message, "User KYC resubmit");
        let stored = await readUser(alice.id);
        assert.equal(stored.kycStatus, "resubmit");
        assert.equal(stored.isVerified, false);
        assert.equal(stored.kycRejectionReason, "Your face must be visible in the selfie");
        const me = await api("/api/kyc/me", { token: alice.token });
        assert.equal(me.body.kyc.status, "resubmit");
        assert.equal(me.body.kyc.rejectionReason, "Your face must be visible in the selfie");

        const again = await submitKyc(alice, { document: nextJpeg(), selfie: nextPng(), documentType: "Driver's licence", documentNumber: "DL-55667788" });
        assert.equal(again.status, 200, JSON.stringify(again.body));
        stored = await readUser(alice.id);
        assert.equal(stored.kycStatus, "under_review");
        assert.equal(stored.kycRejectionReason, "");
        assert.equal(stored.kycDetails.idNumber, "DL-55667788");
    });

    it("verifies case-insensitively, ignores any reason, and persists isVerified", async () => {
        const res = await decide(alice, { status: "VERIFIED", rejectionReason: "should be ignored" });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.deepEqual(res.body, { message: "User KYC verified", kyc: { id: alice.id, status: "verified", rejectionReason: "" } });

        const stored = await readUser(alice.id);
        assert.equal(stored.kycStatus, "verified");
        assert.equal(stored.isVerified, true);
        assert.equal(stored.kycRejectionReason, "");

        const profile = await api("/api/auth/me", { token: alice.token });
        assert.equal(profile.body.user.kycStatus, "verified");
        assert.equal(profile.body.user.isVerified, true);
        assert.equal((await api("/api/kyc/me", { token: alice.token })).body.kyc.status, "verified");
    });

    it("answers 409 to a submission once verified and leaves the verified record alone", async () => {
        const beforeAttempt = await readUser(alice.id);
        const res = await submitKyc(alice, { documentNumber: "NIN-1111111111" });
        assert.equal(res.status, 409);
        assert.deepEqual(res.body, { message: "KYC is already under review or verified" });
        const stored = await readUser(alice.id);
        assert.equal(stored.kycStatus, "verified");
        assert.equal(stored.isVerified, true);
        assert.deepEqual(stored.kycDetails, beforeAttempt.kycDetails);
    });

    it("treats a missing status as verified, and a later rejection revokes isVerified", async () => {
        const res = await decide(bob, undefined); // no body at all
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.kyc.status, "verified");
        assert.equal((await readUser(bob.id)).isVerified, true);

        const revoke = await decide(bob, { status: "rejected", rejectionReason: "The licence has expired" });
        assert.equal(revoke.status, 200);
        const stored = await readUser(bob.id);
        assert.equal(stored.kycStatus, "rejected");
        assert.equal(stored.isVerified, false);
        assert.equal((await api("/api/auth/me", { token: bob.token })).body.user.isVerified, false);

        const again = await submitKyc(bob, { document: nextJpeg(), selfie: nextPng() });
        assert.equal(again.status, 200, JSON.stringify(again.body));
        assert.equal((await readUser(bob.id)).kycStatus, "under_review");
    });
});

/* ---------- legacy rows ---------- */

describe("legacy KYC rows written before byte counts were recorded", () => {
    before(async () => {
        // The API always records byte counts and mime types now, so these states can only be seeded directly.
        leo.kyc = { document: nextJpeg(), selfie: nextPng(), documentType: "passport", documentNumber: "A01234567" };
        await User.collection.updateOne(
            { _id: new mongoose.Types.ObjectId(leo.id) },
            {
                $set: {
                    kycStatus: "under_review",
                    kycDetails: {
                        idType: "passport",
                        idNumber: "A01234567",
                        documentUrl: toDataUrl(leo.kyc.document),
                        selfieUrl: toDataUrl(leo.kyc.selfie),
                        address: "4 Old Road, Ibadan",
                        submittedAt: new Date("2023-03-01T10:00:00Z"),
                    },
                },
            }
        );
        leo.status = "under_review";

        // Stored before image signatures were checked: the "PNG" document is really an SVG with script.
        lena.kyc = { document: SVG, selfie: nextPng(), documentType: "NIN", documentNumber: "LEGACY-0099" };
        const created = new Date("2022-05-01T10:00:00Z");
        const { insertedId } = await User.collection.insertOne({
            name: lena.name,
            email: lena.email,
            password: `$2b$12$${"x".repeat(53)}`,
            role: "renter",
            kycStatus: "under_review",
            kycDetails: {
                idType: "NIN",
                idNumber: "LEGACY-0099",
                documentUrl: toDataUrl(SVG, "image/png"),
                selfieUrl: toDataUrl(lena.kyc.selfie),
                submittedAt: new Date("2022-06-01T10:00:00Z"),
            },
            kycRejectionReason: "",
            isVerified: false,
            tokenVersion: 0,
            createdAt: created,
            updatedAt: created,
        });
        lena.id = String(insertedId);
        lena.status = "under_review";
    });

    it("the seeded rows really carry no byte counts or mime types", async () => {
        for (const person of [leo, lena]) {
            const raw = await User.collection.findOne({ _id: new mongoose.Types.ObjectId(person.id) });
            for (const key of ["documentBytes", "selfieBytes", "documentMime", "selfieMime"]) {
                assert.equal(Object.hasOwn(raw.kycDetails, key), false, `${person.email} ${key}`);
            }
        }
    });

    it("the admin list reports both images as present", async () => {
        const res = await listKyc(`?q=${encodeURIComponent(leo.email)}`);
        assert.equal(res.status, 200);
        assert.equal(res.body.total, 1);
        const [item] = res.body.kyc;
        assert.equal(item.id, leo.id);
        assert.equal(item.hasDocument, true);
        assert.equal(item.hasSelfie, true);
        assert.equal(item.documentType, "passport");
        assert.equal(item.documentNumber, "A01234567");
        assert.equal(item.address, "4 Old Road, Ibadan");
        assert.equal(item.submittedAt, "2023-03-01T10:00:00.000Z");
        assertNoKycSecrets(res.body, "admin list");
    });

    it("the legacy user sees both images as present, without the document number", async () => {
        const res = await api("/api/kyc/me", { token: leo.token });
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.kyc, {
            status: "under_review",
            rejectionReason: "",
            documentType: "passport",
            address: "4 Old Road, Ibadan",
            submittedAt: "2023-03-01T10:00:00.000Z",
            hasDocument: true,
            hasSelfie: true,
        });
        assertNoDocumentNumber(res.body, leo, "/api/kyc/me");
    });

    it("still serves the legacy document and selfie, typed from their bytes", async () => {
        for (const [kind, buf] of [["document", leo.kyc.document], ["selfie", leo.kyc.selfie]]) {
            const res = await fetchRaw(`/api/admin/kyc/${leo.id}/${kind}`, admin.token);
            assert.equal(res.status, 200, kind);
            assert.equal(res.headers.get("content-type"), mimeOf(buf), kind);
            assert.ok(res.buffer.equals(buf), `${kind} bytes differ from the stored image`);
        }
    });

    it("answers 404 instead of serving a stored 'image' that is really SVG, and still serves the valid selfie", async () => {
        const doc = await fetchRaw(`/api/admin/kyc/${lena.id}/document`, admin.token);
        assert.equal(doc.status, 404);
        assert.match(doc.headers.get("content-type"), /^application\/json/);
        assert.deepEqual(JSON.parse(doc.buffer.toString()), { message: "KYC document not found" });
        assert.ok(!doc.buffer.toString().includes("<svg"));

        const selfie = await fetchRaw(`/api/admin/kyc/${lena.id}/selfie`, admin.token);
        assert.equal(selfie.status, 200);
        assert.equal(selfie.headers.get("content-type"), "image/png");
        assert.ok(selfie.buffer.equals(lena.kyc.selfie));
    });
});

/* ---------- GET /api/admin/kyc ---------- */

describe("GET /api/admin/kyc: the review list", () => {
    before(async () => {
        assert.equal((await submitKyc(hank)).status, 200);
        assert.equal((await decide(hank, { status: "verified" })).status, 200);
        assert.equal((await submitKyc(ivy)).status, 200);
        assert.equal((await decide(ivy, { status: "rejected", rejectionReason: "Name does not match the account" })).status, 200);
        assert.equal((await submitKyc(dana)).status, 200);
        assert.equal((await decide(dana, { status: "resubmit", rejectionReason: "Upload the back of the card too" })).status, 200);
    });

    it("refuses anonymous callers, renters and owners", async () => {
        assert.equal((await api("/api/admin/kyc")).status, 401);
        assert.equal((await listKyc("", "junk")).status, 401);
        assert.equal((await listKyc("", alice.token)).status, 403);
        assert.equal((await listKyc("", bob.token)).status, 403);
    });

    it("lists every submitted user, newest first, never those who have not submitted", async () => {
        const res = await listKyc();
        assert.equal(res.status, 200);
        assert.deepEqual(Object.keys(res.body).sort(), ["kyc", "limit", "page", "total"]);
        assert.equal(res.body.page, 1);
        assert.equal(res.body.limit, 20);
        assert.equal(res.body.total, 8);
        assert.deepEqual(sortedIds(res.body.kyc), submittedIds());
        const ids = res.body.kyc.map((item) => item.id);
        assert.ok(!ids.includes(carol.id) && !ids.includes(admin.id));

        const times = res.body.kyc.map((item) => new Date(item.submittedAt).getTime());
        for (let i = 1; i < times.length; i += 1) assert.ok(times[i - 1] >= times[i], "not sorted newest first");
        assert.deepEqual(ids.slice(-2), [leo.id, lena.id]);
    });

    it("returns the review fields, including the document number, but never image data or secrets", async () => {
        const res = await listKyc("?limit=100");
        assertNoKycSecrets(res.body, "admin list");
        const byId = new Map(res.body.kyc.map((item) => [item.id, item]));

        const stored = await readUser(alice.id);
        assert.deepEqual(byId.get(alice.id), {
            id: alice.id,
            name: alice.name,
            email: alice.email,
            phone: alice.phone,
            address: "12 Marina Road, Lagos",
            role: "renter",
            status: "verified",
            documentType: "Driver's licence",
            documentNumber: "DL-55667788",
            hasDocument: true,
            hasSelfie: true,
            documentPath: `/admin/kyc/${alice.id}/document`,
            selfiePath: `/admin/kyc/${alice.id}/selfie`,
            submittedAt: stored.kycDetails.submittedAt.toISOString(),
            rejectionReason: "",
        });

        const bobItem = byId.get(bob.id);
        assert.equal(bobItem.role, "owner");
        assert.equal(bobItem.phone, "");
        assert.equal(bobItem.documentNumber, bob.kyc.documentNumber);
        assert.equal(byId.get(ivy.id).rejectionReason, "Name does not match the account");
        assert.equal(byId.get(dana.id).rejectionReason, "Upload the back of the card too");
        for (const item of res.body.kyc) {
            assert.equal(item.status, people.find((p) => p.id === item.id).status, item.email);
        }
    });

    it("filters by each status, case-insensitively", async () => {
        const expected = { under_review: 4, verified: 2, rejected: 1, resubmit: 1, all: 8 };
        for (const [status, count] of Object.entries(expected)) {
            const res = await listKyc(`?status=${status}`);
            assert.equal(res.status, 200, status);
            assert.equal(res.body.total, count, status);
            assert.deepEqual(sortedIds(res.body.kyc), submittedIds(status === "all" ? undefined : status), status);
            if (status !== "all") assert.ok(res.body.kyc.every((item) => item.status === status), status);
        }
        assert.deepEqual(sortedIds((await listKyc("?status=Rejected")).body.kyc), [ivy.id]);
        assert.equal((await listKyc("?status=")).body.total, 8);
    });

    it("rejects unknown, unsubmitted and repeated status values with 400", async () => {
        for (const query of ["?status=not_submitted", "?status=pending", "?status=%24ne"]) {
            const res = await listKyc(query);
            assert.equal(res.status, 400, query);
            assert.match(res.body.message, /^status must be one of: under_review, verified, rejected, resubmit, all$/);
        }
        const repeated = await listKyc("?status=verified&status=rejected");
        assert.equal(repeated.status, 400);
        assert.deepEqual(repeated.body, { message: "status must be text" });
        const long = await listKyc(`?status=${"x".repeat(21)}`);
        assert.equal(long.status, 400);
    });

    it("searches name and email case-insensitively, combined with the status filter", async () => {
        const search = async (query) => {
            const res = await listKyc(query);
            assert.equal(res.status, 200, query);
            assert.equal(res.body.total, res.body.kyc.length, query);
            return sortedIds(res.body.kyc);
        };
        assert.deepEqual(await search("?q=GINA"), [gina.id]);
        assert.deepEqual(await search(`?q=${encodeURIComponent("hank.listing@")}`), [hank.id]);
        assert.deepEqual(await search("?q=listing"), [gina.id, hank.id, ivy.id].sort());
        assert.deepEqual(await search("?q=listing&status=rejected"), [ivy.id]);
        assert.deepEqual(await search("?q=nobody-matches-this"), []);
        // Carol matches by name but never submitted.
        assert.deepEqual(await search("?q=carol"), []);
        assert.equal((await listKyc(`?q=${encodeURIComponent("   ")}`)).body.total, 8);
    });

    it("treats regex metacharacters in q literally: no crash, no match-everything", async () => {
        const literalMisses = [".*", ".+", "a|b", "[", "]", "\\", "+", "?", "*", "^", "$", "{", "}", "(?i)", "\\w+", "$where", "|"];
        for (const q of literalMisses) {
            const res = await listKyc(`?q=${encodeURIComponent(q)}`);
            assert.equal(res.status, 200, `q=${q}: ${JSON.stringify(res.body)}`);
            assert.equal(res.body.total, 0, `q=${q} must match only names or emails that contain it literally`);
            assert.deepEqual(res.body.kyc, []);
        }
        for (const q of ["(", ")", "(Parens)", "(parens) star", "Dana (P"]) {
            const res = await listKyc(`?q=${encodeURIComponent(q)}`);
            assert.equal(res.status, 200, `q=${q}`);
            assert.deepEqual(sortedIds(res.body.kyc), [dana.id], `q=${q}`);
            assert.equal(res.body.total, 1, `q=${q}`);
        }
    });

    it("does not read operators from bracketed query keys, and rejects oversize or repeated q", async () => {
        for (const query of ["?q[$regex]=.*", "?status[$ne]=verified", "?q[$where]=1"]) {
            const res = await listKyc(query);
            assert.equal(res.status, 200, query);
            assert.equal(res.body.total, 8, query);
        }
        const long = await listKyc(`?q=${"a".repeat(61)}`);
        assert.equal(long.status, 400);
        assert.deepEqual(long.body, { message: "q must be at most 60 characters" });
        const repeated = await listKyc("?q=a&q=b");
        assert.equal(repeated.status, 400);
        assert.deepEqual(repeated.body, { message: "q must be text" });
    });

    it("paginates with consistent totals and without overlap", async () => {
        const full = (await listKyc("?limit=100")).body.kyc.map((item) => item.id);
        assert.equal(full.length, 8);

        const seen = [];
        for (const [page, size] of [[1, 3], [2, 3], [3, 2], [4, 0]]) {
            const res = await listKyc(`?limit=3&page=${page}`);
            assert.equal(res.status, 200);
            assert.equal(res.body.page, page);
            assert.equal(res.body.limit, 3);
            assert.equal(res.body.total, 8);
            assert.equal(res.body.kyc.length, size, `page ${page}`);
            seen.push(...res.body.kyc.map((item) => item.id));
        }
        assert.deepEqual(seen, full);

        const reviewOrder = (await listKyc("?status=under_review")).body.kyc.map((item) => item.id);
        const second = await listKyc("?status=under_review&limit=1&page=2");
        assert.equal(second.body.total, 4);
        assert.deepEqual(second.body.kyc.map((item) => item.id), [reviewOrder[1]]);
    });

    it("clamps out-of-range page and limit values", async () => {
        const cases = [
            ["?limit=1000", { page: 1, limit: 100, length: 8 }],
            ["?limit=0", { page: 1, limit: 20, length: 8 }],
            ["?limit=-5", { page: 1, limit: 1, length: 1 }],
            ["?limit=abc", { page: 1, limit: 20, length: 8 }],
            ["?page=0", { page: 1, limit: 20, length: 8 }],
            ["?page=-2", { page: 1, limit: 20, length: 8 }],
            ["?page=abc", { page: 1, limit: 20, length: 8 }],
            ["?page=99", { page: 99, limit: 20, length: 0 }],
            ["?page=1&page=2", { page: 1, limit: 20, length: 8 }],
        ];
        for (const [query, { page, limit, length }] of cases) {
            const res = await listKyc(query);
            assert.equal(res.status, 200, query);
            assert.equal(res.body.page, page, query);
            assert.equal(res.body.limit, limit, query);
            assert.equal(res.body.kyc.length, length, query);
            assert.equal(res.body.total, 8, query);
        }
    });

    it("answers a huge page number without a server error", async () => {
        const res = await listKyc("?page=99999999999999999999");
        assert.notEqual(res.status, 500, JSON.stringify(res.body));
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.deepEqual(res.body.kyc, []);
        assert.equal(res.body.total, 8);
    });
});

/* ---------- GET /api/admin/kyc/:id/document and /selfie ---------- */

describe("GET /api/admin/kyc/:id/document and /selfie", () => {
    it("serves the current images byte for byte, with their type and protective headers", async () => {
        for (const [kind, buf] of [["document", alice.kyc.document], ["selfie", alice.kyc.selfie]]) {
            const res = await fetchRaw(`/api/admin/kyc/${alice.id}/${kind}`, admin.token);
            assert.equal(res.status, 200, kind);
            assert.ok(res.buffer.equals(buf), `${kind} bytes differ from the upload`);
            const h = res.headers;
            assert.equal(h.get("content-type"), mimeOf(buf), kind);
            assert.equal(h.get("content-length"), String(buf.length));
            assert.equal(h.get("cache-control"), "private, no-store");
            assert.equal(h.get("x-content-type-options"), "nosniff");
            assert.equal(h.get("content-disposition"), `inline; filename="kyc-${kind}"`);
            assert.equal(h.get("content-security-policy"), "default-src 'none'; sandbox");
            assert.equal(h.get("x-frame-options"), "SAMEORIGIN");
            assert.equal(h.get("referrer-policy"), "no-referrer");
            assert.equal(h.get("x-powered-by"), null);
        }
        // Resubmissions replaced the first upload.
        const current = await fetchRaw(`/api/admin/kyc/${alice.id}/document`, admin.token);
        assert.ok(!current.buffer.equals(alice.firstDocument));
    });

    it("serves the paths the admin list advertises, under the /api base path", async () => {
        const res = await listKyc(`?q=${encodeURIComponent(bob.email)}`);
        const [item] = res.body.kyc;
        const document = await fetchRaw(`/api/${item.documentPath.replace(/^\//, "")}`, admin.token);
        assert.equal(document.status, 200);
        assert.ok(document.buffer.equals(bob.kyc.document));
        assert.equal(document.headers.get("content-type"), "image/jpeg");
        const selfie = await fetchRaw(`/api/${item.selfiePath.replace(/^\//, "")}`, admin.token);
        assert.equal(selfie.status, 200);
        assert.ok(selfie.buffer.equals(bob.kyc.selfie));
        assert.equal(selfie.headers.get("content-type"), "image/png");
    });

    it("returns a 2 MiB document intact", async () => {
        const res = await fetchRaw(`/api/admin/kyc/${gina.id}/document`, admin.token);
        assert.equal(res.status, 200);
        assert.equal(res.buffer.length, 2 * MiB);
        assert.ok(res.buffer.equals(gina.kyc.document));
        assert.equal(res.headers.get("content-type"), "image/png");
    });

    it("answers 404 as JSON for users without KYC and for unknown ids", async () => {
        const unknown = new mongoose.Types.ObjectId().toString();
        for (const id of [carol.id, admin.id, unknown]) {
            for (const kind of ["document", "selfie"]) {
                const res = await api(`/api/admin/kyc/${id}/${kind}`, { token: admin.token });
                assert.equal(res.status, 404, `${id} ${kind}`);
                assert.match(res.headers.get("content-type"), /^application\/json/);
                assert.deepEqual(res.body, { message: `KYC ${kind} not found` });
            }
        }
    });

    it("answers 400 to malformed ids", async () => {
        for (const id of ["123", "z".repeat(24), encodeURIComponent('{"$gt":""}'), `${alice.id}00`]) {
            const res = await api(`/api/admin/kyc/${id}/document`, { token: admin.token });
            assert.equal(res.status, 400, id);
            assert.deepEqual(res.body, { message: "Invalid id" });
        }
    });

    it("refuses anonymous callers, renters and owners, even for their own images", async () => {
        const cases = [
            [undefined, alice, 401],
            ["junk", alice, 401],
            [alice.token, alice, 403],
            [alice.token, bob, 403],
            [bob.token, bob, 403],
            [bob.token, alice, 403],
            [hank.token, gina, 403],
        ];
        for (const [token, target, status] of cases) {
            for (const kind of ["document", "selfie"]) {
                const res = await fetchRaw(`/api/admin/kyc/${target.id}/${kind}`, token);
                assert.equal(res.status, status, `${target.email} ${kind}`);
                assert.match(res.headers.get("content-type"), /^application\/json/);
                assert.ok(!res.buffer.equals(target.kyc[kind]));
                assert.ok(res.buffer.length < 100, "error bodies must not carry image bytes");
            }
        }
    });

    it("has no route for any other image field", async () => {
        for (const kind of ["passport", "documentUrl", "selfieUrl", "idNumber"]) {
            const res = await api(`/api/admin/kyc/${alice.id}/${kind}`, { token: admin.token });
            assert.equal(res.status, 404, kind);
            assert.deepEqual(res.body, { message: "Not found" });
        }
    });
});

/* ---------- equipment review ---------- */

describe("admin equipment review", () => {
    const LEGACY_IMAGE = "https://example.com/legacy/drill.jpg";
    let e1;
    let e2;
    let e3;
    let legacyId;
    let e1Images;

    const createListing = async (json) => {
        const res = await api("/api/equipment", { method: "POST", token: bob.token, json });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        return String(res.body.equipment._id);
    };
    const queue = (query = "", token = admin.token) => api(`/api/admin/equipment${query}`, { token });
    const decideListing = (id, action, json, token = admin.token) =>
        api(`/api/admin/equipment/${id}/${action}`, { method: "PUT", token, json });
    const readListing = (id) => Equipment.findById(id).lean();

    before(async () => {
        // A listing from before `price` was required and `images` existed; the API can no longer create one.
        const old = new Date("2023-01-01T00:00:00Z");
        const { insertedId } = await Equipment.collection.insertOne({
            title: "Legacy Drill Press",
            owner: new mongoose.Types.ObjectId(bob.id),
            status: "pending",
            image: LEGACY_IMAGE,
            availability: true,
            createdAt: old,
            updatedAt: old,
        });
        legacyId = String(insertedId);

        e1Images = [toDataUrl(nextPng()), toDataUrl(nextJpeg())];
        e1 = await createListing({ title: "Concrete Mixer 350L", price: 15000, location: "Lagos", images: e1Images });
        e2 = await createListing({ title: "Scaffold Tower", price: 8000 });
        e3 = await createListing({
            title: "Generator 5kVA",
            price: 20000,
            status: "approved",
            reviewedBy: admin.id,
            rejectionReason: "pre-approved",
            owner: hank.id,
        });
    });

    it("a new listing starts pending whatever the owner sends", async () => {
        const stored = await readListing(e3);
        assert.equal(stored.status, "pending");
        assert.equal(stored.reviewedBy, undefined);
        assert.equal(stored.reviewedAt, undefined);
        assert.equal(stored.rejectionReason, "");
        assert.equal(String(stored.owner), bob.id);
    });

    it("refuses anonymous callers, renters and owners on every review route", async () => {
        const routes = [
            ["GET", "/api/admin/equipment"],
            ["PUT", `/api/admin/equipment/${e2}/approve`],
            ["PUT", `/api/admin/equipment/${e2}/reject`, { reason: "Not allowed here" }],
            ["PUT", `/api/admin/equipment/${e2}/review`, { status: "approved" }],
        ];
        for (const [method, path, json] of routes) {
            assert.equal((await api(path, { method, json })).status, 401, `${method} ${path} anonymous`);
            assert.equal((await api(path, { method, json, token: alice.token })).status, 403, `${method} ${path} renter`);
            // Bob owns e2, which does not make him its reviewer.
            assert.equal((await api(path, { method, json, token: bob.token })).status, 403, `${method} ${path} owner`);
        }
        const stored = await readListing(e2);
        assert.equal(stored.status, "pending");
        assert.equal(stored.reviewedBy, undefined);
    });

    it("lists pending listings newest first, with one thumbnail and the owner's public details", async () => {
        const res = await queue();
        assert.equal(res.status, 200);
        assert.deepEqual(Object.keys(res.body).sort(), ["equipment", "limit", "page", "total"]);
        assert.equal(res.body.total, 4);
        assert.deepEqual(res.body.equipment.map((item) => item._id), [e3, e2, e1, legacyId]);
        assert.ok(res.body.equipment.every((item) => item.status === "pending"));

        const mixer = res.body.equipment.find((item) => item._id === e1);
        assert.deepEqual(mixer.images, [e1Images[0]]);
        assert.equal(mixer.imageCount, 2);
        assert.equal(mixer.image, e1Images[0]);
        assert.equal(mixer.name, "Concrete Mixer 350L");
        assert.equal(mixer.pricePerDay, 15000);
        assert.deepEqual(mixer.owner, { _id: bob.id, name: bob.name, email: bob.email, businessName: bob.businessName });

        const legacy = res.body.equipment.find((item) => item._id === legacyId);
        assert.deepEqual(legacy.images, []);
        assert.equal(legacy.imageCount, 0);
        assert.equal(legacy.image, LEGACY_IMAGE);

        const text = JSON.stringify(res.body);
        for (const key of ["password", "tokenVersion", "kycDetails", "kycStatus", "phone"]) {
            assert.ok(!text.includes(`"${key}"`), `queue must not expose the owner's ${key}`);
        }
    });

    it("filters by status and validates it", async () => {
        const totals = { approved: 0, rejected: 0, pending: 4, PENDING: 4, all: 4, "": 4 };
        for (const [status, total] of Object.entries(totals)) {
            const res = await queue(`?status=${status}`);
            assert.equal(res.status, 200, status);
            assert.equal(res.body.total, total, status);
        }
        const bogus = await queue("?status=live");
        assert.equal(bogus.status, 400);
        assert.deepEqual(bogus.body, { message: "status must be one of: pending, approved, rejected, all" });
        assert.equal((await queue("?status=pending&status=approved")).status, 400);
        assert.equal((await queue("?status[$ne]=pending")).body.total, 4);
    });

    it("paginates the queue with consistent totals", async () => {
        const seen = [];
        for (const [page, size] of [[1, 3], [2, 1], [3, 0]]) {
            const res = await queue(`?limit=3&page=${page}`);
            assert.equal(res.body.total, 4);
            assert.equal(res.body.page, page);
            assert.equal(res.body.limit, 3);
            assert.equal(res.body.equipment.length, size);
            seen.push(...res.body.equipment.map((item) => item._id));
        }
        assert.deepEqual(seen, [e3, e2, e1, legacyId]);
    });

    it("pending listings are not public", async () => {
        const list = await api("/api/equipment");
        assert.equal(list.status, 200);
        assert.equal(list.body.total, 0);
        assert.equal((await api(`/api/equipment/${e1}`)).status, 404);
        assert.equal((await api(`/api/equipment/${e1}`, { token: alice.token })).status, 404);
    });

    it("approves a listing, records who reviewed it, and makes it public", async () => {
        const startedAt = Date.now();
        const res = await decideListing(e1, "approve");
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.message, "Equipment approved and live!");
        const { equipment } = res.body;
        assert.equal(equipment._id, e1);
        assert.equal(equipment.status, "approved");
        assert.equal(equipment.rejectionReason, "");
        assert.equal(equipment.reviewedBy, admin.id);
        assert.ok(new Date(equipment.reviewedAt).getTime() >= startedAt - 1000);
        assert.equal(equipment.images.length, 2);

        const stored = await readListing(e1);
        assert.equal(stored.status, "approved");
        assert.equal(String(stored.reviewedBy), admin.id);
        assert.ok(stored.reviewedAt instanceof Date);

        assert.equal((await queue()).body.total, 3);
        const publicList = await api("/api/equipment");
        assert.deepEqual(publicList.body.equipment.map((item) => item._id), [e1]);
        const detail = await api(`/api/equipment/${e1}`);
        assert.equal(detail.status, 200);
        assert.equal(detail.body.equipment.status, "approved");
    });

    it("requires a 3 to 500 character reason to reject, changing nothing otherwise", async () => {
        const cases = [
            [undefined, /^reason is required$/],
            [{}, /^reason is required$/],
            [{ reason: "" }, /^reason is required$/],
            [{ reason: "  no  " }, /^reason must be at least 3 characters$/],
            [{ reason: "r".repeat(501) }, /^reason must be at most 500 characters$/],
            [{ reason: { $ne: "" } }, /^reason must be text$/],
            [{ reason: ["Blurry photos"] }, /^reason must be text$/],
            [{ rejectionReason: "Photos are blurry" }, /^reason is required$/],
        ];
        for (const [json, message] of cases) {
            const res = await decideListing(e2, "reject", json);
            assert.equal(res.status, 400, JSON.stringify(json));
            assert.match(res.body.message, message);
        }
        const stored = await readListing(e2);
        assert.equal(stored.status, "pending");
        assert.equal(stored.reviewedBy, undefined);
        assert.equal(stored.rejectionReason, "");
    });

    it("rejects with a trimmed reason: the listing stays private but its owner sees why", async () => {
        const res = await decideListing(e2, "reject", { reason: "  Photos do not match the title  " });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.message, "Equipment rejected");
        assert.equal(res.body.equipment.status, "rejected");
        assert.equal(res.body.equipment.rejectionReason, "Photos do not match the title");
        assert.equal(res.body.equipment.reviewedBy, admin.id);

        const stored = await readListing(e2);
        assert.equal(stored.status, "rejected");
        assert.equal(stored.rejectionReason, "Photos do not match the title");
        assert.equal(String(stored.reviewedBy), admin.id);

        assert.equal((await api(`/api/equipment/${e2}`)).status, 404);
        assert.equal((await api(`/api/equipment/${e2}`, { token: alice.token })).status, 404);
        const own = await api(`/api/equipment/${e2}`, { token: bob.token });
        assert.equal(own.status, 200);
        assert.equal(own.body.equipment.status, "rejected");
        assert.equal(own.body.equipment.rejectionReason, "Photos do not match the title");
    });

    it("the review endpoint approves or rejects according to status", async () => {
        const approve = await decideListing(e3, "review", { status: "approved" });
        assert.equal(approve.status, 200, JSON.stringify(approve.body));
        assert.equal(approve.body.equipment.status, "approved");
        assert.equal((await readListing(e3)).status, "approved");

        const noReason = await decideListing(e3, "review", { status: "rejected" });
        assert.equal(noReason.status, 400);
        assert.deepEqual(noReason.body, { message: "reason is required" });
        assert.equal((await readListing(e3)).status, "approved");

        const reject = await decideListing(e3, "review", { status: "rejected", reason: "Duplicate of another listing" });
        assert.equal(reject.status, 200, JSON.stringify(reject.body));
        assert.equal(reject.body.message, "Equipment rejected");
        const stored = await readListing(e3);
        assert.equal(stored.status, "rejected");
        assert.equal(stored.rejectionReason, "Duplicate of another listing");

        for (const json of [undefined, {}, { status: "pending" }, { status: { $ne: null } }, { status: ["approved"] }]) {
            const res = await decideListing(e3, "review", json);
            assert.equal(res.status, 400, JSON.stringify(json));
            assert.deepEqual(res.body, { message: "status must be one of: approved, rejected" });
        }
        assert.equal((await readListing(e3)).status, "rejected");
    });

    it("answers 404 for unknown listings without creating one, and 400 for malformed ids", async () => {
        const unknown = new mongoose.Types.ObjectId().toString();
        const countBefore = await Equipment.countDocuments();
        const attempts = [
            ["approve", undefined],
            ["reject", { reason: "Not a real listing" }],
            ["review", { status: "approved" }],
            ["review", { status: "rejected", reason: "Not a real listing" }],
        ];
        for (const [action, json] of attempts) {
            const res = await decideListing(unknown, action, json);
            assert.equal(res.status, 404, `${action} ${JSON.stringify(json)}`);
            assert.deepEqual(res.body, { message: "Equipment not found" });
        }
        assert.equal(await Equipment.countDocuments(), countBefore);
        assert.equal(await Equipment.exists({ _id: unknown }), null);

        for (const id of ["not-an-id", encodeURIComponent('{"$ne":null}'), `${e1}0`]) {
            for (const [action, json] of attempts) {
                const res = await decideListing(id, action, json);
                assert.equal(res.status, 400, `${action} ${id}`);
                assert.deepEqual(res.body, { message: "Invalid id" });
            }
        }
    });

    it("can approve a legacy listing that lacks fields a new listing requires", async () => {
        const res = await decideListing(legacyId, "approve");
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.equipment.status, "approved");
        assert.equal(res.body.equipment.image, LEGACY_IMAGE);
        const raw = await Equipment.collection.findOne({ _id: new mongoose.Types.ObjectId(legacyId) });
        assert.equal(raw.status, "approved");
        assert.equal(Object.hasOwn(raw, "price"), false);
        assert.equal(String(raw.reviewedBy), admin.id);
    });

    it("the status filters reflect the decisions, and an owner's edit sends a listing back to the queue", async () => {
        const ids = async (status) => {
            const res = await queue(`?status=${status}`);
            assert.equal(res.body.total, res.body.equipment.length);
            return sortedIds(res.body.equipment);
        };
        assert.deepEqual(await ids("approved"), [e1, legacyId].sort());
        assert.deepEqual(await ids("rejected"), [e2, e3].sort());
        assert.deepEqual(await ids("pending"), []);

        const edit = await api(`/api/equipment/${e1}`, { method: "PATCH", token: bob.token, json: { price: 16000 } });
        assert.equal(edit.status, 200, JSON.stringify(edit.body));
        assert.equal(edit.body.equipment.status, "pending");
        assert.deepEqual(await ids("pending"), [e1]);
        assert.deepEqual(await ids("approved"), [legacyId]);
        assert.equal((await api(`/api/equipment/${e1}`)).status, 404);
    });
});

/* ---------- stale and forged tokens ---------- */

describe("stale and forged tokens on the KYC and admin routes", () => {
    const sign = (payload, options = {}) =>
        jwt.sign(payload, options.secret ?? process.env.JWT_SECRET, { algorithm: options.algorithm ?? "HS256", ...(options.expiresIn !== null && { expiresIn: options.expiresIn ?? "5m" }) });
    const unsignedToken = (payload) => {
        const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
        return `${part({ alg: "none", typ: "JWT" })}.${part(payload)}.`;
    };

    it("logout revokes every earlier token", async () => {
        const second = await api("/api/auth/login", { method: "POST", json: { email: alice.email, password: PASSWORD } });
        assert.equal(second.status, 200);
        const out = await api("/api/auth/logout", { method: "POST", token: second.body.token });
        assert.equal(out.status, 200);

        for (const token of [alice.token, second.body.token]) {
            const me = await api("/api/kyc/me", { token });
            assert.equal(me.status, 401);
            assert.deepEqual(me.body, { message: "Not authorized, invalid token" });
            assert.equal((await submitKyc({ ...alice, token })).status, 401);
        }
        await login(alice);
        const me = await api("/api/kyc/me", { token: alice.token });
        assert.equal(me.status, 200);
        assert.equal(me.body.kyc.status, "verified");
    });

    it("a validly signed token claiming the admin role does not make a renter an admin", async () => {
        const { tokenVersion } = await readUser(alice.id);
        const forged = sign({ id: alice.id, role: "admin", tv: tokenVersion });
        assert.equal((await api("/api/kyc/me", { token: forged })).status, 200, "the token itself is valid");

        assert.equal((await listKyc("", forged)).status, 403);
        assert.equal((await fetchRaw(`/api/admin/kyc/${ivy.id}/document`, forged)).status, 403);
        assert.equal((await decide(ivy, { status: "verified" }, forged)).status, 403);
        assert.equal((await api("/api/admin/equipment", { token: forged })).status, 403);
        const stored = await readUser(ivy.id);
        assert.equal(stored.kycStatus, "rejected");
        assert.equal(stored.isVerified, false);
    });

    it("refuses forged, expired, mis-signed or orphaned tokens with 401", async () => {
        const { tokenVersion } = await readUser(admin.id);
        const claims = { id: admin.id, role: "admin", tv: tokenVersion };
        assert.equal((await listKyc("", sign(claims))).status, 200, "control: a correct admin token works");

        const tokens = {
            "wrong secret": sign(claims, { secret: "a-completely-different-secret-0123456789abcdef" }),
            "alg none": unsignedToken(claims),
            "HS512 instead of HS256": sign(claims, { algorithm: "HS512" }),
            expired: sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 60 }, { expiresIn: null }),
            "stale token version": sign({ ...claims, tv: tokenVersion + 1 }),
            "missing token version": sign({ id: admin.id, role: "admin" }),
            "id is not an ObjectId": sign({ ...claims, id: "admin" }),
            "id is an operator object": sign({ ...claims, id: { $ne: null } }),
            "unknown user": sign({ ...claims, id: new mongoose.Types.ObjectId().toString() }),
        };
        for (const [label, token] of Object.entries(tokens)) {
            const res = await listKyc("", token);
            assert.equal(res.status, 401, label);
            assert.deepEqual(res.body, { message: "Not authorized, invalid token" }, label);
            const image = await fetchRaw(`/api/admin/kyc/${alice.id}/document`, token);
            assert.equal(image.status, 401, `${label} (image)`);
        }

        for (const authorization of [`Token ${admin.token}`, `Bearer  ${admin.token}`, `Bearer ${admin.token} extra`, "Bearer"]) {
            const res = await api("/api/admin/kyc", { headers: { authorization } });
            assert.equal(res.status, 401, authorization.slice(0, 20));
        }
    });

    it("a role change revokes the old token in both directions", async () => {
        const promote = await api("/api/auth/users/role", { method: "PUT", token: admin.token, json: { userId: carol.id, role: "admin" } });
        assert.equal(promote.status, 200, JSON.stringify(promote.body));
        assert.equal((await api("/api/kyc/me", { token: carol.token })).status, 401, "the pre-promotion token is revoked");

        await login(carol);
        const adminToken = carol.token;
        assert.equal((await listKyc("", adminToken)).status, 200);
        assert.equal((await fetchRaw(`/api/admin/kyc/${alice.id}/selfie`, adminToken)).status, 200);

        const demote = await api("/api/auth/users/role", { method: "PUT", token: admin.token, json: { userId: carol.id, role: "renter" } });
        assert.equal(demote.status, 200);
        assert.equal((await listKyc("", adminToken)).status, 401, "the admin token is revoked after demotion");
        assert.equal((await fetchRaw(`/api/admin/kyc/${alice.id}/selfie`, adminToken)).status, 401);
        assert.equal((await decide(gina, { status: "verified" }, adminToken)).status, 401);

        await login(carol);
        assert.equal((await listKyc("", carol.token)).status, 403);
        assert.equal((await readUser(gina.id)).kycStatus, "under_review");
    });

    it("a deleted user's token stops working", async () => {
        await User.deleteOne({ _id: carol.id });
        assert.equal((await api("/api/kyc/me", { token: carol.token })).status, 401);
        assert.equal((await api("/api/auth/me", { token: carol.token })).status, 401);
        assert.equal((await submitKyc(carol)).status, 401);
    });
});
