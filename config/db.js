import mongoose from "mongoose";

const connectDB = async() => {
    const MONGO_URL = "mongodb://localhost:27017/"

    try {
        await mongoose.connect(MONGO_URL);
        console.log("Database connection successful")
    } catch (error) {
        console.error("Database Connection has failed, ");
        process.exit();
    }
};

export default connectDB;