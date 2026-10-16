import express from "express";
import { getMyKyc, submitKyc } from "../Controllers/kycController.js";
import protect from "../Middleware/authMiddleware.js";
import authorizeRoles from "../Middleware/roleMiddleware.js";

const router = express.Router();

router.get("/me", protect, getMyKyc);
router.post("/", protect, authorizeRoles("owner", "renter"), submitKyc);

export default router;
