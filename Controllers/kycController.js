import Kyc from "../Models/kyc.js";


// Submit KYC
const submitKyc = async (req, res) => {
    try {
        const { documentType, documentNumber, documentUrl } = req.body;

        if (!documentType || !documentNumber || !documentUrl) {
            return res.status(400).json({
                message: "Document type, document number and document URL are required",
            });
        }

        const existingKyc = await Kyc.findOne({
            user: req.user.id,
        });

        if (existingKyc) {
            return res.status(400).json({
                message: "KYC already submitted",
            });
        }

        const kyc = await Kyc.create({
            user: req.user.id,
            documentType,
            documentNumber,
            documentUrl,
        });

        return res.status(201).json({
            message: "KYC submitted successfully",
            kyc,
        });
    } catch (error) {
        return res.status(500).json({
            message: "Server error while submitting KYC",
            error: error.message,
        });
    }
};


// Get logged-in user's KYC
const getMyKyc = async (req, res) => {
    try {
        const kyc = await Kyc.findOne({
            user: req.user.id,
        }).populate("user", "name email role");

        if (!kyc) {
            return res.status(404).json({
                message: "KYC record not found",
            });
        }

        return res.status(200).json({
            kyc,
        });
    } catch (error) {
        return res.status(500).json({
            message: "Server error while fetching KYC",
            error: error.message,
        });
    }
};


// Admin - get all KYC submissions
const getAllKyc = async (req, res) => {
    try {
        const { status } = req.query;

        const filter = {};

        if (status) {
            filter.status = status;
        }

        const kycRecords = await Kyc.find(filter)
            .populate("user", "name email role")
            .populate("reviewedBy", "name email")
            .sort({ createdAt: -1 });

        return res.status(200).json({
            count: kycRecords.length,
            kyc: kycRecords,
        });
    } catch (error) {
        return res.status(500).json({
            message: "Server error while fetching KYC records",
            error: error.message,
        });
    }
};


// Admin - get one KYC
const getKycById = async (req, res) => {
    try {
        const kyc = await Kyc.findById(req.params.id)
            .populate("user", "name email role")
            .populate("reviewedBy", "name email");

        if (!kyc) {
            return res.status(404).json({
                message: "KYC record not found",
            });
        }

        return res.status(200).json({
            kyc,
        });
    } catch (error) {
        return res.status(500).json({
            message: "Server error while fetching KYC",
            error: error.message,
        });
    }
};


// Admin - verify KYC
const verifyKyc = async (req, res) => {
    try {
        const kyc = await Kyc.findById(req.params.id);

        if (!kyc) {
            return res.status(404).json({
                message: "KYC record not found",
            });
        }

        kyc.status = "verified";
        kyc.rejectionReason = null;
        kyc.reviewedBy = req.user.id;
        kyc.reviewedAt = new Date();

        await kyc.save();

        return res.status(200).json({
            message: "KYC verified successfully",
            kyc,
        });
    } catch (error) {
        return res.status(500).json({
            message: "Server error while verifying KYC",
            error: error.message,
        });
    }
};


// Admin - request resubmission
const requestKycResubmission = async (req, res) => {
    try {
        const { reason } = req.body;

        const kyc = await Kyc.findById(req.params.id);

        if (!kyc) {
            return res.status(404).json({
                message: "KYC record not found",
            });
        }

        kyc.status = "resubmission_required";
        kyc.rejectionReason = reason || "Please resubmit your KYC documents";
        kyc.reviewedBy = req.user.id;
        kyc.reviewedAt = new Date();

        await kyc.save();

        return res.status(200).json({
            message: "KYC resubmission requested",
            kyc,
        });
    } catch (error) {
        return res.status(500).json({
            message: "Server error while requesting KYC resubmission",
            error: error.message,
        });
    }
};


// Admin - reject KYC
const rejectKyc = async (req, res) => {
    try {
        const { reason } = req.body;

        if (!reason) {
            return res.status(400).json({
                message: "Rejection reason is required",
            });
        }

        const kyc = await Kyc.findById(req.params.id);

        if (!kyc) {
            return res.status(404).json({
                message: "KYC record not found",
            });
        }

        kyc.status = "rejected";
        kyc.rejectionReason = reason;
        kyc.reviewedBy = req.user.id;
        kyc.reviewedAt = new Date();

        await kyc.save();

        return res.status(200).json({
            message: "KYC rejected successfully",
            kyc,
        });
    } catch (error) {
        return res.status(500).json({
            message: "Server error while rejecting KYC",
            error: error.message,
        });
    }
};

// User - resubmit KYC
const resubmitKyc = async (req, res) => {
    try {
        const { documentType, documentNumber, documentUrl } = req.body;

        if (!documentType || !documentNumber || !documentUrl) {
            return res.status(400).json({
                message: "Document type, document number and document URL are required",
            });
        }

        const kyc = await Kyc.findOne({
            user: req.user.id,
        });

        if (!kyc) {
            return res.status(404).json({
                message: "KYC record not found",
            });
        }

        if (kyc.status !== "resubmission_required") {
            return res.status(400).json({
                message: "KYC resubmission is not currently required",
            });
        }

        kyc.documentType = documentType;
        kyc.documentNumber = documentNumber;
        kyc.documentUrl = documentUrl;
        kyc.status = "under_review";
        kyc.rejectionReason = null;
        kyc.reviewedBy = null;
        kyc.reviewedAt = null;

        await kyc.save();

        return res.status(200).json({
            message: "KYC resubmitted successfully",
            kyc,
        });

    } catch (error) {
        return res.status(500).json({
            message: "Server error while resubmitting KYC",
            error: error.message,
        });
    }
};

export {
    submitKyc,
    getMyKyc,
    resubmitKyc,
    getAllKyc,
    getKycById,
    verifyKyc,
    requestKycResubmission,
    rejectKyc,
};