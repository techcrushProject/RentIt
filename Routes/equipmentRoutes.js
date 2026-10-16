import express from "express";
import {
    createEquipment,
    deleteEquipment,
    getEquipment,
    getMyEquipment,
    listEquipment,
    updateEquipment,
} from "../Controllers/equipmentController.js";
import protect, { optionalAuth } from "../Middleware/authMiddleware.js";
import authorizeRoles from "../Middleware/roleMiddleware.js";

const router = express.Router();

// Mounted at /api/equipment and /equipment. The legacy paths (/getall, /getone/:id,
// /create, /update/:id, /delete/:id) are still called by the dashboards.
// Fixed paths come before the generic /:id routes, otherwise "mine" would be read as an id.
router.get("/", optionalAuth, listEquipment);
router.get("/getall", optionalAuth, listEquipment);
router.get("/mine", protect, authorizeRoles("owner"), getMyEquipment);
router.get("/getone/:id", optionalAuth, getEquipment);
router.get("/:id", optionalAuth, getEquipment);

router.post("/", protect, authorizeRoles("owner"), createEquipment);
router.post("/create", protect, authorizeRoles("owner"), createEquipment);

router.patch("/update/:id", protect, authorizeRoles("owner"), updateEquipment);
router.patch("/:id", protect, authorizeRoles("owner"), updateEquipment);

router.delete("/delete/:id", protect, authorizeRoles("owner", "admin"), deleteEquipment);
router.delete("/:id", protect, authorizeRoles("owner", "admin"), deleteEquipment);

export default router;
