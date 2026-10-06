import "dotenv/config";
import express from "express";
import connectDB from "./config/db.js";
import testEquipmentRoutes from "./routes/testEquipmentRoutes.js";
import availabilityRoutes from "./routes/availabilityRoutes.js";
import bookingRoutes from "./routes/bookingRoutes.js";

const app = express();
app.use(express.json());



const PORT = process.env.PORT || 3000;

//HOME ROUTE

app.get("/", (req, res) => {
    res.send("WELCOME TO BACKEND API")
});


// API ROUTES

app.use("/api/test/equipment", testEquipmentRoutes);

app.use("/api/equipment", availabilityRoutes);

app.use("/api/bookings", bookingRoutes);

//START SERVER

const startServer = async () => {
    try {
        await connectDB();

        app.listen(PORT, () => {
            console.log(`Server is running on http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error("Failed to start server:", error.message);
    }
};

startServer();