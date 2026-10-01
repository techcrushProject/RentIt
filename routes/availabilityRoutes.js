import express from "express";

import {
  getEquipmentAvailability,
} from "../controllers/availabilityController.js";

const router = express.Router();

router.get(
  "/:equipmentId/availability",
  getEquipmentAvailability
);

export default router;