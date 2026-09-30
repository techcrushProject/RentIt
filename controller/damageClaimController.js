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