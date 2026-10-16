import express from "express";
import {
    approveEquipment,
    getKycDocument,
    getKycSubmissions,
    listEquipmentForReview,
    rejectEquipment,
    reviewEquipment,
    verifyUserKyc,
} from "../Controllers/adminControllers.js";
import protect from "../Middleware/authMiddleware.js";
import authorizeRoles from "../Middleware/roleMiddleware.js";

const router = express.Router();

// Every route below is admin-only; guarding the router means a new route cannot forget it.
router.use(protect, authorizeRoles("admin"));

router.get("/kyc", getKycSubmissions);
router.get("/kyc/:id/document", getKycDocument("document"));
router.get("/kyc/:id/selfie", getKycDocument("selfie"));
router.put("/verify-user/:id", verifyUserKyc);

router.get("/equipment", listEquipmentForReview);
router.put("/equipment/:id/approve", approveEquipment);
router.put("/equipment/:id/reject", rejectEquipment);
router.put("/equipment/:id/review", reviewEquipment);

export default router;
