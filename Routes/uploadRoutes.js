import express from "express";
import { signUpload } from "../Controllers/uploadController.js";
import protect from "../Middleware/authMiddleware.js";
import authorizeRoles from "../Middleware/roleMiddleware.js";

const router = express.Router();

router.post("/sign", protect, authorizeRoles("owner", "admin"), signUpload);

export default router;
