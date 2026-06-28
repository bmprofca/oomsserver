import crypto from "crypto";
import pool from "../db.js";
import { getActiveTemplate } from "./emailTemplateService.js";
import { getConfigWithDecryptedPassword } from "./emailConfigService.js";

function newId(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function parseJson(value, fallback = {}) {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

async function createBroadcast({ branch_id, username, payload }) {
    const {
        config_id,
        template_id,
        broadcast_name,
        schedule_type = "now",
        scheduled_at = null,
        timezone = "Asia/Kolkata",
        global_variables_json = {},
        recipients
    } = payload;

    if (!config_id || !template_id || !broadcast_name) throw new Error("config_id, template_id and broadcast_name are required");
    if (!Array.isArray(recipients) || recipients.length === 0) throw new Error("recipients must be a non-empty array");
    if (!["now", "scheduled"].includes(schedule_type)) throw new Error("Invalid schedule_type");
    if (schedule_type === "scheduled" && !scheduled_at) throw new Error("scheduled_at is required for scheduled broadcasts");

    for (const recipient of recipients) {
        if (!recipient?.recipient_email || !isValidEmail(recipient.recipient_email)) {
            throw new Error("Each recipient must have a valid recipient_email");
        }
    }

    const template = await getActiveTemplate({ branch_id, template_id });
    await getConfigWithDecryptedPassword({ branch_id, config_id });

    const broadcast_id = newId("brd");
    const nowDateForSchedule = schedule_type === "now" ? new Date() : null;
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        await conn.query(
            `INSERT INTO email_broadcasts
            (broadcast_id, branch_id, config_id, template_id, broadcast_name, subject_snapshot, html_body_snapshot, text_body_snapshot,
            template_variables_json, global_variables_json, schedule_type, scheduled_at, timezone, status,
            total_recipients, total_pending, total_sent, total_failed, total_skipped, create_by, modify_by, create_date, modify_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, 0, 0, 0, ?, ?, NOW(), NOW())`,
            [
                broadcast_id,
                branch_id,
                config_id,
                template_id,
                broadcast_name,
                template.subject,
                template.html_body,
                template.text_body,
                template.variables_json,
                JSON.stringify(global_variables_json || {}),
                schedule_type,
                schedule_type === "scheduled" ? scheduled_at : nowDateForSchedule,
                timezone,
                recipients.length,
                recipients.length,
                username || null,
                username || null
            ]
        );

        for (const recipient of recipients) {
            await conn.query(
                `INSERT INTO email_broadcast_recipients
                (recipient_id, broadcast_id, branch_id, recipient_name, recipient_email, variable_values_json, status, attempt_count, create_date, modify_date)
                VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, NOW(), NOW())`,
                [
                    newId("rcp"),
                    broadcast_id,
                    branch_id,
                    recipient.recipient_name || null,
                    recipient.recipient_email,
                    JSON.stringify(recipient.variable_values_json || {})
                ]
            );
        }

        await conn.commit();
        return getBroadcastDetails({ branch_id, broadcast_id });
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
}

async function listBroadcasts({ branch_id, page_no = 1, limit = 10 }) {
    const page = Math.max(Number(page_no) || 1, 1);
    const size = Math.max(Number(limit) || 10, 1);
    const offset = (page - 1) * size;

    const [rows] = await pool.query(
        `SELECT broadcast_id, branch_id, config_id, template_id, broadcast_name, schedule_type, scheduled_at, timezone, status,
                total_recipients, total_pending, total_sent, total_failed, total_skipped, started_at, completed_at, create_by, modify_by, create_date, modify_date
         FROM email_broadcasts
         WHERE branch_id = ?
         ORDER BY id DESC
         LIMIT ? OFFSET ?`,
        [branch_id, size, offset]
    );
    const [countRows] = await pool.query(
        "SELECT COUNT(*) AS total FROM email_broadcasts WHERE branch_id = ?",
        [branch_id]
    );
    const total = Number(countRows[0]?.total || 0);
    return {
        data: rows,
        pagination: {
            page_no: page,
            limit: size,
            total,
            total_pages: Math.ceil(total / size) || 1,
            has_more: page * size < total
        }
    };
}

async function getBroadcastDetails({ branch_id, broadcast_id }) {
    const [rows] = await pool.query(
        `SELECT broadcast_id, branch_id, config_id, template_id, broadcast_name, subject_snapshot, html_body_snapshot, text_body_snapshot,
                template_variables_json, global_variables_json, schedule_type, scheduled_at, timezone, status, total_recipients, total_pending,
                total_sent, total_failed, total_skipped, started_at, completed_at, create_by, modify_by, create_date, modify_date
         FROM email_broadcasts WHERE branch_id = ? AND broadcast_id = ? LIMIT 1`,
        [branch_id, broadcast_id]
    );
    if (!rows.length) throw new Error("Broadcast not found");
    const row = rows[0];
    return {
        ...row,
        template_variables_json: parseJson(row.template_variables_json, []),
        global_variables_json: parseJson(row.global_variables_json, {})
    };
}

async function listRecipients({ branch_id, broadcast_id, page_no = 1, limit = 50 }) {
    const page = Math.max(Number(page_no) || 1, 1);
    const size = Math.max(Number(limit) || 50, 1);
    const offset = (page - 1) * size;

    const [rows] = await pool.query(
        `SELECT recipient_id, recipient_name, recipient_email, variable_values_json, status, attempt_count, error_message,
                provider_message_id, sent_at, last_attempt_at, create_date, modify_date
         FROM email_broadcast_recipients
         WHERE branch_id = ? AND broadcast_id = ?
         ORDER BY id ASC
         LIMIT ? OFFSET ?`,
        [branch_id, broadcast_id, size, offset]
    );
    const [countRows] = await pool.query(
        "SELECT COUNT(*) AS total FROM email_broadcast_recipients WHERE branch_id = ? AND broadcast_id = ?",
        [branch_id, broadcast_id]
    );
    const total = Number(countRows[0]?.total || 0);
    return {
        data: rows.map((row) => ({
            ...row,
            variable_values_json: parseJson(row.variable_values_json, {})
        })),
        pagination: {
            page_no: page,
            limit: size,
            total,
            total_pages: Math.ceil(total / size) || 1,
            has_more: page * size < total
        }
    };
}

async function updateBroadcastStatus({ branch_id, broadcast_id, nextStatus, username }) {
    const [rows] = await pool.query(
        "SELECT status FROM email_broadcasts WHERE branch_id = ? AND broadcast_id = ? LIMIT 1",
        [branch_id, broadcast_id]
    );
    if (!rows.length) throw new Error("Broadcast not found");
    const current = rows[0].status;

    const allowedTransitions = {
        paused: ["processing", "scheduled"],
        scheduled: ["paused"],
        cancelled: ["scheduled", "paused", "processing"]
    };
    if (!allowedTransitions[nextStatus]?.includes(current)) {
        throw new Error(`Cannot change broadcast from ${current} to ${nextStatus}`);
    }

    await pool.query(
        "UPDATE email_broadcasts SET status = ?, modify_by = ?, modify_date = NOW() WHERE branch_id = ? AND broadcast_id = ?",
        [nextStatus, username || null, branch_id, broadcast_id]
    );
    return getBroadcastDetails({ branch_id, broadcast_id });
}

async function retryFailedRecipients({ branch_id, broadcast_id, username }) {
    const [bRows] = await pool.query(
        "SELECT status FROM email_broadcasts WHERE branch_id = ? AND broadcast_id = ? LIMIT 1",
        [branch_id, broadcast_id]
    );
    if (!bRows.length) throw new Error("Broadcast not found");
    if (["cancelled", "completed"].includes(bRows[0].status)) {
        throw new Error("Cannot retry recipients on cancelled/completed broadcast");
    }

    const [result] = await pool.query(
        `UPDATE email_broadcast_recipients
         SET status = 'pending', error_message = NULL, modify_date = NOW()
         WHERE branch_id = ? AND broadcast_id = ? AND status = 'failed'`,
        [branch_id, broadcast_id]
    );

    await pool.query(
        "UPDATE email_broadcasts SET status = 'scheduled', modify_by = ?, modify_date = NOW() WHERE branch_id = ? AND broadcast_id = ?",
        [username || null, branch_id, broadcast_id]
    );

    return {
        retried_count: result.affectedRows,
        broadcast: await getBroadcastDetails({ branch_id, broadcast_id })
    };
}

export {
    createBroadcast,
    listBroadcasts,
    getBroadcastDetails,
    listRecipients,
    updateBroadcastStatus,
    retryFailedRecipients,
    parseJson
};
