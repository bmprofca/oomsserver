import express from 'express';
import pool from '../db.js';
import { updateBroadcastStatusAndCounts } from '../services/smsQueueService.js';

const router = express.Router();

const WEBHOOK_SECRET = "ipvaw1ab0gZy3D3XV9WYn9clYlS2ahgPVOGSj";

function normalizeMobile(mobile) {
    if (!mobile) return "";
    const clean = String(mobile).replace(/\D/g, "");
    return clean.slice(-10); // get last 10 digits
}

router.post('/sms/fast2sms', async (req, res) => {
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

            // Fetch recipients for this requestId to obtain broadcast_id and branch_id
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

                const targetRecipient = recipients.find(r => normalizeMobile(r.recipient_mobile) === normalizeMobile(mobile));
                if (!targetRecipient) continue;

                let dbStatus = "pending";
                let errorMessage = null;

                if (statusStr === "delivered") {
                    dbStatus = "sent";
                } else if (statusStr === "failed") {
                    dbStatus = "failed";
                    errorMessage = statusDesc || "Delivery failed";
                } else {
                    // Other states like Undelivered, Pending, etc.
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

        // Recalculate status and counts for all affected broadcasts
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

