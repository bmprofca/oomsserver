import express from "express";
import { verifyRazorpayWebhookSignature } from "../services/razorpayService.js";
import { handleRazorpayWebhookPayload } from "../services/razorpayWebhookService.js";

const router = express.Router();

/**
 * POST /api/v1/webhook/razorpay
 * Razorpay payment webhook (subscriptions + wallet top-ups).
 * Configure in Razorpay Dashboard with events: payment.captured, order.paid, payment.failed
 */
router.post("/razorpay", async (req, res) => {
    try {
        const signature = req.headers["x-razorpay-signature"];
        const rawBody =
            req.rawBody?.toString("utf8") ||
            (typeof req.body === "string" ? req.body : JSON.stringify(req.body || {}));

        if (!verifyRazorpayWebhookSignature({ rawBody, signature })) {
            console.error("Razorpay webhook signature verification failed.");
            return res.status(400).json({ success: false, message: "Invalid signature" });
        }

        const payload = typeof req.body === "object" && req.body !== null && !Buffer.isBuffer(req.body)
            ? req.body
            : JSON.parse(rawBody);

        console.log("Razorpay webhook received:", payload?.event);
        const result = await handleRazorpayWebhookPayload(payload);
        return res.status(200).json({ success: true, status: "ok", ...result });
    } catch (error) {
        console.error("Razorpay webhook error:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Webhook processing failed",
        });
    }
});

export default router;
