const express = require("express");
const {
  getAdminEquipment,
  getOneEquipment,
  reviewEquipment,
} = require("../controller/equipmentController");

const router = express.Router();

router.get("/", getAdminEquipment);
router.get("/:id", getOneEquipment);
router.put("/:id/review", reviewEquipment);

module.exports = router;
