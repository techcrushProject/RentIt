import User from "../Models/user.js";
import { conflict, notFound } from "../utils/httpError.js";
import { oneOf, parseImageDataUrl, str } from "../utils/validate.js";

// The legacy snake_case values are still sent by older frontend builds.
const DOCUMENT_TYPES = [
    "NIN",
    "Voter's card",
    "Driver's licence",
    "International passport",
    "national_id",
    "voters_card",
    "drivers_license",
    "passport",
];

// Anything else (under_review, verified) must not be overwritten by a new submission.
const RESUBMITTABLE = ["not_submitted", "rejected", "resubmit"];

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const bodyOf = (req) => (req.body !== null && typeof req.body === "object" ? req.body : {});

export const submitKyc = async (req, res) => {
    const body = bodyOf(req);
    const documentType = oneOf(body.documentType, DOCUMENT_TYPES, "documentType");
    const documentNumber = str(body.documentNumber, { field: "documentNumber", min: 4, max: 40, required: true });
    const address = str(body.address, { field: "address", max: 200 });
    // Identity images are only ever accepted as data URLs and kept in our database, never on a public CDN.
    const document = parseImageDataUrl(body.documentUrl, { field: "ID document", maxBytes: MAX_IMAGE_BYTES });
    const selfie = parseImageDataUrl(body.selfieUrl, { field: "Selfie", maxBytes: MAX_IMAGE_BYTES });

    const submittedAt = new Date();
    const changes = {
        kycDetails: {
            idType: documentType,
            idNumber: documentNumber,
            documentUrl: document.dataUrl,
            selfieUrl: selfie.dataUrl,
            documentMime: document.mime,
            selfieMime: selfie.mime,
            documentBytes: document.bytes,
            selfieBytes: selfie.bytes,
            address,
            submittedAt,
        },
        kycStatus: "under_review",
        kycRejectionReason: "",
        isVerified: false,
    };
    if (address) changes.address = address;

    // The status check lives in the filter so two concurrent submissions cannot both pass it.
    const result = await User.updateOne({ _id: req.user.id, kycStatus: { $in: RESUBMITTABLE } }, { $set: changes });
    if (result.modifiedCount === 0) throw conflict("KYC is already under review or verified");

    res.status(200).json({
        message: "KYC submitted successfully",
        kyc: { status: "under_review", submittedAt },
    });
};

/**
 * Submissions made before byte counts were recorded always stored both images
 * (the old endpoint required them), so "no counts but submitted" means present.
 */
export const kycImageFlags = (details = {}) => {
    const legacy = details.documentBytes === undefined && details.selfieBytes === undefined && Boolean(details.submittedAt);
    return {
        hasDocument: details.documentBytes > 0 || legacy,
        hasSelfie: details.selfieBytes > 0 || legacy,
    };
};

export const getMyKyc = async (req, res) => {
    // Leaf paths on purpose: selecting "kycDetails" would also pull in the image data URLs.
    const user = await User.findById(req.user.id)
        .select(
            "kycStatus kycRejectionReason kycDetails.idType kycDetails.address kycDetails.submittedAt " +
                "kycDetails.documentBytes kycDetails.selfieBytes"
        )
        .lean();
    if (!user || user.kycStatus === "not_submitted") throw notFound("KYC record not found");

    const details = user.kycDetails ?? {};
    res.status(200).json({
        kyc: {
            status: user.kycStatus,
            rejectionReason: user.kycRejectionReason || "",
            documentType: details.idType || "",
            address: details.address || "",
            submittedAt: details.submittedAt ?? null,
            ...kycImageFlags(details),
        },
    });
};
