const express = require("express");
const {
  createClaim,
  getAllClaims,
  getClaimById,
  updateClaimStatus,
  cancelClaim,
} = require("../controller/damageClaimController");

const router = express.Router();

router.post("/", createClaim);
router.get("/", getAllClaims);
router.get("/:id", getClaimById);
router.patch("/:id/status", updateClaimStatus);
router.patch("/:id/cancel", cancelClaim);

module.exports = router;