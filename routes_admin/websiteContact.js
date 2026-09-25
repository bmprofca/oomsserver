import express from "express";
import { authAdmin } from "../middleware/authAdmin.js";
import {
    getWebsiteContactConfigRow,
    serializeWebsiteContactConfig,
    upsertWebsiteContactConfig,
} from "../helpers/websiteContactConfig.js";

const router = express.Router();

function actor(req) {
    return String(req.headers["username"] || "").trim() || null;
}

/** GET /admin/website-contact/config */
router.get("/config", authAdmin, async (_req, res) => {
    try {
        const row = await getWebsiteContactConfigRow();
        return res.status(200).json({
            success: true,
            message: "Website contact config retrieved",
            data: serializeWebsiteContactConfig(row),
        });
    } catch (error) {
        console.error("ADMIN WEBSITE CONTACT CONFIG GET ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error?.message || "Failed to load config",
        });
    }
});

/** PUT /admin/website-contact/config */
router.put("/config", authAdmin, async (req, res) => {
    try {
        const data = await upsertWebsiteContactConfig(req.body || {}, actor(req));
        return res.status(200).json({
            success: true,
            message: "Website contact config saved",
            data,
        });
    } catch (error) {
        console.error("ADMIN WEBSITE CONTACT CONFIG PUT ERROR:", error);
        const status = error?.status || 500;
        return res.status(status).json({
            success: false,
            message: error?.message || "Failed to save config",
        });
    }
});

export default router;
