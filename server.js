
const express = require("express");
const connectDB = require("./config/db");
const categoryRoute = require("./route/categoryRoute");
const equipmentRoute = require("./route/equipmentRoute");
const errorMiddleware = require("./middleware/errorMiddleware");
const baseRoute = require("./route/baseRoute");

connectDb();

const app = express();
console.log("BASE API ROUTE LOADED");

app.use(express.json());

const PORT = process.env.PORT || 3000;

app.use("/api", baseRoute);


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