import { checkAdminToken } from "./auth.js";

async function authAdmin(req, res, next) {
    const token = req.headers["token"] || req.headers["Token"] || "";
    const username = req.headers["username"] || req.headers["Username"] || "";

    if (!token || !username) {
        return res.status(401).json({
            success: false,
            message: "Session expired"
        });
    }

    let isValid;
    try {
        isValid = await checkAdminToken(username, token);
    } catch (err) {
        console.error("Admin auth DB unavailable:", err?.code || err?.message || err);
        return res.status(503).json({
            success: false,
            code: "DB_UNAVAILABLE",
            message: "Database temporarily unavailable. Please retry in a moment."
        });
    }

    if (!isValid) {
        return res.status(401).json({
            success: false,
            message: "Session expired"
        });
    }

    next();
}

export { authAdmin };
