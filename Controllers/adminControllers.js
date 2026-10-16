import Equipment from "../Models/equipment.js";
import User from "../Models/user.js";
import { badRequest, conflict, notFound } from "../utils/httpError.js";
import { objectId, oneOf, pagination, parseImageDataUrl, str } from "../utils/validate.js";
import { kycImageFlags } from "./kycController.js";
import { LIST_PROJECTION, toListItem } from "./equipmentController.js";

const SUBMITTED_STATUSES = ["under_review", "verified", "rejected", "resubmit"];
const KYC_DECISIONS = ["verified", "rejected", "resubmit"];
const EQUIPMENT_STATUSES = ["pending", "approved", "rejected"];

// Maps the :kind a route passes in to the (select:false) field that holds the image.
const KYC_IMAGE_FIELDS = { document: "documentUrl", selfie: "selfieUrl" };

const bodyOf = (req) => (req.body !== null && typeof req.body === "object" ? req.body : {});

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Enum from a query string or body: missing or empty means `fallback`; arrays and other non-strings are rejected. */
const choice = (value, allowed, fallback, field) =>
    oneOf(str(value, { field, max: 20 }).toLowerCase() || fallback, allowed, field);

/* ---------- KYC review ---------- */

export const getKycSubmissions = async (req, res) => {
    const status = choice(req.query.status, [...SUBMITTED_STATUSES, "all"], "all", "status");
    const q = str(req.query.q, { field: "q", max: 60 });
    const { page, limit, skip } = pagination(req.query);

    // `status` and the escaped `q` are the only request values that reach the filter.
    const filter = { kycStatus: status === "all" ? { $in: SUBMITTED_STATUSES } : status };
    if (q) {
        const contains = new RegExp(escapeRegex(q), "i");
        filter.$or = [{ name: contains }, { email: contains }];
    }

    // Only the ID number is opted in; the image data URLs stay excluded by the schema.
    const [users, total] = await Promise.all([
        User.find(filter)
            .select("+kycDetails.idNumber")
            .sort({ "kycDetails.submittedAt": -1, _id: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        User.countDocuments(filter),
    ]);

    const kyc = users.map((user) => {
        const id = String(user._id);
        const details = user.kycDetails ?? {};
        return {
            id,
            name: user.name,
            email: user.email,
            phone: user.phone || "",
            address: user.address || details.address || "",
            role: user.role,
            status: user.kycStatus,
            documentType: details.idType || "",
            documentNumber: details.idNumber || "",
            ...kycImageFlags(details),
            documentPath: `/admin/kyc/${id}/document`,
            selfiePath: `/admin/kyc/${id}/selfie`,
            submittedAt: details.submittedAt || user.createdAt,
            rejectionReason: user.kycRejectionReason || "",
        };
    });

    res.status(200).json({ kyc, page, limit, total });
};

/** Route factory: `getKycDocument("document")` or `getKycDocument("selfie")`. */
export const getKycDocument = (kind) => {
    const field = KYC_IMAGE_FIELDS[kind];
    if (!field) throw new Error(`Unknown KYC image kind: ${kind}`);

    return async (req, res) => {
        const id = objectId(req.params.id);
        const user = await User.findById(id).select(`+kycDetails.${field}`).lean();
        const stored = user?.kycDetails?.[field];
        if (!stored) throw notFound(`KYC ${kind} not found`);

        // The bytes and mime type are re-derived from the stored data, never from a stored claim.
        let image;
        try {
            image = parseImageDataUrl(stored, { field: kind });
        } catch {
            // Rows written before image signatures were checked can hold data we refuse to serve.
            throw notFound(`KYC ${kind} not found`);
        }

        res.set({
            "Content-Type": image.mime,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": `inline; filename="kyc-${kind}"`,
            "Content-Security-Policy": "default-src 'none'; sandbox",
        });
        res.status(200).send(image.buffer);
    };
};

export const verifyUserKyc = async (req, res) => {
    const id = objectId(req.params.id);
    const body = bodyOf(req);
    // No default: a missing status must never silently verify someone.
    const status = oneOf(str(body.status, { field: "status", max: 20, required: true }).toLowerCase(), KYC_DECISIONS, "status");
    const rejectionReason =
        status === "verified"
            ? ""
            : str(body.rejectionReason, { field: "rejectionReason", min: 3, max: 500, required: true });

    // Matching on kycStatus in the filter makes "no such user" and "never submitted" the same 404.
    const result = await User.updateOne(
        { _id: id, kycStatus: { $ne: "not_submitted" } },
        { $set: { kycStatus: status, isVerified: status === "verified", kycRejectionReason: rejectionReason } }
    );
    if (result.matchedCount === 0) throw notFound("KYC submission not found");

    res.status(200).json({
        message: `User KYC ${status}`,
        kyc: { id, status, rejectionReason },
    });
};

/* ---------- equipment review ---------- */

export const listEquipmentForReview = async (req, res) => {
    const status = choice(req.query.status, [...EQUIPMENT_STATUSES, "all"], "pending", "status");
    const { page, limit, skip } = pagination(req.query);
    const filter = status === "all" ? {} : { status };

    const [equipment, total] = await Promise.all([
        Equipment.find(filter)
            .select(LIST_PROJECTION)
            .sort({ createdAt: -1, _id: -1 })
            .skip(skip)
            .limit(limit)
            .populate("owner", "name email businessName"),
        Equipment.countDocuments(filter),
    ]);

    res.status(200).json({ equipment: equipment.map(toListItem), page, limit, total });
};

/**
 * updateOne rather than save(): saving would re-validate the whole listing, so a
 * legacy document missing a newer required field could never be reviewed.
 */
async function recordDecision(id, adminId, status, reason, expectedUpdatedAt) {
    const filter = { _id: id };
    // An approval only applies to the version the admin reviewed: if the owner edited the
    // listing after the admin loaded it, the timestamps differ and nothing is published.
    if (expectedUpdatedAt) filter.updatedAt = expectedUpdatedAt;
    const result = await Equipment.updateOne(filter, {
        $set: { status, rejectionReason: reason, reviewedAt: new Date(), reviewedBy: adminId },
    });
    if (result?.matchedCount === 0 && expectedUpdatedAt && (await Equipment.exists({ _id: id }))) {
        throw conflict("This listing changed after you opened it. Reload it and review it again.");
    }
    const equipment = await Equipment.findById(id);
    if (!equipment) throw notFound("Equipment not found");
    return equipment;
}

/** Optional `expectedUpdatedAt` (the listing's updatedAt as the admin saw it). */
function readExpectedVersion(body) {
    const value = body.expectedUpdatedAt;
    if (value === undefined || value === null || value === "") return undefined;
    const date = typeof value === "string" && value.length <= 40 ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) throw badRequest("expectedUpdatedAt must be a date");
    return date;
}

export const approveEquipment = async (req, res) => {
    const id = objectId(req.params.id);
    const equipment = await recordDecision(id, req.user.id, "approved", "", readExpectedVersion(bodyOf(req)));
    res.status(200).json({ message: "Equipment approved and live!", equipment });
};

export const rejectEquipment = async (req, res) => {
    const id = objectId(req.params.id);
    const reason = str(bodyOf(req).reason, { field: "reason", min: 3, max: 500, required: true });
    const equipment = await recordDecision(id, req.user.id, "rejected", reason);
    res.status(200).json({ message: "Equipment rejected", equipment });
};

export const reviewEquipment = async (req, res) => {
    const status = oneOf(bodyOf(req).status, ["approved", "rejected"], "status");
    return status === "approved" ? approveEquipment(req, res) : rejectEquipment(req, res);
};
