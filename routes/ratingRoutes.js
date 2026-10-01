import express from "express";

import {
  createRating, getAllReviews
} from"../controller/ratingController.js";


const router = express.Router();

// Submit a rating
router.post("/", createRating);
router.get("/all-reviews", getAllReviews);


export default router;