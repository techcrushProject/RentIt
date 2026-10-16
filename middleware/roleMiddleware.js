const authorizeRoles = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: "Authentication is required" });
  if (!roles.includes(req.user.role)) return res.status(403).json({ message: "Access denied" });
  return next();
};

module.exports = authorizeRoles;
