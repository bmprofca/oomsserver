import { checkToken } from "./auth.js";

async function authAdmin(req, res, next) {
    const token = req.headers["token"] || req.headers["Token"] || "";
    const username = req.headers["username"] || req.headers["Username"] || "";

    if (!token || !username) {
        return res.status(401).json({
            success: false,
            message: "Session expired"
        });
    }

    const isValid = await checkToken(username, token, "admin");

    if (!isValid) {
        return res.status(401).json({
            success: false,
            message: "Session expired"
        });
    }

    next();
}

export { authAdmin };
