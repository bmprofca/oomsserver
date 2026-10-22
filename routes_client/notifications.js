import express from "express";
import pool from "../db.js";
import { validateClientSession } from "../middleware/validateClientSession.js";
import {
    getNotificationPreferences,
    getUnreadCount,
    listNotifications,
    saveNotificationPreference,
    updateNotificationState,
} from "../services/notificationService.js";
import { normalizeNotificationCategory } from "../helpers/notifications.js";

const router = express.Router();

function clientContext(req) {
    return {
        branch_id: req.branch_id,
        recipient_type: "client",
        recipient_id: req.client_username,
    };
}

function sendError(res, error, fallback) {
    const status = Number(error?.status) || 500;
    return res.status(status).json({ success: false, message: error?.message || fallback });
}

router.get("/", validateClientSession, async (req, res) => {
    try {
        const result = await listNotifications({
            ...clientContext(req),
            page: req.query.page,
            limit: req.query.limit,
            include_read: String(req.query.include_read ?? "true") !== "false",
        });
        return res.json({ success: true, data: result.rows, pagination: result.pagination });
    } catch (error) {
        return sendError(res, error, "Failed to fetch notifications");
    }
});

router.get("/unread-count", validateClientSession, async (req, res) => {
    try {
        return res.json({ success: true, data: { unread_count: await getUnreadCount(pool, clientContext(req)) } });
    } catch (error) {
        return sendError(res, error, "Failed to fetch unread notification count");
    }
});

router.post("/read", validateClientSession, async (req, res) => {
    try {
        const notification_ids = Array.isArray(req.body?.notification_ids)
            ? req.body.notification_ids
            : [req.body?.notification_id];
        const updated = await updateNotificationState(pool, {
            ...clientContext(req),
            notification_ids,
            mark_all: req.body?.mark_all === true,
            action: "read",
        });
        return res.json({ success: true, data: { updated } });
    } catch (error) {
        return sendError(res, error, "Failed to mark notifications as read");
    }
});

router.post("/delete", validateClientSession, async (req, res) => {
    try {
        const notification_ids = Array.isArray(req.body?.notification_ids)
            ? req.body.notification_ids
            : [req.body?.notification_id];
        const updated = await updateNotificationState(pool, {
            ...clientContext(req),
            notification_ids,
            mark_all: req.body?.delete_all === true,
            action: "delete",
        });
        return res.json({ success: true, data: { updated } });
    } catch (error) {
        return sendError(res, error, "Failed to delete notifications");
    }
});

router.get("/preferences", validateClientSession, async (req, res) => {
    try {
        return res.json({ success: true, data: await getNotificationPreferences(pool, clientContext(req)) });
    } catch (error) {
        return sendError(res, error, "Failed to fetch notification preferences");
    }
});

router.put("/preferences", validateClientSession, async (req, res) => {
    try {
        const context = clientContext(req);
        await saveNotificationPreference(pool, {
            ...context,
            category: normalizeNotificationCategory(req.body?.category),
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
