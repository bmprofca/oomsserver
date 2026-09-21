import express from "express";
import { authAdmin } from "../middleware/authAdmin.js";
import {
    getRazorpayConfigRow,
    serializeRazorpayConfig,
    upsertRazorpayConfig,
    defaultRazorpayWebhookUrl,
} from "../helpers/razorpayConfig.js";
import {
    invalidateRazorpayServiceCache,
    testRazorpayCredentials,
} from "../services/razorpayService.js";

const router = express.Router();

function actor(req) {
    return String(req.headers["username"] || "").trim() || null;
}

/** GET /admin/razorpay/config */
router.get("/config", authAdmin, async (_req, res) => {
    try {
        const row = await getRazorpayConfigRow();
        return res.status(200).json({
            success: true,
            message: "Razorpay config retrieved",
            data: {
                ...serializeRazorpayConfig(row),
                default_webhook_url: defaultRazorpayWebhookUrl(),
            },
        });
    } catch (error) {
        console.error("ADMIN RAZORPAY CONFIG GET ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error?.message || "Failed to load Razorpay config",
        });
    }
});

/** PUT /admin/razorpay/config */
router.put("/config", authAdmin, async (req, res) => {
    try {
        const data = await upsertRazorpayConfig(req.body || {}, actor(req));
        invalidateRazorpayServiceCache();
        return res.status(200).json({
            success: true,
            message: "Razorpay config saved",
            data,
        });
    } catch (error) {
        console.error("ADMIN RAZORPAY CONFIG PUT ERROR:", error);
        const status = error?.status || 500;
        return res.status(status).json({
            success: false,
            message: error?.message || "Failed to save Razorpay config",
        });
    }
});

/** POST /admin/razorpay/test — validate currently configured credentials against Razorpay API */
router.post("/test", authAdmin, async (_req, res) => {
    try {
        invalidateRazorpayServiceCache();
        const result = await testRazorpayCredentials();
        return res.status(result.ok ? 200 : 400).json({
            success: result.ok,
            message: result.message,
            data: result,
        });
    } catch (error) {
        console.error("ADMIN RAZORPAY TEST ERROR:", error);
        return res.status(error.statusCode || 500).json({
            success: false,
            message: error?.message || "Razorpay credential test failed",
        });
    }
});

export default router;
