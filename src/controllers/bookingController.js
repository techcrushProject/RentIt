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

// CREATE BOOKING
export const createBooking = async (req, res) => {
  try {
    const {
      renterId,
      equipmentId,
      startDate,
      endDate,
    } = req.body;

    // 1. Validate required fields
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

    // 2. Validate IDs
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

    // 3. Parse and validate dates
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

    // 4. Check equipment availability.
    // Pending requests do not block other requests.
    const availability = await checkEquipmentAvailability({
      equipmentId,
      startDate: parsedStartDate,
      endDate: parsedEndDate,
    });

    if (availability.reason === "EQUIPMENT_NOT_FOUND") {
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

    const equipment = availability.equipment;

    // 5. Prevent owners from renting their own equipment
    if (
      equipment.ownerId.toString() === renterId.toString()
    ) {
      return res.status(400).json({
        message: "You cannot book your own equipment",
      });
    }

    // 6. Calculate rental price
    const rentalDays = calculateRentalDays(
      parsedStartDate,
      parsedEndDate
    );

    const pricePerDay = equipment.pricePerDay;
    const rentalAmount = pricePerDay * rentalDays;
    const securityDeposit = equipment.securityDeposit;
    const totalAmount = rentalAmount + securityDeposit;

    // 7. Create booking.
    // Payment must be verified before owner approval.
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

      paymentStatus: "pending",

      refundStatus: "not_required",
    });

    return res.status(201).json({
      message:
        "Booking request created. Complete payment before the owner can approve it.",
      booking,
    });
  } catch (error) {
    console.error("Create booking error:", error);

    return res.status(500).json({
      message: "Failed to create booking",
    });
  }
};

// APPROVE BOOKING
export const approveBooking = async (req, res) => {
  const session = await mongoose.startSession();

  let approvedBooking;

  try {
    const { bookingId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({
        message: "Invalid booking ID",
      });
    }

    await session.withTransaction(async () => {
      // 1. Load booking inside the transaction
      const booking = await Booking.findById(bookingId)
        .session(session);

      if (!booking) {
        throw new Error("BOOKING_NOT_FOUND");
      }

      // 2. Only pending bookings may be approved
      if (booking.status !== "pending") {
        throw new Error("BOOKING_NOT_PENDING");
      }

      // 3. Payment must have been verified by the
      // payment provider/webhook before approval.
      if (booking.paymentStatus !== "succeeded") {
        throw new Error("PAYMENT_NOT_COMPLETED");
      }

      // 4. Check for an existing booking that has
      // already claimed these rental dates.
      const conflictingBooking = await Booking.findOne({
        _id: { $ne: booking._id },
        equipmentId: booking.equipmentId,
        status: {
          $in: ["approved", "picked_up", "active"],
        },
        startDate: { $lte: booking.endDate },
        endDate: { $gte: booking.startDate },
      }).session(session);

      if (conflictingBooking) {
        throw new Error("BOOKING_CONFLICT");
      }

      // 5. Approve the winning booking
      booking.status = "approved";

      await booking.save({ session });

      // 6. Find competing paid pending requests.
      // Only overlapping dates for the same equipment
      // should be affected.
      const competingBookings = await Booking.find({
        _id: { $ne: booking._id },
        equipmentId: booking.equipmentId,
        status: "pending",
        paymentStatus: "succeeded",
        startDate: { $lte: booking.endDate },
        endDate: { $gte: booking.startDate },
      }).session(session);

      // 7. Reject competing requests and record
      // that their payments require refunds.
      for (const competingBooking of competingBookings) {
        competingBooking.status = "rejected";
        competingBooking.refundStatus = "pending";

        await competingBooking.save({ session });
      }

      approvedBooking = booking;
    });

    return res.status(200).json({
      message:
        "Booking approved. Competing paid requests have been marked for refund.",
      booking: approvedBooking,
    });
  } catch (error) {
    if (error.message === "BOOKING_NOT_FOUND") {
      return res.status(404).json({
        message: "Booking not found",
      });
    }

    if (error.message === "BOOKING_NOT_PENDING") {
      return res.status(400).json({
        message: "Only pending bookings can be approved",
      });
    }

    if (error.message === "PAYMENT_NOT_COMPLETED") {
      return res.status(400).json({
        message:
          "Booking cannot be approved because payment has not been completed",
      });
    }

    if (error.message === "BOOKING_CONFLICT") {
      return res.status(409).json({
        message:
          "The equipment has already been approved for overlapping dates",
        reason: "BOOKING_CONFLICT",
      });
    }

    console.error("Approve booking error:", error);

    return res.status(500).json({
      message: "Failed to approve booking",
    });
  } finally {
    await session.endSession();
  }
};

// REJECT BOOKING
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
        message:
          `Booking cannot be rejected because its current status is ${booking.status}`,
      });
    }

    booking.status = "rejected";

    // A successfully paid booking needs a refund.
    if (booking.paymentStatus === "succeeded") {
      booking.refundStatus = "pending";
    }

    await booking.save();

    return res.status(200).json({
      message:
        booking.refundStatus === "pending"
          ? "Booking rejected. Refund processing is required."
          : "Booking rejected successfully.",
      booking,
    });
  } catch (error) {
    console.error("Reject booking error:", error);

    return res.status(500).json({
      message: "Failed to reject booking",
    });
  }
};

// CANCEL BOOKING
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
        message:
          `Booking cannot be cancelled because its current status is ${booking.status}`,
      });
    }

    booking.status = "cancelled";
    booking.cancellationReason = reason || null;

    if (booking.paymentStatus === "succeeded") {
      booking.refundStatus = "pending";
    }

    await booking.save();

    return res.status(200).json({
      message:
        booking.refundStatus === "pending"
          ? "Booking cancelled. Refund processing is required."
          : "Booking cancelled successfully.",
      booking,
    });
  } catch (error) {
    console.error("Cancel booking error:", error);

    return res.status(500).json({
      message: "Failed to cancel booking",
    });
  }
};

// GET BOOKING BY ID
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
    console.error("Get booking error:", error);

    return res.status(500).json({
      message: "Failed to retrieve booking",
    });
  }
};

// GET ALL BOOKINGS
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
    console.error("Get all bookings error:", error);

    return res.status(500).json({
      message: "Failed to retrieve bookings",
    });
  }
};

