const DamageClaim = require("../model/damageClaimModel");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

exports.createClaim = async (req, res, next) => {
  try {
    const { rental, claimant, description, amountRequested } = req.body;

    if (!rental || !claimant || !description || amountRequested === undefined) {
      return res.status(400).json({
        success: false,
        message: "rental, claimant, description and amountRequested are required",
      });
    }

    if (!mongoose.isValidObjectId(rental) || !mongoose.isValidObjectId(claimant)) {
      return res.status(400).json({
        success: false,
        message: "rental and claimant must be valid IDs",
      });
    }

    if (typeof amountRequested !== "number" || amountRequested <= 0) {
      return res.status(400).json({
        success: false,
        message: "amountRequested must be a number greater than 0",
      });
    }

    const claim = await DamageClaim.create({
      rental,
      claimant,
      description,
      amountRequested,
    });

    res.status(201).json({ success: true, data: claim });
  } catch (error) {
    next(error);
  }
};

exports.getAllClaims = async (req, res, next) => {
  try {
    const validStatuses = ["pending", "approved", "rejected", "resolved", "cancelled"];
    const filter = {};

    if (req.query.status) {
      if (!validStatuses.includes(req.query.status)) {
        return res.status(400).json({
          success: false,
          message: "status must be pending, approved, rejected, resolved or cancelled",
        });
      }
      filter.status = req.query.status;
    }

    const claims = await DamageClaim.find(filter).sort({ createdAt: -1 });
    res.json({ success: true, count: claims.length, data: claims });
  } catch (error) {
    next(error);
  }
};

exports.getClaimById = async (req, res, next) => {
  try {
    const claim = await DamageClaim.findById(req.params.id);

    if (!claim) {
      return res.status(404).json({ success: false, message: "Claim not found" });
    }

    res.json({ success: true, data: claim });
  } catch (error) {
    next(error);
  }
};

exports.updateClaimStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    const allowedStatuses = ["approved", "rejected", "resolved"];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Status must be approved, rejected or resolved",
      });
    }

    const claim = await DamageClaim.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true, runValidators: true }
    );

    if (!claim) {
      return res.status(404).json({ success: false, message: "Claim not found" });
    }

    res.json({ success: true, data: claim });
  } catch (error) {
    next(error);
  }
};

exports.cancelClaim = async (req, res, next) => {
  try {
    const claim = await DamageClaim.findById(req.params.id);

    if (!claim) {
      return res.status(404).json({ success: false, message: "Claim not found" });
    }

    if (claim.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: "Only pending claims can be cancelled",
      });
    }

    claim.status = "cancelled";
    await claim.save();

    res.json({ success: true, data: claim });
  } catch (error) {
    next(error);
  }
};

exports.uploadClaimImages = async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Please upload at least one image",
      });
    }

    const claim = await DamageClaim.findById(req.params.id);

    if (!claim) {
      return res.status(404).json({ success: false, message: "Claim not found" });
    }

    if (claim.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: "Photos can only be added to pending claims",
      });
    }

    const paths = req.files.map((file) => `/uploads/claims/${file.filename}`);
    claim.images.push(...paths);
    await claim.save();

    res.json({ success: true, data: claim });
  } catch (error) {
    next(error);
  }
};

exports.deleteClaimImage = async (req, res, next) => {
  try {
    const claim = await DamageClaim.findById(req.params.id);

    if (!claim) {
      return res.status(404).json({ success: false, message: "Claim not found" });
    }

    if (claim.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: "Photos can only be removed from pending claims",
      });
    }

    const fileName = path.basename(req.params.filename);
    const imagePath = `/uploads/claims/${fileName}`;

    if (!claim.images.includes(imagePath)) {
      return res.status(404).json({
        success: false,
        message: "Image not found on this claim",
      });
    }

    claim.images = claim.images.filter((img) => img !== imagePath);
    await claim.save();

    const filePath = path.join(__dirname, "..", "uploads", "claims", fileName);
    fs.unlink(filePath, (err) => {
      if (err) console.error("Could not delete file:", err.message);
    });

    res.json({ success: true, data: claim });
  } catch (error) {
    next(error);
  }
};