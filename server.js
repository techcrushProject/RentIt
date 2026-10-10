import express from "express";
import connectDB from "./config/db.js";

import cors from "cors";

import authRoutes from "./Routes/authRoutes.js";
import protect from "./Middleware/authMiddleware.js";
import paymentModule from "./payments/index.js";
const { createPaymentsRouter } = paymentModule;

const app = express();

connectDB();

app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(cors());
app.use("/api/auth", authRoutes);
app.use("/api", createPaymentsRouter({ protect }));



const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
    res.send("WELCOME TO BACKEND API")
});




app.listen(PORT, () => {
    console.log(`Server running on PORT: ${PORT}`);
})