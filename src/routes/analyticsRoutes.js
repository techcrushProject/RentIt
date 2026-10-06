import express from "express";
import { rentalRevenue } from "../src/controllers/analyticsController.js";

const router = express.Router();

router.get("/revenue", rentalRevenue);

export default router;