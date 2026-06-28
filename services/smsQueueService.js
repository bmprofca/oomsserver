import axios from "axios";
import pool from "../db.js";
import { getConfigWithDecryptedToken } from "./smsConfigService.js";
import { parseJson } from "./smsBroadcastService.js";
import crypto from "crypto";
import { debitWallet, creditWallet, getOrCreateWallet } from "./walletService.js";

const VARIABLE_REGEX = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;
const DEFAULT_AUTH_TOKEN = "TNcvwZtlCVKAhVecVxeTOBubj8TdQDkRuw9m6r0bcsbdRjYzhv5ylzoyli6T";

function newId(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

/**
 * Check and reset daily SMS limit for a config
 */
async function checkAndResetDailyLimit(configId, branchId) {
    const today = new Date().toISOString().split('T')[0];

    // If configId is default_fast2sms
    if (configId === "default_fast2sms") {
        return { canSend: true, remaining: 1000, sent: 0, limit: 1000 };
    }

    let [usage] = await pool.query(
        `SELECT * FROM sms_daily_usage 
         WHERE branch_id = ? AND config_id = ? AND usage_date = ?
         LIMIT 1`,
        [branchId, configId, today]
    );

    if (!usage.length) {
        const [config] = await pool.query(
            `SELECT daily_limit FROM sms_configs 
             WHERE branch_id = ? AND config_id = ? AND status = 'active'
             LIMIT 1`,
            [branchId, configId]
        );

        const dailyLimit = config.length ? config[0].daily_limit : 1000;

        await pool.query(
            `INSERT INTO sms_daily_usage (branch_id, config_id, usage_date, sms_sent)
             VALUES (?, ?, ?, 0)`,
            [branchId, configId, today]
        );

        return { canSend: true, remaining: dailyLimit, sent: 0, limit: dailyLimit };
    }

    const usageRecord = usage[0];
    const [config] = await pool.query(
        `SELECT daily_limit FROM sms_configs 
         WHERE branch_id = ? AND config_id = ?
         LIMIT 1`,
        [branchId, configId]
    );

    const dailyLimit = config.length ? config[0].daily_limit : 1000;
    const sent = usageRecord.sms_sent || 0;
    const remaining = dailyLimit - sent;

    return {
        canSend: remaining > 0,
        remaining: remaining,
        sent: sent,
        limit: dailyLimit
    };
}

/**
 * Increment daily SMS count for a config
 */
async function incrementDailyCount(configId, branchId) {
    if (configId === "default_fast2sms") return;

    const today = new Date().toISOString().split('T')[0];

    await pool.query(
        `INSERT INTO sms_daily_usage (branch_id, config_id, usage_date, sms_sent)
         VALUES (?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE 
         sms_sent = sms_sent + 1,
         updated_at = NOW()`,
        [branchId, configId, today]
    );

    await pool.query(
        `UPDATE sms_configs 
         SET sent_today = sent_today + 1,
             last_reset_date = ?
         WHERE branch_id = ? AND config_id = ?`,
        [today, branchId, configId]
    );
}

/**
 * Get available config details (primary and fallback)
 */
async function getAvailableConfigs(branchId, primaryConfigId, fallbackConfigId = null) {
    const availableConfigs = [];

    // Check primary config
    if (primaryConfigId) {
        try {
            const primary = await getConfigWithDecryptedToken({ branch_id: branchId, config_id: primaryConfigId });
            const limitCheck = await checkAndResetDailyLimit(primaryConfigId, branchId);
            if (limitCheck.canSend) {
                availableConfigs.push({
                    config: primary,
                    type: 'primary',
                    priority: 1,
                    remaining: limitCheck.remaining
                });
            }
        } catch (error) {
            console.log(`Primary config error, using fallback/default: ${error.message}`);
        }
    }

    // Check fallback config
    if (fallbackConfigId && fallbackConfigId !== primaryConfigId) {
        try {
            const fallback = await getConfigWithDecryptedToken({ branch_id: branchId, config_id: fallbackConfigId });
            const limitCheck = await checkAndResetDailyLimit(fallbackConfigId, branchId);
            if (limitCheck.canSend) {
                availableConfigs.push({
                    config: fallback,
                    type: 'fallback',
                    priority: 2,
                    remaining: limitCheck.remaining
                });
            }
        } catch (error) {
            console.log(`Fallback config error: ${error.message}`);
        }
    }

    // If no configs available, append default system Fast2SMS config
    if (availableConfigs.length === 0) {
        availableConfigs.push({
            config: {
                config_id: "default_fast2sms",
                branch_id: branchId,
                config_name: "Default Fast2SMS",
                provider: "fast2sms",
                auth_token: DEFAULT_AUTH_TOKEN,
                sender_id: "ONESAA",
                route: "dlt",
                daily_limit: 1000
            },
            type: 'system_default',
            priority: 3,
            remaining: 1000
        });
    }

    return availableConfigs.sort((a, b) => a.priority - b.priority);
}

/**
 * Log send attempt
 */
async function logSendAttempt(branchId, broadcastId, recipientId, configId, attemptNumber, errorMessage = null) {
    const attemptId = `satt_${crypto.randomBytes(8).toString("hex")}`;

    await pool.query(
        `INSERT INTO sms_send_attempts 
         (attempt_id, branch_id, broadcast_id, recipient_id, config_id, attempt_number, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [attemptId, branchId, broadcastId, recipientId, configId, attemptNumber, errorMessage]
    );

    return attemptId;
}

/**
 * Render SMS payload according to DLT or Quick route rules
 */
function renderSmsPayload({ messageTemplate, dltTemplateId, variables, route }) {
    // 1. Find all variables in template
    const varNames = [];
    let match;
    const regex = new RegExp(VARIABLE_REGEX);
    while ((match = regex.exec(messageTemplate)) !== null) {
        if (match[1]) varNames.push(match[1]);
    }

    if (route === "dlt") {
        // For DLT route, the message parameter is the DLT Template ID (numeric code)
        const message = dltTemplateId || messageTemplate;
        const values = varNames.map(name => String(variables[name] ?? ""));
        // Join with pipe and append trailing pipe if variables are present (e.g. "surajit|")
        const variables_values = values.length > 0 ? values.join("|") + "|" : "";
        return {
            message,
            variables_values
        };
    } else {
        // For Quick SMS/other routes, render variables directly into the message text
        const message = messageTemplate.replace(VARIABLE_REGEX, (_, name) => String(variables[name] ?? ""));
        return {
            message,
            variables_values: ""
        };
    }
}

function formatScheduleTime(date) {
    if (!date) return "";
    const d = new Date(date);
    if (isNaN(d.getTime())) return "";
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${day}-${month}-${year}-${hours}-${minutes}`;
}

/**
 * Send SMS using Fast2SMS API
 */
async function sendSmsViaFast2SMS({ auth_token, route, sender_id, message, variables_values, numbers, schedule_time }) {
    try {
        const resolvedRoute = route || "dlt";
        const cleanNumbers = String(numbers).replace(/\s+/g, ',').replace(/,+/g, ',');
        const body = {
            route: resolvedRoute,
            sender_id: sender_id || "ONESAA",
            flash: 0,
            numbers: cleanNumbers
        };

        if (resolvedRoute === "dlt") {
            body.message = message || "";
            body.variables_values = variables_values || "";
        } else {
            body.message = message || "";
        }

        if (schedule_time) {
            body.schedule_time = schedule_time;
        }

        const response = await axios.post("https://www.fast2sms.com/dev/bulkV2", body, {
            headers: {
                "authorization": auth_token,
                "Content-Type": "application/json"
            }
        });

        if (response.data && response.data.return) {
            return {
                success: true,
                request_id: response.data.request_id || (response.data.message && response.data.message[0]) || "success"
            };
        } else {
            return {
                success: false,
                error: response.data?.message ? String(response.data.message) : "Fast2SMS returned failure status"
            };
        }
    } catch (error) {
        return {
            success: false,
            error: error.response?.data?.message ? String(error.response.data.message) : error.message
        };
    }
}

async function processDueBroadcasts(batchSize = 5) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const currentLocalTime = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

    const [rows] = await pool.query(
        `SELECT broadcast_id, branch_id
         FROM sms_broadcasts
         WHERE status = 'scheduled'
           AND (scheduled_at IS NULL OR scheduled_at <= ?)
         ORDER BY scheduled_at ASC, id ASC
         LIMIT ?`,
        [currentLocalTime, batchSize]
    );

    for (const row of rows) {
        const [lockResult] = await pool.query(
            "UPDATE sms_broadcasts SET status = 'processing', started_at = COALESCE(started_at, ?), modify_date = ? WHERE branch_id = ? AND broadcast_id = ? AND status = 'scheduled'",
            [currentLocalTime, currentLocalTime, row.branch_id, row.broadcast_id]
        );
        if (lockResult.affectedRows === 0) continue;
        await processBroadcastRecipients(row.broadcast_id, row.branch_id);
    }
}

async function processBroadcastRecipients(broadcast_id, branch_id, chunkSize = 100) {
    const [broadcastRows] = await pool.query(
        "SELECT * FROM sms_broadcasts WHERE broadcast_id = ? AND branch_id = ? LIMIT 1",
        [broadcast_id, branch_id]
    );
    if (!broadcastRows.length) return;
    const broadcast = broadcastRows[0];

    if (["paused", "cancelled", "completed", "failed", "partially_failed"].includes(broadcast.status)) {
        return;
    }

    const availableConfigs = await getAvailableConfigs(branch_id, broadcast.config_id, broadcast.fallback_config_id);

    while (true) {
        const [stateRows] = await pool.query(
            "SELECT status FROM sms_broadcasts WHERE branch_id = ? AND broadcast_id = ? LIMIT 1",
            [branch_id, broadcast_id]
        );
        if (!stateRows.length || ["paused", "cancelled"].includes(stateRows[0].status)) {
            break;
        }

        const [recipients] = await pool.query(
            `SELECT * FROM sms_broadcast_recipients
             WHERE branch_id = ? AND broadcast_id = ? AND status = 'pending'
             ORDER BY id ASC
             LIMIT ?`,
            [branch_id, broadcast_id, chunkSize]
        );
        if (!recipients.length) break;

        for (const recipient of recipients) {
            await processSingleRecipient({
                broadcast,
                recipient,
                availableConfigs
            });
        }
    }

    await updateBroadcastStatusAndCounts(broadcast_id, branch_id);
}

async function processSingleRecipient({ broadcast, recipient, availableConfigs }) {
    const {
        branch_id,
        broadcast_id,
        recipient_id,
        recipient_mobile,
        variable_values_json
    } = recipient;

    await getOrCreateWallet(branch_id);

    // Lock funds by debiting 0.15 before calling Fast2SMS API (prevents balance overdrafts)
    let debited = false;
    try {
        await debitWallet({
            branch_id,
            amount: 0.15,
            purpose: "SMS Billing (Pending)",
            details: `SMS send pending to ${recipient_mobile}`
        });
        debited = true;
    } catch (error) {
        await pool.query(
            `UPDATE sms_broadcast_recipients
             SET status = 'failed', error_message = ?, attempt_count = attempt_count + 1, last_attempt_at = NOW(), modify_date = NOW()
             WHERE branch_id = ? AND broadcast_id = ? AND recipient_id = ?`,
            [error.message || "Insufficient wallet balance", branch_id, broadcast_id, recipient_id]
        );
        return;
    }

    await pool.query(
        "UPDATE sms_broadcast_recipients SET status = 'processing', last_attempt_at = NOW(), modify_date = NOW() WHERE branch_id = ? AND broadcast_id = ? AND recipient_id = ? AND status = 'pending'",
        [branch_id, broadcast_id, recipient_id]
    );

    const finalVariables = {
        ...parseJson(broadcast.global_variables_json, {}),
        ...parseJson(variable_values_json, {})
    };

    let lastError = null;
    let success = false;
    let providerMessageId = null;
    let usedConfigId = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
        for (const configInfo of availableConfigs) {
            const config = configInfo.config;
            const limitCheck = await checkAndResetDailyLimit(config.config_id, branch_id);
            if (!limitCheck.canSend) continue;

            const renderedPayload = renderSmsPayload({
                messageTemplate: broadcast.message_snapshot,
                dltTemplateId: broadcast.dlt_template_id_snapshot,
                variables: finalVariables,
                route: config.route
            });

            const schedule_time = broadcast.schedule_type === "scheduled" ? formatScheduleTime(broadcast.scheduled_at) : "";

            const sendResult = await sendSmsViaFast2SMS({
                auth_token: config.auth_token,
                route: config.route,
                sender_id: config.sender_id,
                message: renderedPayload.message,
                variables_values: renderedPayload.variables_values,
                numbers: recipient_mobile,
                schedule_time: schedule_time || undefined
            });

            await logSendAttempt(
                branch_id,
                broadcast_id,
                recipient_id,
                config.config_id,
                attempt,
                sendResult.success ? null : sendResult.error
            );

            if (sendResult.success) {
                await incrementDailyCount(config.config_id, branch_id);
                success = true;
                providerMessageId = sendResult.request_id;
                usedConfigId = config.config_id;
                break;
            } else {
                lastError = sendResult.error;
            }
        }

        if (success) break;
        // Delay before retry
        if (attempt < 3) {
            await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
        }
    }

    if (success) {
        // If sent successfully, update the transaction purpose to complete
        try {
            await pool.query(
                `UPDATE wallet_transactions 
                 SET purpose = 'SMS Sent', details = ?
                 WHERE branch_id = ? AND purpose = 'SMS Billing (Pending)' AND details LIKE ? 
                 ORDER BY id DESC LIMIT 1`,
                [`SMS sent to ${recipient_mobile}`, branch_id, `%${recipient_mobile}%`]
            );
        } catch (txError) {
            console.error("Failed to update transaction description:", txError);
        }

        await pool.query(
            `UPDATE sms_broadcast_recipients
             SET status = 'sent', provider_message_id = ?, sent_at = NOW(), attempt_count = attempt_count + 1, error_message = NULL, last_attempt_at = NOW(), used_config_id = ?, modify_date = NOW()
             WHERE branch_id = ? AND broadcast_id = ? AND recipient_id = ?`,
            [providerMessageId, usedConfigId, branch_id, broadcast_id, recipient_id]
        );
    } else {
        // Refund locked funds if the SMS send has ultimately failed
        if (debited) {
            try {
                await creditWallet({
                    branch_id,
                    amount: 0.15,
                    purpose: "SMS Refund",
                    details: `Refund for failed SMS to ${recipient_mobile}: ${lastError || "Unknown error"}`
                });
            } catch (refundError) {
                console.error("Refund failed for branch:", branch_id, refundError);
            }
        }

        await pool.query(
            `UPDATE sms_broadcast_recipients
             SET status = 'failed', error_message = ?, attempt_count = attempt_count + 1, last_attempt_at = NOW(), modify_date = NOW()
             WHERE branch_id = ? AND broadcast_id = ? AND recipient_id = ?`,
            [String(lastError || "SMS send failed"), branch_id, broadcast_id, recipient_id]
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
         FROM sms_broadcast_recipients
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
        `UPDATE sms_broadcasts
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
    updateBroadcastStatusAndCounts
};
