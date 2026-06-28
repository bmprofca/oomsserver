import express from "express";
import {
    caProfileExists,
    listCaProfilesByPhone,
    resolveCaTokenSession,
} from "../middleware/authCa.js";

const router = express.Router();

router.get("/list", async (req, res) => {
    try {
        const token = req.headers["token"] || req.headers["Token"] || "";

        if (!token) {
            return res.status(401).json({
                success: false,
                message: "Session expired",
            });
        }

        const session = await resolveCaTokenSession(token);
        if (!session) {
            return res.status(401).json({
                success: false,
                message: "Invalid or expired session",
            });
        }

        const profileExists = await caProfileExists(session.country_code, session.mobile);
        if (!profileExists) {
            return res.status(404).json({
                success: false,
                message: "CA profile not found",
            });
        }

        const data = await listCaProfilesByPhone(session.country_code, session.mobile);

        return res.status(200).json({
            success: true,
            message: "Profile list retrieved successfully",
            data,
        });
    } catch (err) {
        console.error("CA PROFILE LIST ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch profile list",
        });
    }
});

export default router;
