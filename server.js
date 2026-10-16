// Imported first so a bad configuration stops the process with a clear message.
import env from "./config/env.js";
import connectDB, { disconnectDB } from "./config/db.js";
import { createApp } from "./app.js";

const redactUri = (text) => String(text).replaceAll(env.mongoUri, "[MONGO_URI]");

try {
    await connectDB();
} catch (err) {
    console.error(`Could not connect to MongoDB: ${redactUri(err.message)}`);
    process.exit(1);
}

const server = createApp().listen(env.port, () => {
    console.log(`Server running on port ${env.port} (${env.nodeEnv})`);
});

server.on("error", (err) => {
    console.error(`Server error: ${err.message}`);
    process.exit(1);
});

let shuttingDown = false;

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);

    // Do not hang forever on a stuck connection; the timer must not keep the process alive by itself.
    setTimeout(() => {
        console.error("Shutdown timed out, forcing exit");
        process.exit(1);
    }, 10_000).unref();

    try {
        await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
        await disconnectDB();
        process.exit(0);
    } catch (err) {
        console.error(`Error during shutdown: ${err.message}`);
        process.exit(1);
    }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection:", reason instanceof Error ? reason.stack : String(reason));
    process.exit(1);
});
