import bcrypt from "bcrypt";
import crypto from "node:crypto";
import env from "../config/env.js";
import Setting from "../Models/setting.js";
import User from "../Models/user.js";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../utils/httpError.js";
import { signToken } from "../utils/token.js";
import * as validate from "../utils/validate.js";

const BCRYPT_COST = 12;

// Valid cost-12 hash of a throwaway string. Comparing against it when the email is unknown
// makes that request take as long as a real one, so timing does not reveal registered emails.
const DUMMY_HASH = "$2b$12$0Sn4orRjxtLpvtKq.TPeTubbWORxZ/gd0x1KSmXxPcGD/swMTcgGm";

const ADMIN_MARKER_KEY = "adminBootstrap";
const DUPLICATE_KEY = 11000;

const bodyOf = (req) => (req.body !== null && typeof req.body === "object" ? req.body : {});

const sha256 = (value) => crypto.createHash("sha256").update(value).digest();

const publicUser = (user) => ({
    id: user._id,
    name: user.name,
    firstName: user.firstName,
    lastName: user.lastName,
    businessName: user.businessName,
    email: user.email,
    phone: user.phone,
    role: user.role,
});

const emailTaken = () => conflict("An account with this email already exists");

const registerUser = async (req, res) => {
    const body = bodyOf(req);
    const name = validate.str(body.name, { field: "name", min: 2, max: 100, required: true });
    const firstName = validate.str(body.firstName, { field: "firstName", max: 50 });
    const lastName = validate.str(body.lastName, { field: "lastName", max: 50 });
    const businessName = validate.str(body.businessName, { field: "businessName", max: 100 });
    const phone = validate.phone(body.phone);
    const email = validate.email(body.email);
    const password = validate.password(body.password);
    // Admins are never self-registered; see updateUserRole and createFirstAdmin.
    const role = validate.oneOf(body.role ?? "renter", ["renter", "owner"], "role");

    if (await User.exists({ email })) throw emailTaken();

    const hashedPassword = await bcrypt.hash(password, BCRYPT_COST);

    try {
        await User.create({
            name,
            firstName: firstName || undefined,
            lastName: lastName || undefined,
            businessName: businessName || undefined,
            email,
            password: hashedPassword,
            role,
            phone: phone || undefined,
        });
    } catch (error) {
        // Two simultaneous sign-ups can both pass the lookup above; the unique index decides.
        if (error?.code === DUPLICATE_KEY) throw emailTaken();
        throw error;
    }

    return res.status(201).json({ message: "User registered successfully" });
};

const loginUser = async (req, res) => {
    const body = bodyOf(req);
    const email = validate.email(body.email);

    // The registration policy is deliberately not applied here: it must not lock out older accounts.
    const password = body.password;
    if (typeof password !== "string" || password.length === 0) throw badRequest("password is required");
    if (Buffer.byteLength(password, "utf8") > 72) throw badRequest("Password must be at most 72 bytes");

    const user = await User.findOne({ email }).select("+password +tokenVersion");

    const passwordMatches = await bcrypt.compare(password, user ? user.password : DUMMY_HASH);
    if (!user || !passwordMatches) throw unauthorized("Invalid email or password");

    await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

    return res.status(200).json({
        message: "Login successful",
        token: signToken(user),
        user: publicUser(user),
    });
};

/** Bumping tokenVersion revokes every token this user has been issued, on all devices. */
const logoutUser = async (req, res) => {
    await User.updateOne({ _id: req.user.id }, { $inc: { tokenVersion: 1 } });
    return res.status(200).json({ message: "Logged out" });
};

const getMe = async (req, res) => {
    const user = await User.findById(req.user.id);
    // The account can vanish between the auth middleware and this read.
    if (!user) throw unauthorized("Not authorized, invalid token");

    return res.status(200).json({
        user: { ...publicUser(user), kycStatus: user.kycStatus, isVerified: user.isVerified },
    });
};

const updateUserRole = async (req, res) => {
    const body = bodyOf(req);
    const userId = validate.objectId(body.userId, "userId");
    const role = validate.oneOf(body.role, ["renter", "owner", "admin"], "role");

    const target = await User.findById(userId);
    if (!target) throw notFound("User not found");

    if (String(target._id) === req.user.id) throw badRequest("You cannot change your own role");

    // Backstop so the system can never end up without an admin (e.g. two admins demoting each other).
    if (target.role === "admin" && role !== "admin" && (await User.countDocuments({ role: "admin" })) <= 1) {
        throw conflict("Cannot demote the last remaining admin");
    }

    // The role bump also revokes the target's old tokens, which still carry the previous tokenVersion.
    await User.updateOne({ _id: target._id }, { $set: { role }, $inc: { tokenVersion: 1 } });

    // The count above and this update are not atomic: two admins demoting each other at the same
    // moment would both pass it. Re-check afterwards and undo a demotion that left no admin at all.
    if (target.role === "admin" && role !== "admin" && (await User.countDocuments({ role: "admin" })) === 0) {
        await User.updateOne({ _id: target._id }, { $set: { role: "admin" } });
        throw conflict("Cannot demote the last remaining admin");
    }

    return res.status(200).json({
        message: "User role updated successfully",
        user: { id: target._id, name: target.name, email: target.email, role },
    });
};

/**
 * One-time bootstrap of the first admin. Disabled unless SETUP_ADMIN_TOKEN is configured, so a
 * fresh deployment cannot be taken over by whoever finds the endpoint first.
 */
const createFirstAdmin = async (req, res) => {
    if (!env.setupAdminToken) throw notFound();

    // Hashing both sides gives equal-length buffers, which timingSafeEqual requires, and leaks no length.
    const supplied = req.headers?.["x-setup-token"];
    const tokenMatches = crypto.timingSafeEqual(
        sha256(typeof supplied === "string" ? supplied : ""),
        sha256(env.setupAdminToken)
    );
    if (!tokenMatches) throw forbidden("Invalid setup token");

    const body = bodyOf(req);
    const name = validate.str(body.name, { field: "name", min: 2, max: 100, required: true });
    const email = validate.email(body.email);
    const password = validate.password(body.password);

    if (await User.exists({ role: "admin" })) throw conflict("An admin already exists");

    const hashedPassword = await bcrypt.hash(password, BCRYPT_COST);

    // The check above is not atomic. The unique key on this marker lets exactly one concurrent request through.
    const completed = () => conflict("Admin setup already completed");
    let claim;
    try {
        claim = await Setting.updateOne(
            { key: ADMIN_MARKER_KEY },
            { $setOnInsert: { value: { claimedAt: new Date() } } },
            { upsert: true }
        );
    } catch (error) {
        if (error?.code === DUPLICATE_KEY) throw completed();
        throw error;
    }
    if (claim.upsertedCount === 0) throw completed();

    let admin;
    try {
        admin = await User.create({ name, email, password: hashedPassword, role: "admin" });
    } catch (error) {
        // Release the claim so the operator can retry after fixing the cause.
        await Setting.deleteOne({ key: ADMIN_MARKER_KEY });
        if (error?.code === DUPLICATE_KEY) throw emailTaken();
        throw error;
    }

    return res.status(201).json({
        message: "First admin created successfully",
        user: { id: admin._id, name: admin.name, email: admin.email, role: admin.role },
    });
};

export { registerUser, loginUser, logoutUser, getMe, updateUserRole, createFirstAdmin };
