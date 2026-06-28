import nodemailer from "nodemailer";
import pool from "../db.js";
import { getConfigWithDecryptedPassword } from "./emailConfigService.js";
import { renderRecipientEmail } from "../utils/templateRenderer.js";
import { parseJson } from "./emailBroadcastService.js";

function secureFromConfig(config) {
    return Number(config.secure) === 1 || Number(config.port) === 465;
}

async function processDueBroadcasts(batchSize = 5) {
    const [rows] = await pool.query(
        `SELECT broadcast_id, branch_id
         FROM email_broadcasts
         WHERE status = 'scheduled'
           AND (scheduled_at IS NULL OR scheduled_at <= NOW())
         ORDER BY scheduled_at ASC, id ASC
         LIMIT ?`,
        [batchSize]
    );

    for (const row of rows) {
        const [lockResult] = await pool.query(
            "UPDATE email_broadcasts SET status = 'processing', started_at = COALESCE(started_at, NOW()), modify_date = NOW() WHERE branch_id = ? AND broadcast_id = ? AND status = 'scheduled'",
            [row.branch_id, row.broadcast_id]
        );
        if (lockResult.affectedRows === 0) continue;
        await processBroadcastRecipients(row.broadcast_id, row.branch_id);
    }
}

async function isUnsubscribed(branch_id, email) {
    const [rows] = await pool.query(
        "SELECT unsubscribe_id FROM email_unsubscribes WHERE branch_id = ? AND email = ? AND status = 'active' LIMIT 1",
        [branch_id, email]
    );
    return rows.length > 0;
}

async function processBroadcastRecipients(broadcast_id, branch_id, chunkSize = 100) {
    const [broadcastRows] = await pool.query(
        "SELECT * FROM email_broadcasts WHERE broadcast_id = ? AND branch_id = ? LIMIT 1",
        [broadcast_id, branch_id]
    );
    if (!broadcastRows.length) return;
    const broadcast = broadcastRows[0];

    if (["paused", "cancelled", "completed", "failed", "partially_failed"].includes(broadcast.status)) {
        return;
    }

    const smtpConfig = await getConfigWithDecryptedPassword({
        branch_id: broadcast.branch_id,
        config_id: broadcast.config_id
    });

    const transporter = nodemailer.createTransport({
        host: smtpConfig.host,
        port: Number(smtpConfig.port),
        secure: secureFromConfig(smtpConfig),
        auth: {
            user: smtpConfig.username,
            pass: smtpConfig.password
        }
    });

    while (true) {
        const [stateRows] = await pool.query(
            "SELECT status FROM email_broadcasts WHERE branch_id = ? AND broadcast_id = ? LIMIT 1",
            [branch_id, broadcast_id]
        );
        if (!stateRows.length || ["paused", "cancelled"].includes(stateRows[0].status)) {
            break;
        }

        const [recipients] = await pool.query(
            `SELECT * FROM email_broadcast_recipients
             WHERE branch_id = ? AND broadcast_id = ? AND status = 'pending'
             ORDER BY id ASC
             LIMIT ?`,
            [branch_id, broadcast_id, chunkSize]
        );
        if (!recipients.length) break;

        for (const recipient of recipients) {
            await processSingleRecipient({
                transporter,
                broadcast,
                recipient,
                smtpConfig
            });
        }
    }

    await updateBroadcastStatusAndCounts(broadcast_id, branch_id);
}

async function processSingleRecipient({ transporter, broadcast, recipient, smtpConfig }) {
    const {
        branch_id,
        broadcast_id,
        recipient_id,
        recipient_email,
        variable_values_json
    } = recipient;

    await pool.query(
        "UPDATE email_broadcast_recipients SET status = 'processing', last_attempt_at = NOW(), modify_date = NOW() WHERE branch_id = ? AND broadcast_id = ? AND recipient_id = ? AND status = 'pending'",
        [branch_id, broadcast_id, recipient_id]
    );

    if (await isUnsubscribed(branch_id, recipient_email)) {
        await pool.query(
            "UPDATE email_broadcast_recipients SET status = 'skipped', error_message = 'Recipient unsubscribed', modify_date = NOW() WHERE branch_id = ? AND broadcast_id = ? AND recipient_id = ?",
            [branch_id, broadcast_id, recipient_id]
        );
        return;
    }

    const finalVariables = {
        ...parseJson(broadcast.global_variables_json, {}),
        ...parseJson(variable_values_json, {})
    };

    const rendered = renderRecipientEmail({
        subject: broadcast.subject_snapshot,
        htmlBody: broadcast.html_body_snapshot,
        textBody: broadcast.text_body_snapshot,
        variables: finalVariables
    });

    try {
        const result = await transporter.sendMail({
            from: smtpConfig.from_name ? `${smtpConfig.from_name} <${smtpConfig.from_email}>` : smtpConfig.from_email,
            to: recipient_email,
            replyTo: smtpConfig.reply_to || undefined,
            subject: rendered.subject,
            html: rendered.htmlBody,
            text: rendered.textBody || undefined
        });

        await pool.query(
            `UPDATE email_broadcast_recipients
             SET status = 'sent', provider_message_id = ?, sent_at = NOW(), attempt_count = attempt_count + 1, error_message = NULL, last_attempt_at = NOW(), modify_date = NOW()
             WHERE branch_id = ? AND broadcast_id = ? AND recipient_id = ?`,
            [result?.messageId || null, branch_id, broadcast_id, recipient_id]
        );
    } catch (error) {
        await pool.query(
            `UPDATE email_broadcast_recipients
             SET status = 'failed', error_message = ?, attempt_count = attempt_count + 1, last_attempt_at = NOW(), modify_date = NOW()
             WHERE branch_id = ? AND broadcast_id = ? AND recipient_id = ?`,
            [String(error.message || "Email send failed"), branch_id, broadcast_id, recipient_id]
        );
    }
}

async function updateBroadcastStatusAndCounts(broadcast_id, branch_id) {
    const [countRows] = await pool.query(
        `SELECT
            COUNT(*) AS total_recipients,
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS total_pending,
            SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS total_sent,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS total_failed,
            SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS total_skipped
         FROM email_broadcast_recipients
         WHERE branch_id = ? AND broadcast_id = ?`,
        [branch_id, broadcast_id]
    );

    const c = countRows[0] || {};
    const total_pending = Number(c.total_pending || 0);
    const total_sent = Number(c.total_sent || 0);
    const total_failed = Number(c.total_failed || 0);
    const total_skipped = Number(c.total_skipped || 0);
    const total_recipients = Number(c.total_recipients || 0);

    let finalStatus = "processing";
    if (total_pending === 0) {
        if (total_sent === total_recipients) {
            finalStatus = "completed";
        } else if (total_sent > 0 && (total_failed > 0 || total_skipped > 0)) {
            finalStatus = "partially_failed";
        } else {
            finalStatus = "failed";
        }
    }

    await pool.query(
        `UPDATE email_broadcasts
         SET total_recipients = ?, total_pending = ?, total_sent = ?, total_failed = ?, total_skipped = ?,
             status = ?, completed_at = CASE WHEN ? IN ('completed', 'partially_failed', 'failed') THEN NOW() ELSE completed_at END,
             modify_date = NOW()
         WHERE branch_id = ? AND broadcast_id = ?`,
        [
            total_recipients,
            total_pending,
            total_sent,
            total_failed,
            total_skipped,
            finalStatus,
            finalStatus,
            branch_id,
            broadcast_id
        ]
    );
}

export {
    processDueBroadcasts,
    processBroadcastRecipients,
    renderRecipientEmail,
    updateBroadcastStatusAndCounts
};
