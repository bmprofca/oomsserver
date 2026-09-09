import crypto from "crypto";
import pool from "../db.js";
import { getActiveBranchSmtpConfigId } from "../helpers/emailStaticTemplateTypes.js";
import { resolveEmailCampaignRecipients } from "../helpers/emailCampaignRecipients.js";
import { processBroadcastRecipients } from "./emailQueueService.js";

function newId(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function formatScheduledTime(scheduledAt) {
    if (!scheduledAt) return null;
    if (
        typeof scheduledAt === "string" &&
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(scheduledAt)
    ) {
        return scheduledAt;
    }
    try {
        const date = new Date(scheduledAt);
        if (Number.isNaN(date.getTime())) return null;
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        const hours = String(date.getHours()).padStart(2, "0");
        const minutes = String(date.getMinutes()).padStart(2, "0");
        const seconds = String(date.getSeconds()).padStart(2, "0");
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    } catch {
        return null;
    }
}

/**
 * Create an email broadcast. Accepts either recipients[] or audience filters.
 */
export async function createEmailBroadcastInternal({
    branch_id,
    username = null,
    config_id = null,
    template_id,
    broadcast_name,
    schedule_type = "now",
    scheduled_at = null,
    timezone = "Asia/Kolkata",
    global_variables_json = {},
    recipients = null,
    audience = null,
    daily_limit = 1000,
}) {
    if (!template_id || !broadcast_name) {
        return {
            ok: false,
            status: 400,
            message: "template_id and broadcast_name are required",
        };
    }
    if (!["now", "scheduled"].includes(schedule_type)) {
        return { ok: false, status: 400, message: "Invalid schedule_type" };
    }
    if (schedule_type === "scheduled" && !scheduled_at) {
        return {
            ok: false,
            status: 400,
            message: "scheduled_at required when schedule_type is scheduled",
        };
    }

    let resolvedRecipients = Array.isArray(recipients) ? recipients : null;
    if ((!resolvedRecipients || !resolvedRecipients.length) && audience) {
        const resolved = await resolveEmailCampaignRecipients(branch_id, audience);
        if (!resolved.ok) {
            return {
                ok: false,
                status: resolved.status || 400,
                message: resolved.data?.message || "Failed to resolve recipients",
                data: resolved.data,
            };
        }
        resolvedRecipients = resolved.data;
    }

    if (!Array.isArray(resolvedRecipients) || !resolvedRecipients.length) {
        return {
            ok: false,
            status: 400,
            message: "No valid email recipients found for this audience",
        };
    }

    for (const recipient of resolvedRecipients) {
        if (!recipient?.recipient_email || !isValidEmail(recipient.recipient_email)) {
            return {
                ok: false,
                status: 400,
                message: "recipient_email required for every recipient",
            };
        }
    }

    const activeConfigId = await getActiveBranchSmtpConfigId(branch_id);
    const resolvedConfigId = config_id || activeConfigId;
    if (!resolvedConfigId) {
        return {
            ok: false,
            status: 400,
            message: "Select an SMTP configuration or activate one first.",
        };
    }

    const [cfg] = await pool.query(
        `SELECT config_id, daily_limit, status
         FROM email_configs
         WHERE branch_id=? AND config_id=?
         LIMIT 1`,
        [branch_id, resolvedConfigId]
    );
    if (!cfg.length) {
        return { ok: false, status: 404, message: "SMTP config not found" };
    }
    if (cfg[0].status !== "active") {
        return {
            ok: false,
            status: 400,
            message: "Selected SMTP config is inactive. Activate it first.",
        };
    }

    const [tpl] = await pool.query(
        `SELECT * FROM email_templates
         WHERE branch_id=? AND template_id=? AND status='active'
         LIMIT 1`,
        [branch_id, template_id]
    );
    if (!tpl.length) {
        return { ok: false, status: 404, message: "Active template not found" };
    }

    const broadcast_id = newId("brd");
    const template = tpl[0];
    const finalDailyLimit = daily_limit || cfg[0].daily_limit || 1000;

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        await conn.query(
            `INSERT INTO email_broadcasts
             (broadcast_id, branch_id, config_id, fallback_config_id, template_id, broadcast_name,
              subject_snapshot, html_body_snapshot, text_body_snapshot, template_variables_json,
              global_variables_json, schedule_type, scheduled_at, timezone, status,
              total_recipients, total_pending, total_sent, total_failed, total_skipped, daily_limit,
              create_by, modify_by, create_date, modify_date)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled',
                     ?, ?, 0, 0, 0, ?, ?, ?, NOW(), NOW())`,
            [
                broadcast_id,
                branch_id,
                resolvedConfigId,
                null,
                template_id,
                broadcast_name,
                template.subject,
                template.html_body,
                template.text_body,
                template.variables_json,
                JSON.stringify(global_variables_json || {}),
                schedule_type,
                schedule_type === "scheduled"
                    ? formatScheduledTime(scheduled_at)
                    : null,
                timezone || "Asia/Kolkata",
                resolvedRecipients.length,
                resolvedRecipients.length,
                finalDailyLimit,
                username,
                username,
            ]
        );

        for (const recipient of resolvedRecipients) {
            await conn.query(
                `INSERT INTO email_broadcast_recipients
                 (recipient_id, broadcast_id, branch_id, recipient_name, recipient_email,
                  variable_values_json, status, attempt_count, create_date, modify_date)
                 VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, NOW(), NOW())`,
                [
                    newId("rcp"),
                    broadcast_id,
                    branch_id,
                    recipient.recipient_name || null,
                    recipient.recipient_email,
                    JSON.stringify(recipient.variable_values_json || {}),
                ]
            );
        }

        await conn.commit();
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }

    if (schedule_type === "now") {
        processBroadcastRecipients(broadcast_id, branch_id).catch((err) => {
            console.error(`Error processing broadcast ${broadcast_id}:`, err);
        });
    }

    return {
        ok: true,
        status: 200,
        data: { broadcast_id },
        recipients_count: resolvedRecipients.length,
        message: "Broadcast created successfully",
    };
}
