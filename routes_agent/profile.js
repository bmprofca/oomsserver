import express from "express";
import {
    agentProfileExists,
    listAgentProfilesByPhone,
    resolveAgentTokenSession,
} from "../middleware/authAgent.js";

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

        const session = await resolveAgentTokenSession(token);
        if (!session) {
            return res.status(401).json({
                success: false,
                message: "Invalid or expired session",
            });
        }

        const profileExists = await agentProfileExists(session.country_code, session.mobile);
        if (!profileExists) {
            return res.status(404).json({
                success: false,
                message: "Agent profile not found",
            });
        }

        const data = await listAgentProfilesByPhone(session.country_code, session.mobile);

        return res.status(200).json({
            success: true,
            message: "Profile list retrieved successfully",
            data,
        });
    } catch (err) {
        console.error("AGENT PROFILE LIST ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch profile list",
        });
    }
});

export default router;
