const express = require("express");

const {
  createCategory,
  getAllCategories,
} = require("../controller/categoryController");

const router = express.Router();

router.post("/create", createCategory);

router.get("/getall", getAllCategories);

module.exports = router;