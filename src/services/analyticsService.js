import Booking from "../models/Booking.js";

export const getRentalRevenue = async () => {
  const result = await Booking.aggregate([
    {
      $match: {
        status: "completed",
      },
    },
    {
      $group: {
        _id: null,
        totalRevenue: {
          $sum: "$rentalAmount",
        },
      },
    },
  ]);

  return result[0]?.totalRevenue || 0;
};