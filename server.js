const express = require("express");
const connectDB = require("./config/db");
const errorMiddleware = require("./middleware/errorMiddleware");
const baseRoute = require("./route/baseRoute");

const app = express();
console.log("BASE API ROUTE LOADED");

app.use(express.json());

const PORT = process.env.PORT || 3000;

app.use("/api", baseRoute);

const damageClaimRoute = require("./route/damageClaimRoute");
app.use("/api/claims", damageClaimRoute);


app.get("/", (req, res) => {
    res.send("WELCOME TO BACKEND API");
});

connectDB();

app.use(errorMiddleware);

app.listen(PORT, () => {
    console.log(`Server running on PORT: ${PORT}`);
});