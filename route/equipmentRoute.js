const express = require("express");

const {
  createEquipment,
  getAllEquipment,
  getOneEquipment,
  updateEquipment,
  deleteEquipment,
  uploadEquipmentImages,
} = require("../controller/equipmentController");

const upload = require("../config/multer");

const router = express.Router();

router.post("/create", createEquipment);

router.get("/getall", getAllEquipment);

router.get("/getone/:id", getOneEquipment);

router.patch("/update/:id", updateEquipment);

router.delete("/delete/:id", deleteEquipment);

router.post(
  "/upload/:id",
  upload.array("images", 5),
  uploadEquipmentImages
);

module.exports = router;