import express from "express";
import { CATEGORIES } from "../config/categories.js";

const router = express.Router();

// Mounted at /api/categories and /category (the dashboards call /category/getall).
const listCategories = (req, res) => {
    res.status(200).json({ categories: CATEGORIES });
};

router.get("/", listCategories);
router.get("/getall", listCategories);

export default router;
