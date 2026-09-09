import crypto from "crypto";
import pool from "../db.js";
import {
    formatScheduleDisplay,
    makeRunKey,
    parseJSON,
    shouldRunNow,
    validateScheduleConfig,
} from "../helpers/recurringSchedule.js";
import { createEmailBroadcastInternal } from "./emailBroadcastCreateService.js";

function newId(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function mapScheduleRow(row) {
    const schedule_config = parseJSON(row.schedule_config, {});
    const audience = parseJSON(row.audience, {});
    const global_variables_json = parseJSON(row.global_variables_json, {});
    return {
        ...row,
        schedule_config,
        audience,
        global_variables_json,
        schedule_display: formatScheduleDisplay(row.schedule_type, schedule_config),
        is_active: Number(row.is_active) === 1 ? 1 : 0,
    };
}

async function listSchedules(branch_id, { active_only = false } = {}) {
    let sql = `SELECT * FROM email_broadcast_schedules WHERE branch_id = ?`;
    if (active_only) sql += ` AND is_active = 1`;
    sql += ` ORDER BY create_date DESC, id DESC`;
    const [rows] = await pool.query(sql, [branch_id]);
    return rows.map(mapScheduleRow);
}

async function getSchedule(branch_id, schedule_id) {
    const [rows] = await pool.query(
        `SELECT * FROM email_broadcast_schedules
         WHERE branch_id = ? AND schedule_id = ?
         LIMIT 1`,
        [branch_id, schedule_id]
    );
    if (!rows.length) return null;
    return mapScheduleRow(rows[0]);
}

async function createSchedule({
    branch_id,
    name,
    config_id = null,
    template_id,
    template_name = null,
    global_variables_json = {},
    audience,
    daily_limit = 1000,
    schedule_type,
    schedule_config,
    timezone = "Asia/Kolkata",
    create_by = null,
}) {
    const scheduleError = validateScheduleConfig(schedule_type, schedule_config);
    if (scheduleError) {
        return { ok: false, status: 400, message: scheduleError };
    }
    if (!name || !String(name).trim()) {
        return { ok: false, status: 400, message: "name is required" };
    }
    if (!template_id) {
        return { ok: false, status: 400, message: "template_id is required" };
    }
    if (!audience || typeof audience !== "object") {
        return { ok: false, status: 400, message: "audience is required" };
    }

    const schedule_id = newId("ebs");
    await pool.query(
        `INSERT INTO email_broadcast_schedules
         (schedule_id, branch_id, name, config_id, template_id, template_name,
          global_variables_json, audience, daily_limit, schedule_type, schedule_config,
          timezone, is_active, create_by, create_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NOW())`,
        [
            schedule_id,
            branch_id,
            String(name).trim(),
            config_id ? String(config_id).trim() : null,
            String(template_id).trim(),
            template_name ? String(template_name).trim() : null,
            JSON.stringify(global_variables_json || {}),
            JSON.stringify(audience),
            Number(daily_limit) || 1000,
            schedule_type,
            JSON.stringify(schedule_config),
            timezone || "Asia/Kolkata",
            create_by,
        ]
    );

    return { ok: true, data: await getSchedule(branch_id, schedule_id) };
}

async function updateSchedule(branch_id, schedule_id, patch = {}, modify_by = null) {
    const existing = await getSchedule(branch_id, schedule_id);
    if (!existing) {
        return { ok: false, status: 404, message: "Schedule not found" };
    }

    const nextType = patch.schedule_type || existing.schedule_type;
    const nextConfig =
        patch.schedule_config !== undefined
            ? patch.schedule_config
            : existing.schedule_config;

    if (patch.schedule_type || patch.schedule_config) {
        const scheduleError = validateScheduleConfig(nextType, nextConfig);
        if (scheduleError) {
            return { ok: false, status: 400, message: scheduleError };
        }
    }

    const fields = [];
    const values = [];
    if (patch.name !== undefined) {
        fields.push("name = ?");
        values.push(String(patch.name).trim());
    }
    if (patch.schedule_type !== undefined) {
        fields.push("schedule_type = ?");
        values.push(patch.schedule_type);
    }
    if (patch.schedule_config !== undefined) {
        fields.push("schedule_config = ?");
        values.push(JSON.stringify(patch.schedule_config));
    }
    if (patch.is_active !== undefined) {
        fields.push("is_active = ?");
        values.push(Number(patch.is_active) === 1 ? 1 : 0);
    }
    if (modify_by) {
        fields.push("modify_by = ?");
        values.push(modify_by);
    }
    fields.push("modify_date = NOW()");
    values.push(branch_id, schedule_id);

    await pool.query(
        `UPDATE email_broadcast_schedules
         SET ${fields.join(", ")}
         WHERE branch_id = ? AND schedule_id = ?`,
        values
    );
    return { ok: true, data: await getSchedule(branch_id, schedule_id) };
}

async function deleteSchedule(branch_id, schedule_id) {
    const [result] = await pool.query(
        `DELETE FROM email_broadcast_schedules
         WHERE branch_id = ? AND schedule_id = ?`,
        [branch_id, schedule_id]
    );
    if (!result?.affectedRows) {
        return { ok: false, status: 404, message: "Schedule not found" };
    }
    return { ok: true };
}

async function insertRunLog({
    schedule_id,
    branch_id,
    status,
    broadcast_id = null,
    recipients_count = 0,
    message = null,
}) {
    const run_id = newId("ebr");
    await pool.query(
        `INSERT INTO email_broadcast_schedule_runs
         (run_id, schedule_id, branch_id, status, broadcast_id, recipients_count, message, run_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
        [run_id, schedule_id, branch_id, status, broadcast_id, recipients_count, message]
    );
}

async function markScheduleRun(schedule_id, { run_key, broadcast_id = null, error = null }) {
    await pool.query(
        `UPDATE email_broadcast_schedules
         SET last_run_at = NOW(),
             last_run_key = ?,
             last_broadcast_id = COALESCE(?, last_broadcast_id),
             last_error = ?,
             modify_date = NOW()
         WHERE schedule_id = ?`,
        [run_key, broadcast_id, error, schedule_id]
    );
}

async function fireSchedule(schedule, { run_key, create_by = null, manual = false } = {}) {
    const occurrenceName = manual
        ? `${schedule.name} (manual ${new Date().toLocaleString("en-IN")})`
        : `${schedule.name} (${run_key})`;

    try {
        const result = await createEmailBroadcastInternal({
            branch_id: schedule.branch_id,
            username: create_by || schedule.create_by || "system",
            config_id: schedule.config_id,
            template_id: schedule.template_id,
            broadcast_name: occurrenceName,
            schedule_type: "now",
            timezone: schedule.timezone || "Asia/Kolkata",
            global_variables_json: schedule.global_variables_json || {},
            audience: schedule.audience,
            daily_limit: schedule.daily_limit || 1000,
        });

        if (!result.ok) {
            const message = result.message || "Failed to create broadcast";
            await markScheduleRun(schedule.schedule_id, { run_key, error: message });
            await insertRunLog({
                schedule_id: schedule.schedule_id,
                branch_id: schedule.branch_id,
                status: "failed",
                message,
            });
            return {
                ok: false,
                status: result.status || 400,
                message,
                data: result.data,
            };
        }

        const broadcast_id = result.data?.broadcast_id || null;
        await markScheduleRun(schedule.schedule_id, {
            run_key,
            broadcast_id,
            error: null,
        });
        await insertRunLog({
            schedule_id: schedule.schedule_id,
            branch_id: schedule.branch_id,
            status: "success",
            broadcast_id,
            recipients_count: Number(result.recipients_count || 0),
            message: manual
                ? create_by
                    ? `Manual run by ${create_by}`
                    : "Manual run"
                : "Broadcast created",
        });
        return {
            ok: true,
            data: {
                broadcast_id,
                schedule_id: schedule.schedule_id,
                recipients_count: result.recipients_count,
            },
        };
    } catch (error) {
        const message = error?.message || "Unexpected scheduler error";
        await markScheduleRun(schedule.schedule_id, { run_key, error: message });
        await insertRunLog({
            schedule_id: schedule.schedule_id,
            branch_id: schedule.branch_id,
            status: "failed",
            message,
        });
        return { ok: false, status: 500, message };
    }
}

async function processDueEmailBroadcastSchedules() {
    const runKey = makeRunKey();
    let rows = [];
    try {
        const [result] = await pool.query(
            `SELECT * FROM email_broadcast_schedules WHERE is_active = 1`
        );
        rows = result || [];
    } catch (error) {
        if (error?.code === "ER_NO_SUCH_TABLE") return;
        console.error("[Email Broadcast Scheduler] Query error:", error);
        return;
    }

    for (const row of rows) {
        const schedule = mapScheduleRow(row);
        if (schedule.last_run_key === runKey) continue;
        if (!shouldRunNow(schedule.schedule_type, schedule.schedule_config)) continue;
        await markScheduleRun(schedule.schedule_id, { run_key: runKey });
        const result = await fireSchedule(schedule, { run_key: runKey });
        if (!result.ok) {
            console.error(
                `[Email Broadcast Scheduler] ${schedule.schedule_id}:`,
                result.message
            );
        }
    }
}

async function runScheduleNow(branch_id, schedule_id, { create_by = null } = {}) {
    const schedule = await getSchedule(branch_id, schedule_id);
    if (!schedule) {
        return { ok: false, status: 404, message: "Schedule not found" };
    }
    const runKey = `manual_${makeRunKey()}`;
    return fireSchedule(schedule, { run_key: runKey, create_by, manual: true });
}

export {
    listSchedules,
    getSchedule,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    processDueEmailBroadcastSchedules,
    runScheduleNow,
};
