import mongoose from"mongoose";
import Rating  from "../models/Rating.js";

// @desc    Submit a rating for a completed rental
// @route   POST /api/ratings
export const createRating = async (req, res, next) => {
  try {
    const {
      
      communication,
      reliability,
      equipmentCondition,
      overallRating,
      comment,
    } = req.body;


    const reviewType = "renter_to_owner"

    const rating = await Rating.create({
      //rental: rentalId,
     // reviewer: req.user._id,
     // reviewee,
     // equipment: rental.equipment,
      reviewType,
      communication,
      reliability,
      equipmentCondition,
      overallRating,
      comment,
      isVerifiedRental: true,
      status: "published"
    });

    return res.status(201).json({
      success: true,
      message: "Rating submitted successfully.",
      data: rating,
    });
  }catch (error) {
  console.error("CREATE RATING ERROR:", error);

  return res.status(500).json({
    success: false,
    message: error.message,
    error: error
  });
}
    next(error);
  
};


//GENERAL GET : 
export const getAllReviews = async (req, res) => {
    try {
        const getAll = await Rating.find()
        return res.status(200).json({
            message: "All Reviews fetched successfully",
            data: getAll
        })
    } catch (error) {
        return res.status(500).json({
            message: error.message
        })
    }
}

