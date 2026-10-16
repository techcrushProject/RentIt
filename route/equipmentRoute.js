const express = require("express");

const {
  createEquipment,
  getAllEquipment,
  getPublishedEquipment,
  getOwnerEquipment,
  getOneEquipment,
  updateEquipment,
  deleteEquipment,
  uploadEquipmentImages,
} = require("../controller/equipmentController");

const upload = require("../config/multer");
const protect = require("../middleware/authMiddleware");
const authorizeRoles = require("../middleware/roleMiddleware");

const router = express.Router();

// API-base aliases used by the owner and renter dashboards.
router.get("/", getPublishedEquipment);
router.post("/", protect, authorizeRoles("owner"), createEquipment);

router.post("/create", protect, authorizeRoles("owner"), createEquipment);

router.get("/getall", getAllEquipment);

router.get("/explore", getPublishedEquipment);

router.get("/mine", protect, authorizeRoles("owner"), getOwnerEquipment);

router.get("/getone/:id", getOneEquipment);

router.patch("/update/:id", protect, authorizeRoles("owner"), updateEquipment);

router.delete("/delete/:id", protect, authorizeRoles("owner"), deleteEquipment);

router.post(
  "/upload/:id",
  protect,
  authorizeRoles("owner"),
  upload.array("images", 5),
  uploadEquipmentImages
);

module.exports = router;
