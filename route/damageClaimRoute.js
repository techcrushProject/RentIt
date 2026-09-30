const express = require("express");
const upload = require("../middleware/uploadMiddleware");
const {
  createClaim,
  getAllClaims,
  getClaimById,
  updateClaimStatus,
  cancelClaim,
  uploadClaimImages,
} = require("../controller/damageClaimController");

const router = express.Router();

router.post("/", createClaim);
router.get("/", getAllClaims);
router.get("/:id", getClaimById);
router.patch("/:id/status", updateClaimStatus);
router.patch("/:id/cancel", cancelClaim);
router.post("/:id/images", upload.array("images", 5), uploadClaimImages);

module.exports = router;