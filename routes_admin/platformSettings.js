import express from "express";
import { authAdmin } from "../middleware/authAdmin.js";
import {
    describePlatformSettings,
    updatePlatformSettings,
} from "../helpers/platformSettings.js";
import { testB2Connection } from "../helpers/b2Storage.js";
import { testGoogleCalendarConnection } from "../services/googleCalendarService.js";

const router = express.Router();

function actor(req) {
    return String(req.headers["username"] || "").trim() || null;
}

/** GET /admin/platform-settings — grouped settings, secrets masked */
router.get("/", authAdmin, async (_req, res) => {
    try {
        const data = await describePlatformSettings();
        return res.status(200).json({
            success: true,
            message: "Platform settings retrieved",
            data,
        });
    } catch (error) {
        console.error("ADMIN PLATFORM SETTINGS GET ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error?.message || "Failed to load platform settings",
        });
    }
});

/**
 * PUT /admin/platform-settings
 * body: { values: { KEY: value, ... }, clear: ["KEY", ...] }
 * Blank secrets keep their current value; use `clear` to blank one on purpose.
 */
router.put("/", authAdmin, async (req, res) => {
    try {
        const body = req.body || {};
        const payload =
            body.values && typeof body.values === "object"
                ? { values: body.values, clear: body.clear }
                : { values: body, clear: [] };
        const data = await updatePlatformSettings(payload, actor(req));
        return res.status(200).json({
            success: true,
            message: "Platform settings saved",
            data,
        });
    } catch (error) {
        console.error("ADMIN PLATFORM SETTINGS PUT ERROR:", error);
        return res.status(error?.status || 500).json({
            success: false,
            message: error?.message || "Failed to save platform settings",
        });
    }
});

/** POST /admin/platform-settings/test/b2 — authorise with the saved B2 credentials and find the bucket */
router.post("/test/b2", authAdmin, async (_req, res) => {
    try {
        const data = await testB2Connection();
        return res.status(200).json({
            success: true,
            message: `Connected. Bucket "${data.bucket_name}" found.`,
            data,
        });
    } catch (error) {
        const upstream = error?.response?.data?.message || error?.response?.data?.code;
        return res.status(400).json({
            success: false,
            message: upstream ? `B2 test failed: ${upstream}` : error?.message || "B2 test failed",
        });
    }
});

router.post("/test/google-calendar", authAdmin, async (_req, res) => {
    try {
        await testGoogleCalendarConnection();
        return res.status(200).json({
            success: true,
            message: "Google Calendar connection is ready",
            data: { connected: true },
        });
    } catch (error) {
        console.error("ADMIN GOOGLE CALENDAR TEST ERROR:", error?.message || error);
        return res.status(400).json({
            success: false,
            message: error?.message || "Google Calendar connection test failed",
        });
    }
});

export default router;
