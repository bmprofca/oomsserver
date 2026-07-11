import express from "express";
import pool from "../db.js";
import { updateBroadcastStatusAndCounts } from "../services/smsQueueService.js";
import { verifyRazorpayWebhookSignature } from "../services/razorpayService.js";
import { handleRazorpayWebhookPayload } from "../services/razorpayWebhookService.js";

const router = express.Router();

const WEBHOOK_SECRET = "ipvaw1ab0gZy3D3XV9WYn9clYlS2ahgPVOGSj";

function normalizeMobile(mobile) {
    if (!mobile) return "";
    const clean = String(mobile).replace(/\D/g, "");
    return clean.slice(-10);
}

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

router.post("/sms/fast2sms", async (req, res) => {
    try {
        const providedSecret = req.headers["x-webhook-secret"] || req.headers["authorization"] || req.query.secret || req.query.secret_key;
        if (providedSecret !== WEBHOOK_SECRET && providedSecret !== "ipvaw1ab0gZy3D3XV9WYn9clYlS2ah") {
            return res.status(401).json({ success: false, message: "Unauthorized webhook request" });
        }

        const payload = req.body || {};
        const smsReports = payload.sms_reports || [];
        const updatedBroadcasts = new Set();

        for (const report of smsReports) {
            const requestId = report.request_id;
            if (!requestId) continue;

            const deliveryStatuses = report.delivery_status || [];
            if (!deliveryStatuses.length) continue;

            const [recipients] = await pool.query(
                "SELECT recipient_id, branch_id, broadcast_id, recipient_mobile FROM sms_broadcast_recipients WHERE provider_message_id = ?",
                [requestId]
            );

            if (!recipients.length) continue;

            const branchId = recipients[0].branch_id;
            const broadcastId = recipients[0].broadcast_id;
            updatedBroadcasts.add(JSON.stringify({ branchId, broadcastId }));

            for (const statusItem of deliveryStatuses) {
                const mobile = statusItem.mobile;
                const statusStr = String(statusItem.status).toLowerCase();
                const statusDesc = statusItem.status_description || "";

                const targetRecipient = recipients.find((r) => normalizeMobile(r.recipient_mobile) === normalizeMobile(mobile));
                if (!targetRecipient) continue;

                let dbStatus = "pending";
                let errorMessage = null;

                if (statusStr === "delivered") {
                    dbStatus = "sent";
                } else if (statusStr === "failed") {
                    dbStatus = "failed";
                    errorMessage = statusDesc || "Delivery failed";
                } else {
                    continue;
                }

                const sentAt = statusItem.delivery_timestamp
                    ? new Date(statusItem.delivery_timestamp * 1000)
                    : new Date();

                await pool.query(
                    `UPDATE sms_broadcast_recipients
                     SET status = ?, error_message = ?, sent_at = ?, modify_date = NOW()
                     WHERE recipient_id = ?`,
                    [dbStatus, errorMessage, sentAt, targetRecipient.recipient_id]
                );
            }
        }

        for (const broadcastInfoStr of updatedBroadcasts) {
            const { branchId, broadcastId } = JSON.parse(broadcastInfoStr);
            await updateBroadcastStatusAndCounts(broadcastId, branchId);
        }

        return res.json({ success: true, message: "Webhook processed successfully" });
    } catch (error) {
        console.error("Fast2SMS webhook error:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

export default router;
