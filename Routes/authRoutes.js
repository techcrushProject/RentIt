import express from "express";
import {registerUser, loginUser, updateUserRole, createFirstAdmin} from "../Controllers/authController.js";
import protect from "../Middleware/authMiddleware.js";
import authorizeRoles from "../Middleware/roleMiddleware.js";

const router = express.Router();

//signup
router.post("/register", registerUser);

//login
router.post("/login", loginUser);

//create first Admin
router.post("/setup-admin", createFirstAdmin);

//Get logged-in user
router.get("/me", protect, (req, res) => {
    res.status(200).json({
        user: req.user
    });
});

//Admin changes user's role
router.put(
    "/users/role",
    protect,
    authorizeRoles("admin"),
    updateUserRole
);

//Renter-only
router.get("/renter-only", protect, authorizeRoles("renter"), (req, res) => {
    res.json({
        message: "Welcome renter"
    });
});

//Owner
router.get("/owner-only", protect, authorizeRoles("owner"), (req, res) => {
    res.json({
        message: "Welcome owner"
    });
});

//Admin
router.get("/admin-only", protect, authorizeRoles("admin"), (req, res) => {
    res.json({
        message: "Welcome admin"
    });
});

export default router;