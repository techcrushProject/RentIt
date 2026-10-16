const express = require("express");
const protect = require("../middleware/authMiddleware");
const authorizeRoles = require("../middleware/roleMiddleware");
const {
  getAdminEquipment,
  getOneEquipment,
  reviewEquipment,
} = require("../controller/equipmentController");

const router = express.Router();

router.use(protect, authorizeRoles("admin"));
router.get("/", getAdminEquipment);
router.get("/:id", getOneEquipment);
router.put("/:id/review", reviewEquipment);

module.exports = router;
