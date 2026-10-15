import express from "express";
import { createEquipment } from "../Controllers/equipmentController.js";
import protect from "../Middleware/authMiddleware.js";
import authorizeRoles from "../Middleware/roleMiddleware.js";

const router = express.Router();

router.post("/", protect, authorizeRoles("owner"), createEquipment);

export default router;