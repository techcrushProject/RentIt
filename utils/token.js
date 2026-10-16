import jwt from "jsonwebtoken";
import env from "../config/env.js";

/**
 * `user` must have been loaded with `+tokenVersion` (it is select:false).
 * The role in the token is informational only: Middleware/authMiddleware.js
 * always re-reads the role and tokenVersion from the database.
 */
export const signToken = (user) =>
    jwt.sign(
        { id: String(user._id), role: user.role, tv: user.tokenVersion ?? 0 },
        env.jwtSecret,
        { algorithm: "HS256", expiresIn: env.jwtExpiresIn }
    );

/** Throws on a bad signature, wrong algorithm or expired token. */
export const verifyJwt = (token) => jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] });
