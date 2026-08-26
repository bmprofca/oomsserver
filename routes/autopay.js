import express from "express";
import cron from "node-cron";
import crypto from "crypto";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { GET_BALANCE } from "../helpers/function.js";
import {
    getActivePaymentTemplate,
    getActiveSmtpConfig,
    preparePaymentReminderVariables,
    renderTemplate,
    sendEmail,
} from "./payment_reminder.js";
import { sendPaymentReminderWhatsapp } from "../helpers/whatsappNotification.js";

const router = express.Router();

const ALLOWED_CHANNELS = new Set(["email", "sms", "whatsapp"]);
const VALID_SCHEDULE_TYPES = ["daily", "weekly", "monthly"];
let schedulerInitialized = false;

function ok(res, message, data = {}, pagination) {
    return res.json({ success: true, message, data, ...(pagination ? { pagination } : {}) });
}

function fail(res, message, code = 400) {
    return res.status(code).json({ success: false, message });
}

function userFromReq(req) {
    return req.headers.username || req.headers.Username || null;
}

function newId(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function parseJSON(value, fallback) {
    if (value == null || value === "") return fallback;
    if (typeof value === "object") return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function getOrdinalSuffix(n) {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return s[(v - 20) % 10] || s[v] || s[0];
}

function formatScheduleDisplay(schedule_type, scheduleConfig) {
    const config = scheduleConfig || {};
    if (schedule_type === "daily") {
        if (config.days?.length && config.days.length < 7) {
            const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
            const days = config.days.map((d) => dayNames[d === 7 ? 0 : d]);
            return `Every ${days.join(", ")} at ${config.time}`;
        }
        return `Every day at ${config.time || "—"}`;
    }
    if (schedule_type === "weekly") {
        const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        const day = dayNames[config.day_of_week === 7 ? 0 : config.day_of_week];
        return `Every ${day || "—"} at ${config.time || "—"}`;
    }
    if (schedule_type === "monthly") {
        if (config.day_of_month) {
            return `Every ${config.day_of_month}${getOrdinalSuffix(config.day_of_month)} of month at ${config.time || "—"}`;
        }
        if (config.week_of_month && config.day_of_week !== undefined) {
            const weekNames = ["First", "Second", "Third", "Fourth"];
            const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
            const weekText = config.week_of_month === "last" ? "Last" : weekNames[config.week_of_month - 1];
            return `${weekText} ${dayNames[config.day_of_week === 7 ? 0 : config.day_of_week]} of month at ${config.time || "—"}`;
        }
        if (config.last_day_of_month) {
            return `Last day of month at ${config.time || "—"}`;
        }
    }
    return "";
}

function normalizeChannels(input) {
    const list = Array.isArray(input) ? input : [];
    return [...new Set(list.map((c) => String(c || "").trim().toLowerCase()).filter((c) => ALLOWED_CHANNELS.has(c)))];
}

function validateScheduleConfig(schedule_type, schedule_config) {
    if (!VALID_SCHEDULE_TYPES.includes(schedule_type)) {
        return "schedule_type must be daily, weekly, or monthly";
    }
    if (!schedule_config || typeof schedule_config !== "object") {
        return "schedule_config is required";
    }
    if (!schedule_config.time) {
        return `${schedule_type} schedule requires time (HH:MM)`;
    }
    if (schedule_type === "weekly" && (schedule_config.day_of_week === undefined || schedule_config.day_of_week === null || schedule_config.day_of_week === "")) {
        return "weekly schedule requires day_of_week";
    }
    if (schedule_type === "monthly") {
        if (!schedule_config.day_of_month && !schedule_config.week_of_month && !schedule_config.last_day_of_month) {
            return "monthly schedule requires day_of_month, week_of_month, or last_day_of_month";
        }
    }
    return null;
}

function shouldRunNow(schedule_type, scheduleConfig) {
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentDayOfWeek = now.getDay();
    const currentDayOfMonth = now.getDate();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    const scheduledTime = scheduleConfig.time;
    if (scheduledTime) {
        const [hour, minute] = scheduledTime.split(":").map(Number);
        if (currentHour !== hour || currentMinute !== minute) {
            return false;
        }
    }

    switch (schedule_type) {
        case "daily":
            if (scheduleConfig.days && Array.isArray(scheduleConfig.days) && scheduleConfig.days.length > 0) {
                const normalizedDays = scheduleConfig.days.map((d) => (d === 0 || d === 7 ? 0 : d));
                return normalizedDays.includes(currentDayOfWeek);
            }
            return true;
        case "weekly": {
            const scheduledDay = scheduleConfig.day_of_week;
            if (scheduledDay !== undefined && scheduledDay !== null) {
                const normalizedScheduledDay = scheduledDay === 7 ? 0 : Number(scheduledDay);
                return currentDayOfWeek === normalizedScheduledDay;
            }
            return false;
        }
        case "monthly":
            if (scheduleConfig.day_of_month && scheduleConfig.day_of_month > 0) {
                return currentDayOfMonth === Number(scheduleConfig.day_of_month);
            }
            if (scheduleConfig.week_of_month && scheduleConfig.day_of_week !== undefined) {
                return isMatchingWeekdayOfMonth(currentYear, currentMonth, currentDayOfMonth, scheduleConfig);
            }
            if (scheduleConfig.last_day_of_month) {
                const lastDay = new Date(currentYear, currentMonth + 1, 0).getDate();
                return currentDayOfMonth === lastDay;
            }
            return false;
        default:
            return false;
    }
}

function isMatchingWeekdayOfMonth(year, month, day, scheduleConfig) {
    const date = new Date(year, month, day);
    const currentDayOfWeek = date.getDay();
    const weekOfMonth = Math.ceil(day / 7);
    const isLastWeek = day > new Date(year, month + 1, 0).getDate() - 7;
    const scheduledDayOfWeek = Number(scheduleConfig.day_of_week) === 7 ? 0 : Number(scheduleConfig.day_of_week);
    const scheduledWeekOfMonth = scheduleConfig.week_of_month;

    if (scheduledDayOfWeek !== currentDayOfWeek) return false;
    if (scheduledWeekOfMonth === "last") return isLastWeek;
    return weekOfMonth === Number(scheduledWeekOfMonth);
}

async function getUserBalance(branch_id, username) {
    try {
        return await GET_BALANCE({
            branch_id,
            party_id: username,
            party_type: "client",
        });
    } catch (error) {
        console.error("Error getting balance:", error);
        return { balance: 0, debit: 0, credit: 0 };
    }
}

async function getClientProfile(branch_id, username) {
    const [rows] = await pool.query(
        `SELECT p.username, p.name, p.email, p.mobile, p.country_code, p.status
         FROM profile p
         INNER JOIN clients c
            ON c.username = p.username
           AND c.branch_id = ?
           AND c.user_type = 'client'
           AND (c.is_deleted = '0' OR c.is_deleted = 0 OR c.is_deleted IS NULL)
         WHERE p.username = ? AND (p.status = 1 OR p.status = '1')
         LIMIT 1`,
        [branch_id, username]
    );
    return rows[0] || null;
}

/**
 * Enrollment must never depend on balance.
 * Accept username from search-party even if profile/client joins are imperfect.
 */
async function resolveEnrollmentUsername(branch_id, username) {
    const uname = String(username || "").trim();
    if (!uname) return null;

    const profile = await getClientProfile(branch_id, uname);
    if (profile?.username) return String(profile.username).trim();

    const [clientRows] = await pool.query(
        `SELECT username
         FROM clients
         WHERE branch_id = ?
           AND username = ?
           AND user_type = 'client'
           AND (is_deleted = '0' OR is_deleted = 0 OR is_deleted IS NULL)
         LIMIT 1`,
        [branch_id, uname]
    );
    if (clientRows[0]?.username) return String(clientRows[0].username).trim();

    const [profileRows] = await pool.query(
        `SELECT username FROM profile WHERE username = ? LIMIT 1`,
        [uname]
    );
    if (profileRows[0]?.username) return String(profileRows[0].username).trim();

    // Still enroll the provided username (caller already selected a client).
    return uname;
}

function mapClientRow(row) {
    const schedule_config = parseJSON(row.schedule_config, {});
    const channels = normalizeChannels(parseJSON(row.channels, []));
    return {
        ...row,
        schedule_config,
        channels,
        schedule_display: formatScheduleDisplay(row.schedule_type, schedule_config),
        is_active: Number(row.is_active) === 1 ? 1 : 0,
    };
}

async function processScheduledClients() {
    try {
        const [rows] = await pool.query(
            `SELECT reminder_id, branch_id, username, schedule_type, schedule_config, channels
             FROM autopay_clients
             WHERE is_active = 1`
        );

        for (const row of rows) {
            const scheduleConfig = parseJSON(row.schedule_config, {});
            if (!shouldRunNow(row.schedule_type, scheduleConfig)) continue;
            processAutopayClient(row, { force: false }).catch((err) => {
                console.error(`[Autopay Scheduler] Error for ${row.reminder_id}:`, err);
            });
        }
    } catch (error) {
        console.error("[Autopay Scheduler] Error:", error);
    }
}

/**
 * Core send for one enrolled client
 */
async function processAutopayClient(reminderRow, { force = false, sent_by = null } = {}) {
    const log_id = newId("apl");
    const branch_id = reminderRow.branch_id;
    const reminder_id = reminderRow.reminder_id;
    const username = reminderRow.username;
    const channels = normalizeChannels(parseJSON(reminderRow.channels, ["email"]));

    try {
        if (!channels.length) {
            throw new Error("No channels configured");
        }

        const client = await getClientProfile(branch_id, username);
        if (!client) {
            throw new Error("Client not found or inactive");
        }

        const balanceData = await getUserBalance(branch_id, username);
        // Only send when outstanding balance is positive (> 0).
        if (Number(balanceData?.balance || 0) <= 0) {
            await pool.query(
                `INSERT INTO autopay_logs
                 (log_id, reminder_id, username, branch_id, status, message, details, sent_count, skipped_count, failed_count, run_date, completed_at)
                 VALUES (?, ?, ?, ?, 'skipped', 'Balance is not positive', ?, 0, 1, 0, NOW(), NOW())`,
                [
                    log_id,
                    reminder_id,
                    username,
                    branch_id,
                    JSON.stringify([{
                        username,
                        status: "skipped",
                        reason: "Balance is not positive",
                        balance: balanceData.balance,
                        debit: balanceData.debit,
                        credit: balanceData.credit,
                    }]),
                ]
            );
            return {
                processed: 1,
                sent: 0,
                skipped: 1,
                failed: 0,
                status: "skipped",
                reason: "Balance is not positive",
            };
        }

        const variables = await preparePaymentReminderVariables(branch_id, username, client, balanceData);
        const channelResults = {};
        let sent = 0;
        let failed = 0;

        for (const channel of channels) {
            try {
                if (channel === "email") {
                    if (!client.email) throw new Error("Client does not have an email address");
                    const template = await getActivePaymentTemplate(branch_id, "payment_reminder");
                    const smtpConfig = await getActiveSmtpConfig(branch_id);
                    const sendResult = await sendEmail(
                        smtpConfig,
                        client.email,
                        renderTemplate(template.subject, variables),
                        renderTemplate(template.html_body, variables),
                        template.text_body ? renderTemplate(template.text_body, variables) : null
                    );
                    channelResults.email = { status: "sent", message_id: sendResult.messageId || null };
                    sent += 1;
                } else if (channel === "whatsapp") {
                    await sendPaymentReminderWhatsapp({
                        branch_id,
                        username,
                        balanceData,
                        sent_by: sent_by || "system",
                    });
                    channelResults.whatsapp = { status: "sent" };
                    sent += 1;
                } else if (channel === "sms") {
                    throw new Error("SMS sending is not available");
                }
            } catch (channelError) {
                failed += 1;
                channelResults[channel] = {
                    status: "failed",
                    reason: channelError?.response?.data?.message || channelError?.message || `Failed via ${channel}`,
                };
                console.error(`Autopay ${channel} failed for ${username}:`, channelError);
            }
        }

        const overall =
            sent === channels.length ? "completed" : sent > 0 ? "completed" : "failed";
        const skipped = 0;

        await pool.query(
            `INSERT INTO autopay_logs
             (log_id, reminder_id, username, branch_id, status, message, details, sent_count, skipped_count, failed_count, run_date, completed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [
                log_id,
                reminder_id,
                username,
                branch_id,
                overall,
                force ? "Manual autopay processed" : "Scheduled autopay processed",
                JSON.stringify([{ username, status: overall, channels: channelResults, debit: balanceData.debit }]),
                sent,
                skipped,
                failed,
            ]
        );

        return { processed: 1, sent, skipped, failed, status: overall, channels: channelResults };
    } catch (error) {
        console.error("Process autopay client error:", error);
        await pool.query(
            `INSERT INTO autopay_logs
             (log_id, reminder_id, username, branch_id, status, message, error_message, sent_count, skipped_count, failed_count, run_date, completed_at)
             VALUES (?, ?, ?, ?, 'failed', 'Autopay processing failed', ?, 0, 0, 1, NOW(), NOW())`,
            [log_id, reminder_id, username, branch_id, error.message]
        );
        return { processed: 1, sent: 0, skipped: 0, failed: 1, status: "failed", reason: error.message };
    }
}

// ==================== CLIENT ENROLLMENT ====================

/**
 * Resolve all active client usernames for a branch (server-side select-all).
 */
async function resolveAllClientUsernames(branch_id) {
    const [rows] = await pool.query(
        `SELECT DISTINCT c.username
         FROM clients c
         INNER JOIN profile p
            ON p.username = c.username
           AND (p.status = 1 OR p.status = '1')
         WHERE c.branch_id = ?
           AND c.user_type = 'client'
           AND (c.is_deleted = '0' OR c.is_deleted = 0 OR c.is_deleted IS NULL)
           AND c.username IS NOT NULL
           AND TRIM(c.username) <> ''`,
        [branch_id]
    );
    return rows.map((r) => String(r.username).trim()).filter(Boolean);
}

/**
 * Resolve unique client usernames from group firm memberships (one username even if many firms).
 */
async function resolveUsernamesFromGroup(branch_id, group_id) {
    const [rows] = await pool.query(
        `SELECT DISTINCT f.username
         FROM group_firms gf
         INNER JOIN firms f
            ON f.firm_id = gf.firm_id
           AND f.branch_id = ?
           AND f.is_deleted = '0'
         INNER JOIN clients c
            ON c.username = f.username
           AND c.branch_id = ?
           AND c.user_type = 'client'
           AND c.is_deleted = '0'
         INNER JOIN profile p
            ON p.username = f.username
           AND p.status = 1
         WHERE gf.group_id = ?
           AND gf.is_deleted = '0'
           AND f.username IS NOT NULL
           AND TRIM(f.username) <> ''`,
        [branch_id, branch_id, group_id]
    );
    return rows.map((r) => String(r.username).trim()).filter(Boolean);
}

async function upsertAutopayClients({
    branch_id,
    actor,
    usernames,
    schedule_type,
    schedule_config,
    channels,
    is_active = 1,
}) {
    let added = 0;
    let updated = 0;
    let skipped = 0;
    const details = [];
    const uniqueUsernames = [...new Set(usernames.map((u) => String(u || "").trim()).filter(Boolean))];

    for (const rawUsername of uniqueUsernames) {
        // No balance validation on enroll — any debit/credit/zero is allowed.
        const username = await resolveEnrollmentUsername(branch_id, rawUsername);
        if (!username) {
            skipped += 1;
            details.push({ username: rawUsername, status: "skipped", reason: "Invalid username" });
            continue;
        }

        const [existing] = await pool.query(
            `SELECT reminder_id FROM autopay_clients WHERE branch_id = ? AND username = ? LIMIT 1`,
            [branch_id, username]
        );

        if (existing.length) {
            await pool.query(
                `UPDATE autopay_clients
                 SET schedule_type = ?, schedule_config = ?, channels = ?, is_active = ?,
                     modify_by = ?, modify_date = NOW()
                 WHERE reminder_id = ? AND branch_id = ?`,
                [
                    schedule_type,
                    JSON.stringify(schedule_config),
                    JSON.stringify(channels),
                    is_active ? 1 : 0,
                    actor,
                    existing[0].reminder_id,
                    branch_id,
                ]
            );
            updated += 1;
            details.push({ username, status: "updated", reminder_id: existing[0].reminder_id });
        } else {
            const reminder_id = newId("apr");
            await pool.query(
                `INSERT INTO autopay_clients
                 (reminder_id, branch_id, username, schedule_type, schedule_config, channels, is_active, create_by, create_date)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
                [
                    reminder_id,
                    branch_id,
                    username,
                    schedule_type,
                    JSON.stringify(schedule_config),
                    JSON.stringify(channels),
                    is_active ? 1 : 0,
                    actor,
                ]
            );
            added += 1;
            details.push({ username, status: "added", reminder_id });
        }
    }

    return { added, updated, skipped, unique_clients: uniqueUsernames.length, details };
}

/**
 * Add clients with schedule + channels
 * POST /api/autopay/client/add
 * Body: {
 *   usernames?: string[],
 *   select_all_clients?: boolean,
 *   group_id?: string,
 *   group_ids?: string[],
 *   schedule_type, schedule_config, channels, is_active?
 * }
 * Existing clients are overwritten with the latest config.
 * Group / select-all expands usernames server-side.
 */
router.post("/client/add", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const actor = userFromReq(req);
        const {
            usernames,
            select_all_clients = false,
            group_id,
            group_ids,
            schedule_type,
            schedule_config,
            channels,
            is_active = 1,
        } = req.body || {};

        const scheduleError = validateScheduleConfig(schedule_type, schedule_config);
        if (scheduleError) return fail(res, scheduleError);

        const normalizedChannels = normalizeChannels(channels);
        if (!normalizedChannels.length) {
            return fail(res, "Select at least one channel: whatsapp, email, or sms");
        }

        const selectAllClients = Boolean(select_all_clients);
        const groupIdList = [
            ...(Array.isArray(group_ids) ? group_ids : []),
            ...(group_id ? [group_id] : []),
        ]
            .map((id) => String(id || "").trim())
            .filter(Boolean);

        let resolvedUsernames = [];
        let source = "client";
        if (groupIdList.length) {
            source = "group";
            const seen = new Set();
            for (const gid of groupIdList) {
                const fromGroup = await resolveUsernamesFromGroup(branch_id, gid);
                for (const username of fromGroup) {
                    if (seen.has(username)) continue;
                    seen.add(username);
                    resolvedUsernames.push(username);
                }
            }
            if (!resolvedUsernames.length) {
                return fail(res, "No clients found in the selected group(s)");
            }
        } else if (selectAllClients) {
            source = "all_clients";
            resolvedUsernames = await resolveAllClientUsernames(branch_id);
            if (!resolvedUsernames.length) {
                return fail(res, "No clients found in this branch");
            }
        } else {
            resolvedUsernames = Array.isArray(usernames) ? usernames : [];
            if (!resolvedUsernames.length) {
                return fail(res, "usernames, select_all_clients, or group_id is required");
            }
        }

        const result = await upsertAutopayClients({
            branch_id,
            actor,
            usernames: resolvedUsernames,
            schedule_type,
            schedule_config,
            channels: normalizedChannels,
            is_active,
        });

        if ((result.added || 0) + (result.updated || 0) === 0) {
            return fail(
                res,
                result.details?.[0]?.reason || "No clients were enrolled",
                400
            );
        }

        return ok(res, "Clients enrolled successfully", {
            ...result,
            source,
            select_all_clients: selectAllClients,
            group_ids: groupIdList,
        });
    } catch (error) {
        console.error("Add autopay clients error:", error);
        return fail(res, error.message);
    }
});

/**
 * Update one enrolled client config
 * PUT /api/autopay/client/update
 */
router.put("/client/update", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const actor = userFromReq(req);
        const { reminder_id, schedule_type, schedule_config, channels, is_active } = req.body || {};

        if (!reminder_id) return fail(res, "reminder_id is required");

        const [rows] = await pool.query(
            `SELECT * FROM autopay_clients WHERE reminder_id = ? AND branch_id = ? LIMIT 1`,
            [reminder_id, branch_id]
        );
        if (!rows.length) return fail(res, "Reminder not found", 404);

        const updates = [];
        const values = [];

        if (schedule_type || schedule_config) {
            const nextType = schedule_type || rows[0].schedule_type;
            const nextConfig = schedule_config || parseJSON(rows[0].schedule_config, {});
            const scheduleError = validateScheduleConfig(nextType, nextConfig);
            if (scheduleError) return fail(res, scheduleError);
            updates.push("schedule_type = ?", "schedule_config = ?");
            values.push(nextType, JSON.stringify(nextConfig));
        }

        if (channels !== undefined) {
            const normalizedChannels = normalizeChannels(channels);
            if (!normalizedChannels.length) {
                return fail(res, "Select at least one channel: whatsapp, email, or sms");
            }
            updates.push("channels = ?");
            values.push(JSON.stringify(normalizedChannels));
        }

        if (is_active !== undefined) {
            updates.push("is_active = ?");
            values.push(is_active ? 1 : 0);
        }

        if (!updates.length) return fail(res, "No fields to update");

        updates.push("modify_by = ?", "modify_date = NOW()");
        values.push(actor, reminder_id, branch_id);

        await pool.query(
            `UPDATE autopay_clients SET ${updates.join(", ")} WHERE reminder_id = ? AND branch_id = ?`,
            values
        );

        return ok(res, "Reminder updated successfully");
    } catch (error) {
        console.error("Update autopay client error:", error);
        return fail(res, error.message);
    }
});

/**
 * Remove (deactivate) enrolled clients
 * POST /api/autopay/client/remove
 */
router.post("/client/remove", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const actor = userFromReq(req);
        const reminderIds = Array.isArray(req.body?.reminder_ids)
            ? req.body.reminder_ids.map((id) => String(id || "").trim()).filter(Boolean)
            : req.body?.reminder_id
                ? [String(req.body.reminder_id).trim()]
                : [];
        const usernames = Array.isArray(req.body?.usernames)
            ? req.body.usernames.map((u) => String(u || "").trim()).filter(Boolean)
            : [];

        if (!reminderIds.length && !usernames.length) {
            return fail(res, "reminder_ids or usernames required");
        }

        let removed = 0;
        if (reminderIds.length) {
            const placeholders = reminderIds.map(() => "?").join(",");
            const [result] = await pool.query(
                `UPDATE autopay_clients
                 SET is_active = 0, modify_by = ?, modify_date = NOW()
                 WHERE branch_id = ? AND reminder_id IN (${placeholders})`,
                [actor, branch_id, ...reminderIds]
            );
            removed += result.affectedRows || 0;
        }
        if (usernames.length) {
            const placeholders = usernames.map(() => "?").join(",");
            const [result] = await pool.query(
                `UPDATE autopay_clients
                 SET is_active = 0, modify_by = ?, modify_date = NOW()
                 WHERE branch_id = ? AND username IN (${placeholders})`,
                [actor, branch_id, ...usernames]
            );
            removed += result.affectedRows || 0;
        }

        return ok(res, "Clients removed from auto reminder", { removed });
    } catch (error) {
        console.error("Remove autopay clients error:", error);
        return fail(res, error.message);
    }
});

/**
 * Hard-delete one reminder row
 * DELETE /api/autopay/client/:reminder_id
 */
router.delete("/client/:reminder_id", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { reminder_id } = req.params;
        const [result] = await pool.query(
            `DELETE FROM autopay_clients WHERE reminder_id = ? AND branch_id = ?`,
            [reminder_id, branch_id]
        );
        if (!result.affectedRows) return fail(res, "Reminder not found", 404);
        return ok(res, "Client removed from auto reminder");
    } catch (error) {
        console.error("Delete autopay client error:", error);
        return fail(res, error.message);
    }
});

/**
 * List enrolled clients
 * GET /api/autopay/client/list
 */
router.get("/client/list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const page_no = Math.max(1, Number(req.query.page_no || 1));
        const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
        const offset = (page_no - 1) * limit;
        const query = String(req.query.query || "").trim();
        const activeOnly = String(req.query.active_only || "1") !== "0";

        const where = ["ac.branch_id = ?"];
        const params = [branch_id];
        if (activeOnly) {
            where.push("ac.is_active = 1");
        }
        if (query) {
            where.push("(ac.username LIKE ? OR p.name LIKE ? OR p.mobile LIKE ?)");
            const like = `%${query}%`;
            params.push(like, like, like);
        }

        const whereSql = where.join(" AND ");

        const [rows] = await pool.query(
            `SELECT ac.*, p.name, p.email, p.mobile, p.country_code
             FROM autopay_clients ac
             LEFT JOIN profile p ON p.username = ac.username
             WHERE ${whereSql}
             ORDER BY ac.create_date DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        const [totalRows] = await pool.query(
            `SELECT COUNT(*) as total
             FROM autopay_clients ac
             LEFT JOIN profile p ON p.username = ac.username
             WHERE ${whereSql}`,
            params
        );

        const mapped = [];
        for (const row of rows) {
            const item = mapClientRow(row);
            const balanceData = await getUserBalance(branch_id, item.username);
            item.balance = balanceData.balance;
            item.debit = balanceData.debit;
            item.credit = balanceData.credit;
            item.has_debit = Number(balanceData.debit || 0) > 0;
            item.has_positive_balance = Number(balanceData.balance || 0) > 0;
            mapped.push(item);
        }

        return ok(res, "Enrolled clients retrieved", mapped, {
            page_no,
            limit,
            total: totalRows[0]?.total || 0,
            total_pages: Math.ceil((totalRows[0]?.total || 0) / limit),
        });
    } catch (error) {
        console.error("List autopay clients error:", error);
        return fail(res, error.message);
    }
});

/**
 * Manual process one client
 * POST /api/autopay/process/client/:reminder_id
 */
router.post("/process/client/:reminder_id", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { reminder_id } = req.params;
        const [rows] = await pool.query(
            `SELECT * FROM autopay_clients WHERE reminder_id = ? AND branch_id = ? AND is_active = 1 LIMIT 1`,
            [reminder_id, branch_id]
        );
        if (!rows.length) return fail(res, "Active reminder not found", 404);

        const result = await processAutopayClient(rows[0], {
            force: true,
            sent_by: userFromReq(req),
        });
        return ok(res, "Autopay processed successfully", result);
    } catch (error) {
        console.error("Process client error:", error);
        return fail(res, error.message);
    }
});

/**
 * Manual process all active enrolled clients for branch
 * POST /api/autopay/process/all
 */
router.post("/process/all", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const [rows] = await pool.query(
            `SELECT * FROM autopay_clients WHERE branch_id = ? AND is_active = 1`,
            [branch_id]
        );

        const results = [];
        for (const row of rows) {
            const result = await processAutopayClient(row, {
                force: true,
                sent_by: userFromReq(req),
            });
            results.push({ reminder_id: row.reminder_id, username: row.username, ...result });
        }

        return ok(res, "All enrolled clients processed", results);
    } catch (error) {
        console.error("Process all error:", error);
        return fail(res, error.message);
    }
});

/**
 * Manual process selected enrolled clients
 * POST /api/autopay/process/selected
 * Body: { reminder_ids: string[] }
 */
router.post("/process/selected", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const reminderIds = [
            ...new Set(
                (Array.isArray(req.body?.reminder_ids) ? req.body.reminder_ids : [])
                    .map((id) => String(id || "").trim())
                    .filter(Boolean)
            ),
        ];
        if (!reminderIds.length) {
            return fail(res, "Select at least one client");
        }

        const placeholders = reminderIds.map(() => "?").join(",");
        const [rows] = await pool.query(
            `SELECT * FROM autopay_clients
             WHERE branch_id = ? AND is_active = 1 AND reminder_id IN (${placeholders})`,
            [branch_id, ...reminderIds]
        );

        if (!rows.length) {
            return fail(res, "No active selected reminders found", 404);
        }

        const results = [];
        for (const row of rows) {
            const result = await processAutopayClient(row, {
                force: true,
                sent_by: userFromReq(req),
            });
            results.push({ reminder_id: row.reminder_id, username: row.username, ...result });
        }

        return ok(res, "Selected clients processed", {
            requested: reminderIds.length,
            processed: results.length,
            results,
        });
    } catch (error) {
        console.error("Process selected error:", error);
        return fail(res, error.message);
    }
});

/**
 * Logs
 * GET /api/autopay/logs
 */
router.get("/logs", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const page_no = Math.max(1, Number(req.query.page_no || 1));
        const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
        const offset = (page_no - 1) * limit;
        const username = String(req.query.username || "").trim();
        const startDate = String(req.query.start_date || "").trim();
        const endDate = String(req.query.end_date || "").trim();

        const where = ["l.branch_id = ?"];
        const params = [branch_id];
        if (username) {
            where.push("l.username = ?");
            params.push(username);
        }
        if (startDate && endDate) {
            where.push("DATE(l.run_date) BETWEEN ? AND ?");
            params.push(startDate, endDate);
        }

        const [logs] = await pool.query(
            `SELECT l.*, p.name AS client_name
             FROM autopay_logs l
             LEFT JOIN profile p ON p.username = l.username
             WHERE ${where.join(" AND ")}
             ORDER BY l.run_date DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        logs.forEach((log) => {
            log.details = parseJSON(log.details, []);
        });

        const [totalRows] = await pool.query(
            `SELECT COUNT(*) as total FROM autopay_logs l WHERE ${where.join(" AND ")}`,
            params
        );

        return ok(res, "Logs retrieved successfully", logs, {
            page_no,
            limit,
            total: totalRows[0]?.total || 0,
            total_pages: Math.ceil((totalRows[0]?.total || 0) / limit),
        });
    } catch (error) {
        console.error("Get logs error:", error);
        return fail(res, error.message);
    }
});

/**
 * Stats
 * GET /api/autopay/stats
 */
router.get("/stats", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;

        const [clientStats] = await pool.query(
            `SELECT
                COUNT(*) as total_clients,
                SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active_clients,
                SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) as inactive_clients
             FROM autopay_clients WHERE branch_id = ?`,
            [branch_id]
        );

        const [lastRun] = await pool.query(
            `SELECT
                COUNT(*) as total_runs,
                SUM(CASE WHEN status IN ('completed','skipped') THEN 1 ELSE 0 END) as successful_runs,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_runs,
                SUM(sent_count) as total_sent,
                SUM(skipped_count) as total_skipped,
                SUM(failed_count) as total_failed
             FROM autopay_logs WHERE branch_id = ? AND DATE(run_date) = CURDATE()`,
            [branch_id]
        );

        return ok(res, "Autopay statistics", {
            clients: {
                total: clientStats[0]?.total_clients || 0,
                active: clientStats[0]?.active_clients || 0,
                inactive: clientStats[0]?.inactive_clients || 0,
            },
            today_runs: {
                total_runs: lastRun[0]?.total_runs || 0,
                successful: lastRun[0]?.successful_runs || 0,
                failed: lastRun[0]?.failed_runs || 0,
                total_sent: lastRun[0]?.total_sent || 0,
                total_skipped: lastRun[0]?.total_skipped || 0,
                total_failed: lastRun[0]?.total_failed || 0,
            },
        });
    } catch (error) {
        console.error("Get stats error:", error);
        return fail(res, error.message);
    }
});

function initScheduler() {
    if (schedulerInitialized) return;
    cron.schedule("* * * * *", async () => {
        await processScheduledClients();
    });
    schedulerInitialized = true;
    setTimeout(async () => {
        await processScheduledClients();
    }, 5000);
}

initScheduler();

export default router;
