import Booking from "../models/Booking.js";
import Equipment from "../models/Equipment.js";
import { datesOverlap } from "../utils/dateUtils.js";

const BLOCKING_STATUSES = [
  "approved",
  "picked_up",
  "active",
];

export const checkEquipmentAvailability = async ({
  equipmentId,
  startDate,
  endDate,
  excludeBookingId = null,
}) => {
  const equipment = await Equipment.findById(equipmentId);

  if (!equipment) {
    return {
      available: false,
      reason: "EQUIPMENT_NOT_FOUND",
      message: "Equipment not found",
    };
  }

  if (equipment.status !== "active") {
    return {
      available: false,
      reason: "EQUIPMENT_INACTIVE",
      message: "Equipment is currently inactive",
    };
  }

  const manuallyUnavailable = equipment.unavailablePeriods.some(
    (period) =>
      datesOverlap(
        period.startDate,
        period.endDate,
        startDate,
        endDate
      )
  );

  if (manuallyUnavailable) {
    return {
      available: false,
      reason: "MANUALLY_UNAVAILABLE",
      message: "Equipment is unavailable for the selected dates",
    };
  }

  const bookingQuery = {
    equipmentId,
    status: {
      $in: BLOCKING_STATUSES,
    },
    startDate: {
      $lte: endDate,
    },
    endDate: {
      $gte: startDate,
    },
  };

  if (excludeBookingId) {
    bookingQuery._id = {
      $ne: excludeBookingId,
    };
  }

  const conflictingBooking =
    await Booking.findOne(bookingQuery);

  if (conflictingBooking) {
    return {
      available: false,
      reason: "BOOKING_CONFLICT",
      message: "Equipment is already booked for the selected dates",
    };
  }

  return {
    available: true,
    reason: null,
    message: "Equipment is available for the selected dates",
    equipment,
  };
};