import express from "express";
import { authAdmin } from "../middleware/authAdmin.js";
import {
    getCompanySmsConfigRow,
    serializeCompanySmsConfig,
    upsertCompanySmsConfig,
} from "../helpers/smsCompanyConfig.js";

const router = express.Router();

function actor(req) {
    return String(req.headers["username"] || "").trim() || null;
}

/** GET /admin/sms-company/config — platform Fast2SMS used for OTPs (token masked) */
router.get("/config", authAdmin, async (_req, res) => {
    try {
        const row = await getCompanySmsConfigRow();
        return res.status(200).json({
            success: true,
            message: "OTP SMS config retrieved",
            data: serializeCompanySmsConfig(row),
        });
    } catch (error) {
        console.error("ADMIN SMS COMPANY CONFIG GET ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error?.message || "Failed to load config",
        });
    }
});

/** PUT /admin/sms-company/config */
router.put("/config", authAdmin, async (req, res) => {
    try {
        const data = await upsertCompanySmsConfig(req.body || {}, actor(req));
        return res.status(200).json({
            success: true,
            message: "OTP SMS config saved",
            data,
        });
    } catch (error) {
        console.error("ADMIN SMS COMPANY CONFIG PUT ERROR:", error);
        return res.status(error?.status || 500).json({
            success: false,
            message: error?.message || "Failed to save config",
        });
    }
});

export default router;
