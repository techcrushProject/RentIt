const express = require("express");
const connectDB = require("./config/db");
const categoryRoute = require("./route/categoryRoute");
const equipmentRoute = require("./route/equipmentRoute");
const errorMiddleware = require("./middleware/errorMiddleware");
const baseRoute = require("./route/baseRoute");
const cors = require("cors");
const authRoutes = require("./Routes/authRoutes.js");


connectDb();

const app = express();

app.use(express.json());
app.use(cors());
app.use("/api/auth", authRoutes);
app.use("/api", baseRoute);

const PORT = process.env.PORT || 3000;


// API ROUTES
app.use("/api/ratings", ratingRoutes);
app.use("/equipment", equipmentRoute);
app.use("/category", categoryRoute);


app.get("/", (req, res) => {
    res.send("WELCOME TO BACKEND API");
});

app.use(errorMiddleware);


app.listen(PORT, () => {
    console.log(`Server running on PORT: ${PORT}`);
});