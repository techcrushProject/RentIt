import express from "express";
import {
    registerUser,
    loginUser,
    logoutUser,
    getMe,
    updateUserRole,
    createFirstAdmin,
} from "../Controllers/authController.js";
import protect from "../Middleware/authMiddleware.js";
import authorizeRoles from "../Middleware/roleMiddleware.js";

const router = express.Router();

// Rate limiting for these endpoints is applied in app.js.
router.post("/register", registerUser);
router.post("/login", loginUser);
router.post("/logout", protect, logoutUser);

// Needs the X-Setup-Token header; disabled entirely when SETUP_ADMIN_TOKEN is not configured.
router.post("/setup-admin", createFirstAdmin);

router.get("/me", protect, getMe);

router.put("/users/role", protect, authorizeRoles("admin"), updateUserRole);

// Example endpoints that show the role guards.
router.get("/renter-only", protect, authorizeRoles("renter"), (req, res) => {
    res.json({ message: "Welcome renter" });
});

router.get("/owner-only", protect, authorizeRoles("owner"), (req, res) => {
    res.json({ message: "Welcome owner" });
});

router.get("/admin-only", protect, authorizeRoles("admin"), (req, res) => {
    res.json({ message: "Welcome admin" });
});

export default router;
