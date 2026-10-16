const mongoose = require("mongoose");
const cloudinary = require("../config/cloudinary");
const equipmentModel = require("../model/equipmentModel");

// CREATE EQUIPMENT
const createEquipment = async (req, res) => {
  try {
    const {
      name, title, description, category, brand, model, condition,
      additionalInformation, pricePerDay, price, rentalDeposit, rentalRules,
      location, availableDate, unavailableDate, handoverMethod, images,
    } = req.body;

    const owner = req.user.id;
    const equipmentName = String(name || title || "").trim();
    const dailyPrice = Number(pricePerDay ?? price);
    if (!equipmentName || !description || !location || !mongoose.Types.ObjectId.isValid(category) || !mongoose.Types.ObjectId.isValid(owner)) {
      return res.status(400).json({ message: "Name, description, category, and location are required" });
    }
    if (!Number.isFinite(dailyPrice) || dailyPrice <= 0) {
      return res.status(400).json({ message: "pricePerDay must be a positive number" });
    }
    if (images !== undefined && (!Array.isArray(images) || images.length > 5)) {
      return res.status(400).json({ message: "Images must be an array containing no more than five URLs" });
    }

    const equipment = await equipmentModel.create({
      name: equipmentName, description, category, owner, brand, model, condition,
      additionalInformation, pricePerDay: dailyPrice,
      rentalDeposit: Math.max(0, Number(rentalDeposit) || 0),
      rentalRules, location, availableDate, unavailableDate, handoverMethod,
      images: images || [],
      availability: true,
      status: "pending",
      reviewNote: "",
      reviewedAt: undefined,
    });

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

// Renter Explore feed: only equipment that an admin approved and the owner
// currently marks as available is published here.
const getPublishedEquipment = async (req, res) => {
  try {
    const equipment = await equipmentModel
      .find({ status: "approved", availability: true })
      .populate("category")
      .sort({ createdAt: -1 });

    return res.status(200).json({ equipment });
  } catch (error) {
    return res.status(500).json({ message: "Failed to load available equipment", error: error.message });
  }
};

// Owner dashboard: return only the signed-in owner's records, including the
// saved admin decision and feedback.
const getOwnerEquipment = async (req, res) => {
  try {
    const ownerId = req.user.id;
    if (!mongoose.Types.ObjectId.isValid(ownerId)) {
      return res.status(400).json({ message: "A valid ownerId is required" });
    }
    const equipment = await equipmentModel
      .find({ owner: ownerId })
      .populate("category")
      .sort({ createdAt: -1 });
    return res.status(200).json({ equipment });
  } catch (error) {
    return res.status(500).json({ message: "Failed to load owner equipment", error: error.message });
  }
};

// Admin dashboard queue: includes pending, approved, and rejected listings.
const getAdminEquipment = async (req, res) => {
  try {
    const filter = req.query.status ? { status: req.query.status } : {};
    const equipment = await equipmentModel
      .find(filter)
      .populate("category")
      .sort({ createdAt: -1 });
    return res.status(200).json({ equipment });
  } catch (error) {
    return res.status(500).json({ message: "Failed to load admin equipment listings", error: error.message });
  }
};

const reviewEquipment = async (req, res) => {
  try {
    const { id } = req.params;
    const status = String(req.body.status || "").toLowerCase();
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid equipment ID" });
    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ message: "Status must be approved or rejected" });
    }

    const equipment = await equipmentModel.findById(id);
    if (!equipment) return res.status(404).json({ message: "Equipment not found" });

    equipment.status = status;
    equipment.availability = status === "approved";
    equipment.reviewNote = String(req.body.reviewNote || "").trim();
    equipment.reviewedAt = new Date();
    await equipment.save();

    return res.status(200).json({
      message: `Equipment ${status}`,
      equipment,
      ownerResponse: {
        status: equipment.status,
        message: equipment.reviewNote,
        reviewedAt: equipment.reviewedAt,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to review equipment", error: error.message });
  }
};

// GET ALL EQUIPMENT
const getAllEquipment = async (req, res) => {
  try {
    const equipment = await equipmentModel
      .find({ status: "approved", availability: true })
      .populate("category")
      .sort({ createdAt: -1 });

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

    const filter = req.baseUrl.includes("/admin/") ? { _id: id } : { _id: id, status: "approved", availability: true };
    const equipment = await equipmentModel.findOne(filter).populate("category");

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
    const updates = { ...req.body };
    delete updates.owner;
    delete updates.status;
    delete updates.reviewNote;
    delete updates.reviewedAt;

    const equipment = await equipmentModel.findOneAndUpdate(
      { _id: id, owner: req.user.id },
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

    const equipment = await equipmentModel.findOneAndDelete({ _id: id, owner: req.user.id });

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

    const equipment = await equipmentModel.findOne({ _id: id, owner: req.user.id });

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
  getPublishedEquipment,
  getOwnerEquipment,
  getAdminEquipment,
  reviewEquipment,
  getAllEquipment,
  getOneEquipment,
  updateEquipment,
  deleteEquipment,
  uploadEquipmentImages,
};

