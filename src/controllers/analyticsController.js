import { getRentalRevenue } from "../services/analyticsService.js";

export const rentalRevenue = async (req, res, next) => {
  try {
    const revenue = await getRentalRevenue();

    res.status(200).json({
      success: true,
      revenue,
    });
  } catch (error) {
    next(error);
  }
};