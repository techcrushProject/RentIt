const mongoose = require("mongoose");
const cloudinary = require("../config/cloudinary");
const equipmentModel = require("../model/equipmentModel");

// CREATE EQUIPMENT
const createEquipment = async (req, res) => {
  try {
    const equipment = await equipmentModel.create(req.body);

    res.status(201).json({
      message: "Equipment created successfully",
      equipment,
    });
  } catch (error) {
    res.status(400).json({
      message: "Failed to create equipment",
      error: error.message,
    });
  }
};

// GET ALL EQUIPMENT
const getAllEquipment = async (req, res) => {
  try {
    const equipment = await equipmentModel
      .find()
      .populate("category");

    res.status(200).json({
      message: "Equipment fetched successfully",
      equipment,
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch equipment",
      error: error.message,
    });
  }
};

// GET ONE EQUIPMENT
const getOneEquipment = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        message: "Invalid equipment ID",
      });
    }

    const equipment = await equipmentModel
      .findById(id)
      .populate("category");

    if (!equipment) {
      return res.status(404).json({
        message: "Equipment not found",
      });
    }

    res.status(200).json({
      message: "Equipment fetched successfully",
      equipment,
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch equipment",
      error: error.message,
    });
  }
};

// UPDATE EQUIPMENT
const updateEquipment = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        message: "Invalid equipment ID",
      });
    }

    // Prevent owner from being changed through this endpoint
    const { owner, ...updates } = req.body;

    const equipment = await equipmentModel.findByIdAndUpdate(
      id,
      updates,
      {
        new: true,
        runValidators: true,
      }
    );

    if (!equipment) {
      return res.status(404).json({
        message: "Equipment not found",
      });
    }

    res.status(200).json({
      message: "Equipment updated successfully",
      equipment,
    });
  } catch (error) {
    res.status(400).json({
      message: "Failed to update equipment",
      error: error.message,
    });
  }
};

// DELETE EQUIPMENT
const deleteEquipment = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        message: "Invalid equipment ID",
      });
    }

    const equipment = await equipmentModel.findByIdAndDelete(id);

    if (!equipment) {
      return res.status(404).json({
        message: "Equipment not found",
      });
    }

    res.status(200).json({
      message: "Equipment deleted successfully",
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to delete equipment",
      error: error.message,
    });
  }
};

// UPLOAD EQUIPMENT IMAGES
const uploadEquipmentImages = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        message: "Invalid equipment ID",
      });
    }

    const equipment = await equipmentModel.findById(id);

    if (!equipment) {
      return res.status(404).json({
        message: "Equipment not found",
      });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        message: "Please upload at least one image",
      });
    }

    const imageUrls = [];

    for (const file of req.files) {
      const result = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder: "rentit/equipment",
          },
          (error, result) => {
            if (error) {
              reject(error);
            } else {
              resolve(result);
            }
          }
        );

        uploadStream.end(file.buffer);
      });

      imageUrls.push(result.secure_url);
    }

    equipment.images.push(...imageUrls);

    await equipment.save();

    res.status(200).json({
      message: "Equipment images uploaded successfully",
      equipment,
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to upload equipment images",
      error: error.message,
    });
  }
};

module.exports = {
  createEquipment,
  getAllEquipment,
  getOneEquipment,
  updateEquipment,
  deleteEquipment,
  uploadEquipmentImages,
};

