import express from "express";
import connectDB from "./config/db.js";

import cors from "cors";

import authRoutes from "./Routes/authRoutes.js";
import adminRoutes from "./Routes/adminRoutes.js";
import kycRoutes from "./Routes/kycRoutes.js";
import equipmentRoutes from "./Routes/equipmentRoutes.js";

const app = express();

connectDB();

app.use(express.json({ limit: "15mb" }));
app.use(cors());
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/kyc", kycRoutes);
app.use("/api/equipment", equipmentRoutes);



const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
    res.send("WELCOME TO BACKEND API")
});




app.listen(PORT, () => {
    console.log(`Server running on PORT: ${PORT}`);
})