const jwt = require("jsonwebtoken");

const protect = (req, res, next) => {
  const authorization = req.headers.authorization || "";
  const [scheme, token] = authorization.split(" ");
  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ message: "Authentication token is required" });
  }
  if (!process.env.JWT_SECRET) {
    return res.status(500).json({ message: "Authentication is not configured" });
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ message: "Authentication token is invalid or expired" });
  }
};

module.exports = protect;
