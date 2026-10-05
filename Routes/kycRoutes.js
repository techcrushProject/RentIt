import express from "express";

import {
    submitKyc,
    getMyKyc,
    resubmitKyc,
    getAllKyc,
    getKycById,
    verifyKyc,
    requestKycResubmission,
    rejectKyc,
} from "../Controllers/kycController.js";

import protect from "../Middleware/authMiddleware.js";
import authorizeRoles from "../Middleware/roleMiddleware.js";

const router = express.Router();

router.post("/", protect, submitKyc);
router.get("/me", protect, getMyKyc);
router.patch("/resubmit", protect, resubmitKyc);

router.get("/", protect, authorizeRoles("admin"), getAllKyc);
router.get("/:id", protect, authorizeRoles("admin"), getKycById);

router.patch("/:id/verify", protect, authorizeRoles("admin"), verifyKyc);
router.patch("/:id/resubmit", protect, authorizeRoles("admin"), requestKycResubmission);
router.patch("/:id/reject", protect, authorizeRoles("admin"), rejectKyc);

export default router;