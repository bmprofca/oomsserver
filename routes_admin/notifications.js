import express from "express";
import pool from "../db.js";
import { authAdmin } from "../middleware/authAdmin.js";
import { normalizeNotificationCategory } from "../helpers/notifications.js";

const router = express.Router();
const PLATFORM_BRANCH = "__platform__";

function adminId(req) {
    return String(req.headers.username || req.headers.Username || "").trim();
}

function parseRow(row) {
    return {
        ...row,
        data: row.data_json && typeof row.data_json === "object" ? row.data_json : row.data_json ? JSON.parse(row.data_json) : {},
        is_read: Boolean(row.read_at),
    };
}

async function listForAdmin(req) {
    const id = adminId(req);
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const offset = (page - 1) * limit;
    let where = "recipient_type = 'platform_admin' AND recipient_id = ? AND deleted_at IS NULL";
    const params = [id];
    if (String(req.query.include_read ?? "true") === "false") where += " AND read_at IS NULL";
    const [rows] = await pool.query(
        `SELECT notification_id, event_key, category, title, body, data_json,
                delivery_status, read_at, expires_at, actor_username, create_date
         FROM notifications
         WHERE ${where} AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
         ORDER BY create_date DESC, id DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
    );
    const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM notifications WHERE ${where}`, params);
    return { rows: rows.map(parseRow), pagination: { page, limit, total: Number(countRows?.[0]?.total || 0) } };
}

router.get("/", authAdmin, async (req, res) => {
    try {
        const result = await listForAdmin(req);
        return res.json({ success: true, data: result.rows, pagination: result.pagination });
    } catch (error) {
        console.error("ADMIN NOTIFICATIONS LIST ERROR:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch admin notifications" });
    }
});

router.get("/unread-count", authAdmin, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT COUNT(*) AS total FROM notifications
             WHERE recipient_type = 'platform_admin' AND recipient_id = ?
               AND read_at IS NULL AND deleted_at IS NULL
               AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)`,
            [adminId(req)]
        );
        return res.json({ success: true, data: { unread_count: Number(rows?.[0]?.total || 0) } });
    } catch (error) {
        console.error("ADMIN NOTIFICATIONS COUNT ERROR:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch admin notification count" });
    }
});

router.post("/read", authAdmin, async (req, res) => {
    try {
        const ids = Array.isArray(req.body?.notification_ids) ? req.body.notification_ids : [req.body?.notification_id];
        const params = [adminId(req)];
        let where = "recipient_type = 'platform_admin' AND recipient_id = ? AND deleted_at IS NULL";
        if (req.body?.mark_all !== true) {
            const clean = [...new Set(ids.map(value => String(value || "").trim()).filter(Boolean))].slice(0, 100);
            if (!clean.length) return res.json({ success: true, data: { updated: 0 } });
            where += ` AND notification_id IN (${clean.map(() => "?").join(",")})`;
            params.push(...clean);
        }
        const [result] = await pool.query(`UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE ${where}`, params);
        return res.json({ success: true, data: { updated: Number(result?.affectedRows || 0) } });
    } catch (error) {
        return res.status(500).json({ success: false, message: "Failed to mark admin notifications as read" });
    }
});

router.post("/delete", authAdmin, async (req, res) => {
    try {
        const ids = Array.isArray(req.body?.notification_ids) ? req.body.notification_ids : [req.body?.notification_id];
        const params = [adminId(req)];
        let where = "recipient_type = 'platform_admin' AND recipient_id = ? AND deleted_at IS NULL";
        if (req.body?.delete_all !== true) {
            const clean = [...new Set(ids.map(value => String(value || "").trim()).filter(Boolean))].slice(0, 100);
            if (!clean.length) return res.json({ success: true, data: { updated: 0 } });
            where += ` AND notification_id IN (${clean.map(() => "?").join(",")})`;
            params.push(...clean);
        }
        const [result] = await pool.query(`UPDATE notifications SET deleted_at = CURRENT_TIMESTAMP WHERE ${where}`, params);
        return res.json({ success: true, data: { updated: Number(result?.affectedRows || 0) } });
    } catch (error) {
        return res.status(500).json({ success: false, message: "Failed to delete admin notifications" });
    }
});

router.get("/preferences", authAdmin, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT category, in_app_enabled, push_enabled, email_enabled, sms_enabled, modify_by, modify_date
             FROM notification_preferences WHERE branch_id = ? AND recipient_type = 'platform_admin' AND recipient_id = ?
             ORDER BY category`,
            [PLATFORM_BRANCH, adminId(req)]
        );
        return res.json({ success: true, data: rows });
    } catch (error) {
        return res.status(500).json({ success: false, message: "Failed to fetch admin notification preferences" });
    }
});

router.put("/preferences", authAdmin, async (req, res) => {
    try {
        const id = adminId(req);
        const category = normalizeNotificationCategory(req.body?.category);
        await pool.query(
            `INSERT INTO notification_preferences
             (branch_id, recipient_type, recipient_id, category, in_app_enabled, push_enabled, email_enabled, sms_enabled, modify_by)
             VALUES (?, 'platform_admin', ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE in_app_enabled = VALUES(in_app_enabled), push_enabled = VALUES(push_enabled),
               email_enabled = VALUES(email_enabled), sms_enabled = VALUES(sms_enabled), modify_by = VALUES(modify_by)`,
            [PLATFORM_BRANCH, id, category, req.body?.in_app_enabled !== false, req.body?.push_enabled !== false,
                req.body?.email_enabled !== false, req.body?.sms_enabled === true, id]
        );
        return res.json({ success: true, message: "Admin notification preference saved" });
    } catch (error) {
        return res.status(500).json({ success: false, message: "Failed to save admin notification preference" });
    }
});

export default router;
