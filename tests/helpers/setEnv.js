// Import this FIRST in every test file: config/env.js validates the
// environment at import time, so the variables must exist before any app module loads.
process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "test-secret-test-secret-test-secret-0123456789";
process.env.MONGO_URI ||= "mongodb://127.0.0.1:27018/rentit_test";
process.env.SETUP_ADMIN_TOKEN ||= "test-setup-token-0123456789abcdef";
process.env.CORS_ORIGINS ||= "http://localhost:5500";
