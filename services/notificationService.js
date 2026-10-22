import crypto from "crypto";
import pool from "../db.js";
import {
    buildNotificationId,
    normalizeNotificationInput,
    normalizeNotificationRecipients,
} from "../helpers/notifications.js";

function dbOrPool(db) {
    return db || pool;
}

export async function resolveRecipientType(db, branchId, username) {
    const [rows] = await dbOrPool(db).query(
        `SELECT type
         FROM branch_mapping
         WHERE branch_id = ? AND username = ?
           AND (is_deleted = '0' OR is_deleted = 0)
           AND (status = '1' OR status = 1)
           AND (is_accepted = '1' OR is_accepted = 1)
         LIMIT 1`,
        [branchId, username]
    );
    return String(rows?.[0]?.type || "user").trim().toLowerCase();
}

export async function createNotifications({
    db = pool,
    branch_id,
    recipients,
    event_key,
    category,
    title,
    body,
    data,
    actor_username,
    expires_at,
} = {}) {
    if (!branch_id) throw new Error("branch_id is required");
    const normalized = normalizeNotificationInput({
        event_key,
        category,
        title,
        body,
        data,
        actor_username,
        expires_at,
    });
    const recipientRows = normalizeNotificationRecipients(recipients);
    if (!recipientRows.length) throw new Error("at least one notification recipient is required");

    const conn = dbOrPool(db);
    const created = [];
    for (const recipient of recipientRows) {
        const notificationId = buildNotificationId(
            branch_id,
            recipient.recipient_type,
            recipient.recipient_id,
            normalized.event_key
        );
        await conn.query(
            `INSERT INTO notifications
             (notification_id, branch_id, recipient_type, recipient_id, event_key, category,
              title, body, data_json, delivery_status, expires_at, actor_username)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?)
             ON DUPLICATE KEY UPDATE notification_id = notification_id`,
            [
                notificationId,
                branch_id,
                recipient.recipient_type,
                recipient.recipient_id,
                normalized.event_key,
                normalized.category,
                normalized.title,
                normalized.body,
                JSON.stringify(normalized.data),
                normalized.expires_at,
                normalized.actor_username,
            ]
        );
        created.push(notificationId);
    }
    return { notification_ids: created, count: created.length };
}

export async function listNotifications({
    db = pool,
    branch_id,
    recipient_type,
    recipient_id,
    page = 1,
    limit = 30,
    include_read = true,
} = {}) {
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 30));
    const offset = (safePage - 1) * safeLimit;
    const params = [branch_id, recipient_type, recipient_id];
    let where = `branch_id = ? AND recipient_type = ? AND recipient_id = ? AND deleted_at IS NULL`;
    if (!include_read) where += " AND read_at IS NULL";
    const [rows] = await dbOrPool(db).query(
        `SELECT notification_id, event_key, category, title, body, data_json,
                delivery_status, read_at, expires_at, actor_username, create_date
         FROM notifications
         WHERE ${where}
           AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
         ORDER BY create_date DESC, id DESC
         LIMIT ? OFFSET ?`,
        [...params, safeLimit, offset]
    );
    const [countRows] = await dbOrPool(db).query(
        `SELECT COUNT(*) AS total FROM notifications WHERE ${where}`,
        params
    );
    return {
        rows: rows.map((row) => ({
            ...row,
            data:
                row.data_json && typeof row.data_json === "object"
                    ? row.data_json
                    : row.data_json
                        ? JSON.parse(row.data_json)
                        : {},
            is_read: Boolean(row.read_at),
        })),
        pagination: { page: safePage, limit: safeLimit, total: Number(countRows?.[0]?.total || 0) },
    };
}

export async function getUnreadCount(db, { branch_id, recipient_type, recipient_id }) {
    const [rows] = await dbOrPool(db).query(
        `SELECT COUNT(*) AS total
         FROM notifications
         WHERE branch_id = ? AND recipient_type = ? AND recipient_id = ?
           AND read_at IS NULL AND deleted_at IS NULL
           AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)`,
        [branch_id, recipient_type, recipient_id]
    );
    return Number(rows?.[0]?.total || 0);
}

export async function updateNotificationState(db, {
    branch_id,
    recipient_type,
    recipient_id,
    notification_ids = [],
    mark_all = false,
    action,
}) {
    const conn = dbOrPool(db);
    const field = action === "delete" ? "deleted_at" : "read_at";
    const value = action === "delete" ? "CURRENT_TIMESTAMP" : "CURRENT_TIMESTAMP";
    const params = [branch_id, recipient_type, recipient_id];
    let where = `branch_id = ? AND recipient_type = ? AND recipient_id = ?`;
    if (!mark_all) {
        const ids = [...new Set(notification_ids.map((id) => String(id).trim()).filter(Boolean))].slice(0, 100);
        if (!ids.length) return 0;
        where += ` AND notification_id IN (${ids.map(() => "?").join(",")})`;
        params.push(...ids);
    }
    const [result] = await conn.query(`UPDATE notifications SET ${field} = ${value} WHERE ${where}`, params);
    return Number(result?.affectedRows || 0);
}

export async function getNotificationPreferences(db, { branch_id, recipient_type, recipient_id }) {
    const [rows] = await dbOrPool(db).query(
        `SELECT category, in_app_enabled, push_enabled, email_enabled, sms_enabled, modify_by, modify_date
         FROM notification_preferences
         WHERE branch_id = ? AND recipient_type = ? AND recipient_id = ?
         ORDER BY category`,
        [branch_id, recipient_type, recipient_id]
    );
    return rows;
}

export async function saveNotificationPreference(db, {
    branch_id,
    recipient_type,
    recipient_id,
    category,
    in_app_enabled = true,
    push_enabled = true,
    email_enabled = true,
    sms_enabled = false,
    modify_by,
}) {
    const preferenceId = crypto
        .createHash("sha256")
        .update([branch_id, recipient_type, recipient_id, category].join("\0"))
        .digest("hex");
    await dbOrPool(db).query(
        `INSERT INTO notification_preferences
         (branch_id, recipient_type, recipient_id, category, in_app_enabled, push_enabled,
          email_enabled, sms_enabled, modify_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
          in_app_enabled = VALUES(in_app_enabled),
          push_enabled = VALUES(push_enabled),
          email_enabled = VALUES(email_enabled),
          sms_enabled = VALUES(sms_enabled),
          modify_by = VALUES(modify_by)`,
        [
            branch_id,
            recipient_type,
            recipient_id,
            category,
            Number(Boolean(in_app_enabled)),
            Number(Boolean(push_enabled)),
            Number(Boolean(email_enabled)),
            Number(Boolean(sms_enabled)),
            modify_by || null,
        ]
    );
    await dbOrPool(db).query(
        `INSERT INTO audit_events
         (event_id, branch_id, actor_username, event_type, entity_type, entity_id, metadata)
         VALUES (?, ?, ?, 'notification_preference_updated', 'notification_preference', ?, ?)` ,
        [
            `aud_${crypto.randomUUID()}`,
            branch_id,
            modify_by || recipient_id,
            `${recipient_type}:${recipient_id}:${category}`,
            JSON.stringify({ category }),
        ]
    );
    return preferenceId;
}
