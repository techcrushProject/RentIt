import express from "express";
import {
  createTestEquipment,
  addUnavailablePeriod,
} from "../src/controllers/testEquipmentController.js";

const router = express.Router();

router.post("/", createTestEquipment);

router.patch(
  "/:equipmentId/unavailable",
  addUnavailablePeriod
);

export default router;