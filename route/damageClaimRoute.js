const express = require("express");
const { createClaim, getAllClaims } = require("../controller/damageClaimController");

const router = express.Router();

router.post("/", createClaim);
router.get("/", getAllClaims);

module.exports = router;