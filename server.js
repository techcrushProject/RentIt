import express from "express";
import baseRoute from "./routes/baseRoute.js";
import connectDb from "./config/db.js";
import ratingRoutes from "./routes/ratingRoutes.js";

const app = express();
app.use(express.json());


const PORT = process.env.PORT || 3000;

app.use("/api", baseRoute);

connectDb();
app.get("/", (req, res) => {
    res.send("WELCOME TO BACKEND API")
});


// API ROUTES
app.use("/api/ratings", ratingRoutes);


app.listen(PORT, () => {
    console.log(`Server running on PORT: ${PORT}`);
})