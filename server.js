import express from "express";
import connectDB from "./config/db.js";
import cors from "cors";

import authRoutes from "./Routes/authRoutes.js";
import kycRoutes from "./Routes/kycRoutes.js";

const app = express();

connectDB();

app.use(express.json());
app.use(cors());

app.use("/api/auth", authRoutes);
app.use("/api/kyc", kycRoutes);

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
    res.send("WELCOME TO BACKEND API");
});

app.listen(PORT, () => {
    console.log(`Server running on PORT: ${PORT}`);
});