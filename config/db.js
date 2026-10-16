import mongoose from "mongoose";
import env from "./env.js";

/** Connect once at startup. Errors propagate so server.js can exit non-zero. */
export default async function connectDB() {
    mongoose.set("strictQuery", true);
    await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 10000 });
    // Never log the URI: it contains the database password.
    console.log("MongoDB connected");
}

export const disconnectDB = () => mongoose.disconnect();
