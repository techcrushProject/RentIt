const express = require("express");

const router = express.Router();

router.get("/", (req, res) => {
    res.status(200).json({
        success: true,
        message: "RentIt API is running"
    });
});

router.get("/error-test", (req, res, next) => {
    const error = new Error("This is a test error");
    next(error);
});

module.exports = router;