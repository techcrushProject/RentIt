/** Must run after the auth middleware: it trusts req.user.role, which is loaded from the database. */
const authorizeRoles = (...roles) => (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    if (!roles.includes(req.user.role)) {
        return res.status(403).json({ message: "Access denied" });
    }

    return next();
};

export default authorizeRoles;
