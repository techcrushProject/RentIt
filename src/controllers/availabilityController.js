import mongoose from "mongoose";
import {
  parseDate,
  validateDateRange,
} from "../utils/dateUtils.js";

import {
  checkEquipmentAvailability,
} from "../services/availabilityService.js";

export const getEquipmentAvailability = async (
  req,
  res
) => {
  try {
    const { equipmentId } = req.params;
    const { startDate, endDate } = req.query;

    if (!mongoose.Types.ObjectId.isValid(equipmentId)) {
      return res.status(400).json({
        message: "Invalid equipment ID",
      });
    }

    if (!startDate || !endDate) {
      return res.status(400).json({
        message: "startDate and endDate are required",
      });
    }

    const parsedStartDate = parseDate(startDate);
    const parsedEndDate = parseDate(endDate);

    const dateValidation = validateDateRange(
      parsedStartDate,
      parsedEndDate
    );

    if (!dateValidation.valid) {
      return res.status(400).json({
        message: dateValidation.message,
      });
    }

    const result = await checkEquipmentAvailability({
      equipmentId,
      startDate: parsedStartDate,
      endDate: parsedEndDate,
    });

    if (result.reason === "EQUIPMENT_NOT_FOUND") {
      return res.status(404).json({
        available: false,
        message: result.message,
      });
    }

    return res.status(200).json({
      available: result.available,
      message: result.message,
      startDate,
      endDate,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to check equipment availability",
      error: error.message,
    });
  }
};