import express from "express";

const baseRoute = express.Router();

baseRoute.get("/", (req, res) => {
    res.status(200).json({
        success: true,
        message: "RentIt API is running"
    });
});

baseRoute.get("/error-test", (req, res, next) => {
    const error = new Error("This is a test error");
    next(error);
});

export default baseRoute;
