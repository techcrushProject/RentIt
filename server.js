import { createRequire } from "module";
const require = createRequire(import.meta.url);
const paymentRoutes = require("./payments/payments/index.js");
import express from "express";
import connectDB from "./config/db.js";

import cors from "cors";

import authRoutes from "./Routes/authRoutes.js";
import protect from "./Middleware/authMiddleware.js";
const paymentModule = require("./payments/payments/index.js");
const paymentRouter = paymentModule.createPaymentsRouter({ protect });




const app = express();

connectDB();

app.use(express.json());
app.use(cors());
app.use("/api/auth", authRoutes);
app.use("/api/payments", paymentRouter);





const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
    res.send("WELCOME TO BACKEND API")
});





app.listen(PORT, () => {
    console.log(`Server running on PORT: ${PORT}`);
})