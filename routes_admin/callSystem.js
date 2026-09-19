import express from "express";
import { authAdmin } from "../middleware/authAdmin.js";
import {
    getCallSystemConfigRow,
    serializeCallSystemConfig,
    upsertCallSystemConfig,
} from "../helpers/callSystemConfig.js";

const router = express.Router();

function actor(req) {
    return String(req.headers["username"] || "").trim() || null;
}

/** GET /admin/call-system/config */
router.get("/config", authAdmin, async (_req, res) => {
    try {
        const row = await getCallSystemConfigRow();
        return res.status(200).json({
            success: true,
            message: "Call system config retrieved",
            data: serializeCallSystemConfig(row),
        });
    } catch (error) {
        console.error("ADMIN CALL SYSTEM CONFIG GET ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error?.message || "Failed to load config",
        });
    }
});

/** PUT /admin/call-system/config */
router.put("/config", authAdmin, async (req, res) => {
    try {
        const data = await upsertCallSystemConfig(req.body || {}, actor(req));
        return res.status(200).json({
            success: true,
            message: "Call system config saved",
            data,
        });
    } catch (error) {
        console.error("ADMIN CALL SYSTEM CONFIG PUT ERROR:", error);
        const status = error?.status || 500;
        return res.status(status).json({
            success: false,
            message: error?.message || "Failed to save config",
        });
    }
});

export default router;
