import mongoose from "mongoose";
import Equipment from "../models/Equipment.js";
import {
  parseDate,
  validateDateRange,
} from "../utils/dateUtils.js";

//CREATE TEST EQUIPMENT FOR TESTING
export const createTestEquipment = async (req, res) => {
  try {
    const {
      ownerId,
      name,
      pricePerDay,
      securityDeposit,
    } = req.body;

    if (
      !ownerId ||
      !name ||
      pricePerDay === undefined ||
      securityDeposit === undefined
    ) {
      return res.status(400).json({
        message:
          "ownerId, name, pricePerDay and securityDeposit are required",
      });
    }

    const equipment = await Equipment.create({
      ownerId,
      name,
      pricePerDay,
      securityDeposit,
    });

    return res.status(201).json({
      message: "Test equipment created successfully",
      equipment,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to create test equipment",
      error: error.message,
    });
  }
};

//ADD UNAVAILABLE PERIOD MANUALLY
export const addUnavailablePeriod = async (req, res) => {
  try {
    const { equipmentId } = req.params;
    const { startDate, endDate } = req.body || {};

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

    const equipment = await Equipment.findById(equipmentId);

    if (!equipment) {
      return res.status(404).json({
        message: "Equipment not found",
      });
    }

    equipment.unavailablePeriods.push({
      startDate: parsedStartDate,
      endDate: parsedEndDate,
    });

    await equipment.save();

    return res.status(200).json({
      message: "Unavailable period added successfully",
      equipment,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to add unavailable period",
      error: error.message,
    });
  }
};