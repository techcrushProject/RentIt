const mongoose = require("mongoose");

module.exports = (req, res, next, id) => {
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: "Invalid claim ID" });
  }
  next();
};