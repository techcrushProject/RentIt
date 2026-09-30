const express = require("express");
const upload = require("../middleware/uploadMiddleware");
const validateId = require("../middleware/validateId");
const {
  createClaim,
  getAllClaims,
  getClaimById,
  updateClaimStatus,
  cancelClaim,
  uploadClaimImages,
  deleteClaimImage,
} = require("../controller/damageClaimController");

const router = express.Router();
router.param("id", validateId);

router.post("/", createClaim);
router.get("/", getAllClaims);
router.get("/:id", getClaimById);
router.patch("/:id/status", updateClaimStatus);
router.patch("/:id/cancel", cancelClaim);
router.post("/:id/images", upload.array("images", 5), uploadClaimImages);
router.delete("/:id/images/:filename", deleteClaimImage);

module.exports = router;