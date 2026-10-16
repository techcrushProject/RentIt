import env from "../config/env.js";
import { findCategory } from "../config/categories.js";
import Equipment, { MAX_IMAGES, MAX_SPECS } from "../Models/equipment.js";
import { HttpError, badRequest, conflict, notFound } from "../utils/httpError.js";
import { imageRef, objectId, oneOf, pagination, positiveNumber, str } from "../utils/validate.js";

const STATUSES = ["pending", "approved", "rejected"];
// Six inline images must fit in the 8mb JSON body limit once base64-encoded (4/3 overhead).
const MAX_IMAGE_BYTES = 900 * 1024;
// Inline (data URL) photos live in MongoDB, so their total per listing is capped. Cloudinary URLs are tiny.
const MAX_INLINE_BYTES_PER_LISTING = 3 * 1024 * 1024;

// Anyone can register as an owner, so per-owner caps stop one account from flooding
// the review queue or the database.
const MAX_PENDING_PER_OWNER = 10;
const MAX_LISTINGS_PER_OWNER = 100;

// Listings are public, so the owner is shown by name only: never email or phone.
const OWNER_SUMMARY = "name businessName";

// Editing any of these on a reviewed listing sends it back to review.
const CONTENT_FIELDS = ["title", "description", "price", "rentalDeposit", "category", "condition", "location", "specs", "images"];

const bodyOf = (req) => (req.body !== null && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Stored and filtered by catalogue name, so "power-tools" and "Power Tools" mean the same thing. */
const readCategory = (value) => {
    const text = str(value, { field: "category", max: 60 });
    return findCategory(text)?.name ?? text;
};

function readSpecs(value) {
    if (!Array.isArray(value)) throw badRequest("specs must be a list");
    if (value.length > MAX_SPECS) throw badRequest(`specs can have at most ${MAX_SPECS} items`);
    return value.map((item) => str(item, { field: "specs item", max: 100 })).filter(Boolean);
}

function readAvailability(value) {
    if (typeof value !== "boolean") throw badRequest("availability must be true or false");
    return value;
}

// Cloudinary images must sit in the uploader's own folder (see Controllers/uploadController.js).
const readImage = (value, field, ownerId) =>
    imageRef(value, {
        field,
        cloudName: env.cloudinary.cloudName,
        maxBytes: MAX_IMAGE_BYTES,
        folder: `rentit/equipment/${ownerId}`,
    });

/**
 * `images` replaces the list; the legacy single `image` is appended to it (or
 * to `current` when `images` is absent). Resolves to undefined when the
 * request does not touch images at all.
 */
function readImages(body, current, ownerId) {
    const { images, image } = body;
    const hasLegacyImage = image !== undefined && image !== null && image !== "";
    if (images === undefined && !hasLegacyImage) return undefined;

    if (images !== undefined && !Array.isArray(images)) throw badRequest("images must be a list");
    // Checked before decoding so an oversized list is refused cheaply.
    if (images && images.length > MAX_IMAGES) throw badRequest(`A listing can have at most ${MAX_IMAGES} images`);

    const list = images === undefined ? [...current] : images.map((item, index) => readImage(item, `image ${index + 1}`, ownerId));
    if (hasLegacyImage) {
        const extra = readImage(image, "image", ownerId);
        if (!list.includes(extra)) list.push(extra);
    }
    if (list.length > MAX_IMAGES) throw badRequest(`A listing can have at most ${MAX_IMAGES} images`);

    const inlineBytes = list
        .filter((item) => item.startsWith("data:"))
        .reduce((sum, item) => sum + Math.floor(((item.length - item.indexOf(",") - 1) * 3) / 4), 0);
    if (inlineBytes > MAX_INLINE_BYTES_PER_LISTING) {
        throw badRequest("Photos are too large in total (max 3MB). Use fewer or smaller photos.");
    }
    return list;
}

// `alias` is the name the legacy service used for the same field.
const FIELDS = {
    title: { alias: "name", required: true, read: (v) => str(v, { field: "title", min: 3, max: 120, required: true }) },
    description: { read: (v) => str(v, { field: "description", max: 2000 }) },
    price: { alias: "pricePerDay", required: true, read: (v) => positiveNumber(v, { field: "price" }) },
    rentalDeposit: { read: (v) => positiveNumber(v, { field: "rentalDeposit", allowZero: true }) },
    category: { read: readCategory },
    condition: { read: (v) => str(v, { field: "condition", max: 40 }) },
    location: { read: (v) => str(v, { field: "location", max: 120 }) },
    specs: { read: readSpecs },
    availability: { read: readAvailability },
};

/**
 * Whitelist and validate the writable fields. Anything else in the body
 * (status, owner, reviewedBy, ...) is never read, so it cannot be mass-assigned.
 * `partial` (updates) only returns the fields the request actually sent.
 */
function readFields(body, { partial, currentImages = [], ownerId }) {
    const fields = {};
    for (const [name, { alias, required, read }] of Object.entries(FIELDS)) {
        const value = body[name] !== undefined || !alias ? body[name] : body[alias];
        if (value === undefined && (partial || !required)) continue;
        fields[name] = read(value);
    }
    const images = readImages(body, currentImages, ownerId);
    if (images !== undefined) fields.images = images;
    return fields;
}

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- reading ---------- */

/** Public listings by default; only an admin may ask for another status (or "all"). */
function statusFilter(query, user) {
    const requested = user?.role === "admin" ? str(query.status, { field: "status", max: 20 }).toLowerCase() : "";
    if (!requested) return { status: "approved", availability: { $ne: false } };
    oneOf(requested, [...STATUSES, "all"], "status");
    return requested === "all" ? {} : { status: requested };
}

function optionalPrice(value, field) {
    return value === undefined || value === "" ? undefined : positiveNumber(value, { field, allowZero: true });
}

// List queries never load the full image list: the stored thumbnail and count are enough.
export const LIST_PROJECTION = "-images";

/**
 * List views only need a thumbnail. Inline (data URL) images can be ~1MB each,
 * so a page returns `images: [thumbnail]` plus `imageCount` (sent once, not
 * duplicated in `image`); the detail endpoint returns every image.
 */
export const toListItem = (doc) => {
    const json = typeof doc?.toJSON === "function" ? doc.toJSON() : { ...doc };
    const loaded = Array.isArray(json.images) ? json.images : [];
    // Listings saved before thumbnails existed fall back to their raw `image` or first image.
    const thumb = (typeof doc?.thumbnail === "string" && doc.thumbnail) || loaded[0] || json.image || "";
    const stored = Number.isInteger(doc?.imageCount) ? doc.imageCount : 0;
    const imageCount = Math.max(stored, loaded.length, thumb ? 1 : 0);
    const { image, thumbnail, ...rest } = json;
    return { ...rest, images: thumb ? [thumb] : [], imageCount };
};

async function findPage(filter, query) {
    const { page, limit, skip } = pagination(query);
    const [docs, total] = await Promise.all([
        Equipment.find(filter)
            .select(LIST_PROJECTION)
            .sort({ createdAt: -1, _id: -1 })
            .skip(skip)
            .limit(limit)
            .populate("owner", OWNER_SUMMARY),
        Equipment.countDocuments(filter),
    ]);
    return { equipment: docs.map(toListItem), page, limit, total };
}

export const listEquipment = async (req, res) => {
    const query = req.query;
    const filter = statusFilter(query, req.user);

    // Only validated strings and numbers reach the filter, never the query objects themselves.
    const q = str(query.q, { field: "q", max: 60 });
    if (q) {
        const pattern = new RegExp(escapeRegex(q), "i");
        filter.$or = [{ title: pattern }, { description: pattern }, { category: pattern }];
    }

    const category = readCategory(query.category);
    if (category) filter.category = category;

    const location = str(query.location, { field: "location", max: 120 });
    if (location) filter.location = new RegExp(escapeRegex(location), "i");

    const minPrice = optionalPrice(query.minPrice, "minPrice");
    const maxPrice = optionalPrice(query.maxPrice, "maxPrice");
    if (minPrice !== undefined || maxPrice !== undefined) {
        filter.price = {};
        if (minPrice !== undefined) filter.price.$gte = minPrice;
        if (maxPrice !== undefined) filter.price.$lte = maxPrice;
    }

    res.status(200).json(await findPage(filter, query));
};

export const getMyEquipment = async (req, res) => {
    res.status(200).json(await findPage({ owner: req.user.id }, req.query));
};

export const getEquipment = async (req, res) => {
    const id = objectId(req.params.id);
    const equipment = await Equipment.findById(id).populate("owner", OWNER_SUMMARY);

    // The owner is populated, so its id is on `_id`; the fallback covers an unpopulated reference.
    const ownerId = equipment?.owner?._id ?? equipment?.owner;
    const visible =
        equipment &&
        (equipment.status === "approved" ||
            (req.user && (req.user.role === "admin" || String(ownerId) === req.user.id)));
    // Same answer for "missing" and "not yours" so ids cannot be probed.
    if (!visible) throw notFound("Equipment not found");

    res.status(200).json({ equipment });
};

/* ---------- writing ---------- */

export const createEquipment = async (req, res) => {
    const fields = readFields(bodyOf(req), { partial: false, ownerId: req.user.id });

    const [pending, total] = await Promise.all([
        Equipment.countDocuments({ owner: req.user.id, status: "pending" }),
        Equipment.countDocuments({ owner: req.user.id }),
    ]);
    if (pending >= MAX_PENDING_PER_OWNER) {
        throw new HttpError(429, `You already have ${MAX_PENDING_PER_OWNER} listings waiting for review. Please wait for them to be reviewed.`);
    }
    if (total >= MAX_LISTINGS_PER_OWNER) throw conflict(`You have reached the limit of ${MAX_LISTINGS_PER_OWNER} listings.`);

    // Whatever the client says, a new listing starts pending and belongs to the caller.
    const equipment = await Equipment.create({ ...fields, owner: req.user.id, status: "pending" });
    res.status(201).json({ message: "Equipment listing created", equipment });
};

export const updateEquipment = async (req, res) => {
    const id = objectId(req.params.id);
    // Scoped to the caller even for admins: an admin reviews listings, it does not edit them.
    const equipment = await Equipment.findOne({ _id: id, owner: req.user.id });
    if (!equipment) throw notFound("Equipment not found");

    const changes = readFields(bodyOf(req), { partial: true, currentImages: [...equipment.images], ownerId: req.user.id });
    const contentChanged = CONTENT_FIELDS.some(
        (field) => Object.hasOwn(changes, field) && !sameValue(equipment[field], changes[field])
    );

    equipment.set(changes);
    // Always written when content changes (even if this copy already says pending): an admin
    // may approve between our read and this save, and the edit must not ride on that approval.
    if (contentChanged) {
        equipment.status = "pending";
        equipment.rejectionReason = "";
        equipment.markModified("status");
        equipment.markModified("rejectionReason");
    }
    await equipment.save();

    res.status(200).json({ message: "Equipment updated", equipment });
};

export const deleteEquipment = async (req, res) => {
    const id = objectId(req.params.id);
    const filter = req.user.role === "admin" ? { _id: id } : { _id: id, owner: req.user.id };
    const { deletedCount } = await Equipment.deleteOne(filter);
    if (!deletedCount) throw notFound("Equipment not found");
    res.status(200).json({ message: "Equipment deleted" });
};
