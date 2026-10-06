import express from "express";

import {
  createBooking,
  approveBooking,
  rejectBooking,
  cancelBooking,
  getBookingById,
  getAllBookings,
} from "../src/controllers/bookingController.js";

const router = express.Router();

router.post("/", createBooking);

router.get("/", getAllBookings);

router.get("/:bookingId", getBookingById);

router.patch("/:bookingId/approve", approveBooking);

router.patch("/:bookingId/reject", rejectBooking);

router.patch("/:bookingId/cancel", cancelBooking);

export default router;