const categoryModel = require("../model/categoryModel");

// CREATE CATEGORY
const createCategory = async (req, res) => {
  try {
    const { name, description } = req.body;

    const category = await categoryModel.create({
      name,
      description,
    });

    res.status(201).json({
      message: "Category created successfully",
      category,
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to create category",
      error: error.message,
    });
  }
};

// GET ALL CATEGORIES
const getAllCategories = async (req, res) => {
  try {
    const categories = await categoryModel.find();

    res.status(200).json({
      message: "Categories fetched successfully",
      categories,
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch categories",
      error: error.message,
    });
  }
};

module.exports = {
  createCategory,
  getAllCategories,
};