const DamageClaim = require("../model/damageClaimModel");

exports.createClaim = async (req, res, next) => {
  try {
    const claim = await DamageClaim.create(req.body);
    res.status(201).json({ success: true, data: claim });
  } catch (error) {
    next(error);
  }
};

exports.getAllClaims = async (req, res, next) => {
  try {
    const claims = await DamageClaim.find();
    res.json({ success: true, data: claims });
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