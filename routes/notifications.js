import express from "express";
import pool from "../db.js";
import { auth, checkSubscription, requireFeature, validateBranch } from "../middleware/auth.js";
import {
    getNotificationPreferences,
    getUnreadCount,
    listNotifications,
    resolveRecipientType,
    saveNotificationPreference,
    updateNotificationState,
} from "../services/notificationService.js";
import { normalizeNotificationCategory } from "../helpers/notifications.js";

const router = express.Router();
const coreAccess = [auth, validateBranch, checkSubscription, requireFeature("core")];

function usernameFromRequest(req) {
    return String(req.headers.username || req.headers.Username || "").trim();
}

async function recipientContext(req) {
    const recipient_id = usernameFromRequest(req);
    if (!recipient_id) throw Object.assign(new Error("Username is required"), { status: 400 });
    const recipient_type = await resolveRecipientType(pool, req.branch_id, recipient_id);
    return { branch_id: req.branch_id, recipient_type, recipient_id };
}

function sendError(res, error, fallback) {
    const status = Number(error?.status) || 500;
    return res.status(status).json({ success: false, message: error?.message || fallback });
}

router.get("/", ...coreAccess, async (req, res) => {
    try {
        const context = await recipientContext(req);
        const result = await listNotifications({
            ...context,
            page: req.query.page,
            limit: req.query.limit,
            include_read: String(req.query.include_read ?? "true") !== "false",
        });
        return res.json({ success: true, data: result.rows, pagination: result.pagination });
    } catch (error) {
        return sendError(res, error, "Failed to fetch notifications");
    }
});

router.get("/unread-count", ...coreAccess, async (req, res) => {
    try {
        const context = await recipientContext(req);
        const count = await getUnreadCount(pool, context);
        return res.json({ success: true, data: { unread_count: count } });
    } catch (error) {
        return sendError(res, error, "Failed to fetch unread notification count");
    }
});

router.post("/read", ...coreAccess, async (req, res) => {
    try {
        const context = await recipientContext(req);
        const notification_ids = Array.isArray(req.body?.notification_ids)
            ? req.body.notification_ids
            : [req.body?.notification_id];
        const updated = await updateNotificationState(pool, {
            ...context,
            notification_ids,
            mark_all: req.body?.mark_all === true,
            action: "read",
        });
        return res.json({ success: true, data: { updated } });
    } catch (error) {
        return sendError(res, error, "Failed to mark notifications as read");
    }
});

router.post("/delete", ...coreAccess, async (req, res) => {
    try {
        const context = await recipientContext(req);
        const notification_ids = Array.isArray(req.body?.notification_ids)
            ? req.body.notification_ids
            : [req.body?.notification_id];
        const updated = await updateNotificationState(pool, {
            ...context,
            notification_ids,
            mark_all: req.body?.delete_all === true,
            action: "delete",
        });
        return res.json({ success: true, data: { updated } });
    } catch (error) {
        return sendError(res, error, "Failed to delete notifications");
    }
});

router.get("/preferences", ...coreAccess, async (req, res) => {
    try {
        const context = await recipientContext(req);
        return res.json({ success: true, data: await getNotificationPreferences(pool, context) });
    } catch (error) {
        return sendError(res, error, "Failed to fetch notification preferences");
    }
});

router.put("/preferences", ...coreAccess, async (req, res) => {
    try {
        const context = await recipientContext(req);
        const category = normalizeNotificationCategory(req.body?.category);
        await saveNotificationPreference(pool, {
            ...context,
            category,
            in_app_enabled: req.body?.in_app_enabled !== false,
            push_enabled: req.body?.push_enabled !== false,
            email_enabled: req.body?.email_enabled !== false,
            sms_enabled: req.body?.sms_enabled === true,
            modify_by: context.recipient_id,
        });
        return res.json({ success: true, data: await getNotificationPreferences(pool, context) });
    } catch (error) {
        return sendError(res, error, "Failed to save notification preference");
    }
});

export default router;
