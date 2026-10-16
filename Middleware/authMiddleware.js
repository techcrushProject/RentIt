import User from "../Models/user.js";
import { verifyJwt } from "../utils/token.js";

const NO_TOKEN = "Not authorized, no token";
const INVALID_TOKEN = "Not authorized, invalid token";

const OBJECT_ID_RE = /^[a-f\d]{24}$/i;

/** Only "Authorization: Bearer <token>" is accepted: two parts, any-case scheme. */
function bearerToken(header) {
    if (typeof header !== "string") return null;
    const parts = header.split(" ");
    if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer" || parts[1] === "") return null;
    return parts[1];
}

/**
 * The token only says who the caller claims to be. Role and revocation state
 * always come from the database, so a demoted, deleted or logged-out user
 * loses access immediately instead of when the token expires.
 * Resolves to { user } or { error } (the 401 message).
 */
async function authenticate(req) {
    const token = bearerToken(req.headers?.authorization);
    if (!token) return { error: NO_TOKEN };

    let payload;
    try {
        payload = verifyJwt(token);
    } catch {
        return { error: INVALID_TOKEN };
    }

    // A validly signed token can still carry junk; an unchecked id would make findById throw a CastError (500).
    if (typeof payload?.id !== "string" || !OBJECT_ID_RE.test(payload.id)) return { error: INVALID_TOKEN };

    const user = await User.findById(payload.id).select("+tokenVersion");
    if (!user || payload.tv !== (user.tokenVersion ?? 0)) return { error: INVALID_TOKEN };

    return {
        user: {
            id: String(user._id),
            role: user.role,
            name: user.name,
            email: user.email,
            kycStatus: user.kycStatus,
            isVerified: user.isVerified,
        },
    };
}

const protect = async (req, res, next) => {
    const { user, error } = await authenticate(req);
    if (error) return res.status(401).json({ message: error });
    req.user = user;
    return next();
};

/** For public routes that behave differently for signed-in users. A bad token is treated as anonymous. */
export const optionalAuth = async (req, res, next) => {
    const { user } = await authenticate(req);
    if (user) req.user = user;
    return next();
};

export const verifyToken = protect;
export default protect;
