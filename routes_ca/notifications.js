import express from "express";
import pool from "../db.js";
import { validateCaSession } from "../middleware/validateCaSession.js";
import {
    getNotificationPreferences,
    getUnreadCount,
    listNotifications,
    saveNotificationPreference,
    updateNotificationState,
} from "../services/notificationService.js";
import { normalizeNotificationCategory } from "../helpers/notifications.js";

const router = express.Router();

function caContext(req) {
    return { branch_id: req.branch_id, recipient_type: "ca", recipient_id: req.ca_username };
}

function fail(res, error, message) {
    return res.status(Number(error?.status) || 500).json({ success: false, message: error?.message || message });
}

router.get("/", validateCaSession, async (req, res) => {
    try {
        const result = await listNotifications({ ...caContext(req), page: req.query.page, limit: req.query.limit, include_read: String(req.query.include_read ?? "true") !== "false" });
        return res.json({ success: true, data: result.rows, pagination: result.pagination });
    } catch (error) { return fail(res, error, "Failed to fetch CA notifications"); }
});

router.get("/unread-count", validateCaSession, async (req, res) => {
    try { return res.json({ success: true, data: { unread_count: await getUnreadCount(pool, caContext(req)) } }); }
    catch (error) { return fail(res, error, "Failed to fetch CA notification count"); }
});

async function changeState(req, res, action) {
    try {
        const ids = Array.isArray(req.body?.notification_ids) ? req.body.notification_ids : [req.body?.notification_id];
        const updated = await updateNotificationState(pool, { ...caContext(req), notification_ids: ids, mark_all: action === "read" ? req.body?.mark_all === true : req.body?.delete_all === true, action });
        return res.json({ success: true, data: { updated } });
    } catch (error) { return fail(res, error, `Failed to ${action} CA notifications`); }
}

router.post("/read", validateCaSession, (req, res) => changeState(req, res, "read"));
router.post("/delete", validateCaSession, (req, res) => changeState(req, res, "delete"));

router.get("/preferences", validateCaSession, async (req, res) => {
    try { return res.json({ success: true, data: await getNotificationPreferences(pool, caContext(req)) }); }
    catch (error) { return fail(res, error, "Failed to fetch CA notification preferences"); }
});

router.put("/preferences", validateCaSession, async (req, res) => {
    try {
        const context = caContext(req);
        await saveNotificationPreference(pool, { ...context, category: normalizeNotificationCategory(req.body?.category), in_app_enabled: req.body?.in_app_enabled !== false, push_enabled: req.body?.push_enabled !== false, email_enabled: req.body?.email_enabled !== false, sms_enabled: req.body?.sms_enabled === true, modify_by: context.recipient_id });
        return res.json({ success: true, data: await getNotificationPreferences(pool, context) });
    } catch (error) { return fail(res, error, "Failed to save CA notification preference"); }
});

export default router;
