const express = require("express");
const {
  createClaim,
  getAllClaims,
  getClaimById,
  updateClaimStatus,
} = require("../controller/damageClaimController");

const router = express.Router();

router.post("/", createClaim);
router.get("/", getAllClaims);
router.get("/:id", getClaimById);
router.patch("/:id/status", updateClaimStatus);

module.exports = router;
