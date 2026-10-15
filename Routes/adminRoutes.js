import express from "express";
import { getKycSubmissions, verifyUserKyc, approveEquipment } from "../Controllers/adminControllers.js";
import protect from "../Middleware/authMiddleware.js";
import authorizeRoles from "../Middleware/roleMiddleware.js";

const router = express.Router();
router.get("/kyc", protect, authorizeRoles("admin"), getKycSubmissions);
router.put("/verify-user/:id", protect, authorizeRoles("admin"), verifyUserKyc);
router.put("/equipment/:id/approve", protect, authorizeRoles("admin"), approveEquipment);

export default router;