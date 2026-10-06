import mongoose from "mongoose";
import Booking from "../models/Booking.js";

import {
  parseDate,
  validateDateRange,
  calculateRentalDays,
} from "../utils/dateUtils.js";

import {
  checkEquipmentAvailability,
} from "../services/availabilityService.js";

//CREATE BOOKING
export const createBooking = async (req, res) => {
  try {
    const {
      renterId,
      equipmentId,
      startDate,
      endDate,
    } = req.body;


    // 1. Check required fields

    if (
      !renterId ||
      !equipmentId ||
      !startDate ||
      !endDate
    ) {
      return res.status(400).json({
        message:
          "renterId, equipmentId, startDate and endDate are required",
      });
    }


    // 2. Validate MongoDB IDs

    if (!mongoose.Types.ObjectId.isValid(renterId)) {
      return res.status(400).json({
        message: "Invalid renter ID",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(equipmentId)) {
      return res.status(400).json({
        message: "Invalid equipment ID",
      });
    }


    // 3. Convert date strings into JavaScript Dates

    const parsedStartDate = parseDate(startDate);
    const parsedEndDate = parseDate(endDate);


    // 4. Validate the requested date range

    const dateValidation = validateDateRange(
      parsedStartDate,
      parsedEndDate
    );

    if (!dateValidation.valid) {
      return res.status(400).json({
        message: dateValidation.message,
      });
    }


    // 5. Check whether the equipment is available

    const availability =
      await checkEquipmentAvailability({
        equipmentId,
        startDate: parsedStartDate,
        endDate: parsedEndDate,
      });


    if (
      availability.reason === "EQUIPMENT_NOT_FOUND"
    ) {
      return res.status(404).json({
        message: availability.message,
      });
    }


    if (!availability.available) {
      return res.status(409).json({
        message: availability.message,
        reason: availability.reason,
      });
    }


    // 6. Get the equipment returned by
    // the availability service

    const equipment = availability.equipment;


    // 7. Prevent owner from booking own equipment

    if (
      equipment.ownerId.toString() ===
      renterId.toString()
    ) {
      return res.status(400).json({
        message:
          "You cannot book your own equipment",
      });
    }


    // 8. Calculate rental duration

    const rentalDays = calculateRentalDays(
      parsedStartDate,
      parsedEndDate
    );


    // 9. Calculate pricing

    const pricePerDay = equipment.pricePerDay;

    const rentalAmount =
      pricePerDay * rentalDays;

    const securityDeposit =
      equipment.securityDeposit;

    const totalAmount =
      rentalAmount + securityDeposit;


    // 10. Create the booking

    const booking = await Booking.create({
      renterId,

      ownerId: equipment.ownerId,

      equipmentId,

      startDate: parsedStartDate,

      endDate: parsedEndDate,

      rentalDays,

      pricePerDay,

      rentalAmount,

      securityDeposit,

      totalAmount,

      status: "pending",
    });


    return res.status(201).json({
      message:
        "Booking request created successfully",

      booking,
    });

  } catch (error) {
    return res.status(500).json({
      message: "Failed to create booking",
      error: error.message,
    });
  }
};

//APPROVE BOOKING
export const approveBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;

    // 1. Validate booking ID
    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({
        message: "Invalid booking ID",
      });
    }

    // 2. Find booking
    const booking = await Booking.findById(bookingId);

    if (!booking) {
      return res.status(404).json({
        message: "Booking not found",
      });
    }

    // 3. Only pending bookings can be approved
    if (booking.status !== "pending") {
      return res.status(400).json({
        message: `Booking cannot be approved because its current status is ${booking.status}`,
      });
    }

    // 4. Check availability again
    const availability = await checkEquipmentAvailability({
      equipmentId: booking.equipmentId,
      startDate: booking.startDate,
      endDate: booking.endDate,
      excludeBookingId: booking._id,
    });

    if (!availability.available) {
      return res.status(409).json({
        message:
          "Booking cannot be approved because the equipment is no longer available for these dates",
        reason: availability.reason,
      });
    }

    // 5. Approve booking
    booking.status = "approved";

    await booking.save();

    return res.status(200).json({
      message: "Booking approved successfully",
      booking,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to approve booking",
      error: error.message,
    });
  }
};

//REJECT BOOKING
export const rejectBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({
        message: "Invalid booking ID",
      });
    }

    const booking = await Booking.findById(bookingId);

    if (!booking) {
      return res.status(404).json({
        message: "Booking not found",
      });
    }

    if (booking.status !== "pending") {
      return res.status(400).json({
        message: `Booking cannot be rejected because its current status is ${booking.status}`,
      });
    }

    booking.status = "rejected";

    await booking.save();

    return res.status(200).json({
      message: "Booking rejected successfully",
      booking,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to reject booking",
      error: error.message,
    });
  }
};

//CANCEL BOOKING
export const cancelBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { reason } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({
        message: "Invalid booking ID",
      });
    }

    const booking = await Booking.findById(bookingId);

    if (!booking) {
      return res.status(404).json({
        message: "Booking not found",
      });
    }

    const cancellableStatuses = [
      "pending",
      "approved",
    ];

    if (!cancellableStatuses.includes(booking.status)) {
      return res.status(400).json({
        message: `Booking cannot be cancelled because its current status is ${booking.status}`,
      });
    }

    booking.status = "cancelled";
    booking.cancellationReason = reason || null;

    await booking.save();

    return res.status(200).json({
      message: "Booking cancelled successfully",
      booking,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to cancel booking",
      error: error.message,
    });
  }
};

//GET BOOKING BY ID
export const getBookingById = async (req, res) => {
  try {
    const { bookingId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({
        message: "Invalid booking ID",
      });
    }

    const booking = await Booking.findById(bookingId);

    if (!booking) {
      return res.status(404).json({
        message: "Booking not found",
      });
    }

    return res.status(200).json({
      message: "Booking retrieved successfully",
      booking,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to retrieve booking",
      error: error.message,
    });
  }
};

//GET ALL BOOKINGS
export const getAllBookings = async (req, res) => {
  try {
    const bookings = await Booking.find()
      .sort({ createdAt: -1 });

    return res.status(200).json({
      message: "Bookings retrieved successfully",
      count: bookings.length,
      bookings,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to retrieve bookings",
      error: error.message,
    });
  }
};

