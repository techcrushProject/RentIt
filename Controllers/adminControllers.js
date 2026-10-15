import User from "../Models/user.js";
import Equipment from "../Models/equipment.js";

export const submitKyc = async (req, res) => {
    try {
        const { documentType, documentNumber, documentUrl, selfieUrl, address } = req.body;
        if (!documentType || !documentNumber || !documentUrl || !selfieUrl) {
            return res.status(400).json({ message: "Document type, number, ID image and selfie are required" });
        }

        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ message: "User not found" });

        user.kycDetails = {
            idType: documentType,
            idNumber: documentNumber,
            documentUrl,
            selfieUrl,
            address: address || "",
            submittedAt: new Date()
        };
        user.address = address || user.address;
        user.kycStatus = "under_review";
        user.kycRejectionReason = "";
        user.isVerified = false;
        await user.save();

        return res.status(200).json({
            message: "KYC submitted successfully",
            kyc: { status: user.kycStatus, submittedAt: user.kycDetails.submittedAt }
        });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

export const getMyKyc = async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select("kycStatus kycDetails kycRejectionReason");
        if (!user || user.kycStatus === "not_submitted") {
            return res.status(404).json({ message: "KYC record not found" });
        }

        return res.status(200).json({
            kyc: {
                status: user.kycStatus,
                rejectionReason: user.kycRejectionReason,
                ...user.kycDetails?.toObject?.() || user.kycDetails || {}
            }
        });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

export const getKycSubmissions = async (req, res) => {
    try {
        const users = await User.find({ kycStatus: { $in: ["under_review", "verified", "rejected", "resubmit"] } })
            .select("name email phone address role kycStatus kycDetails kycRejectionReason createdAt")
            .sort({ "kycDetails.submittedAt": -1 });

        const kyc = users.map(user => ({
            id: user._id,
            name: user.name,
            email: user.email,
            phone: user.phone || "",
            address: user.address || user.kycDetails?.address || "",
            role: user.role,
            status: user.kycStatus,
            documentType: user.kycDetails?.idType || "",
            documentUrl: user.kycDetails?.documentUrl || "",
            selfieUrl: user.kycDetails?.selfieUrl || "",
            submittedAt: user.kycDetails?.submittedAt || user.createdAt,
            rejectionReason: user.kycRejectionReason || ""
        }));

        return res.status(200).json({ kyc });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

export const verifyUserKyc = async (req, res) => {
    try {
        const userId = req.params.id;
        const status = String(req.body.status || "verified").toLowerCase();
        if (!["verified", "rejected", "resubmit"].includes(status)) {
            return res.status(400).json({ message: "Status must be verified, rejected, or resubmit" });
        }

        const user = await User.findById(userId);
        if (!user || user.kycStatus === "not_submitted") {
            return res.status(404).json({ message: "KYC submission not found" });
        }

        user.kycStatus = status;
        user.isVerified = status === "verified";
        user.kycRejectionReason = status === "rejected" ? String(req.body.rejectionReason || "") : "";
        await user.save();

        return res.status(200).json({
            message: `User KYC ${status}`,
            kyc: { id: user._id, status: user.kycStatus, rejectionReason: user.kycRejectionReason }
        });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

// Admin: Approve Equipment Listing
export const approveEquipment = async (req, res) => {
    try {
        const equipmentId = req.params.id;
        const equipment = await Equipment.findByIdAndUpdate(
            equipmentId,
            { status: "approved" },
            { new: true }
        );
        res.status(200).json({ message: "Equipment approved and live!", equipment });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};