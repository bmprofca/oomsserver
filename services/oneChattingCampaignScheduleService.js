import crypto from "crypto";
import pool from "../db.js";
import {
    formatScheduleDisplay,
    makeRunKey,
    parseJSON,
    shouldRunNow,
    validateScheduleConfig,
} from "../helpers/recurringSchedule.js";

function newId(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function mapScheduleRow(row) {
    const schedule_config = parseJSON(row.schedule_config, {});
    const component = parseJSON(row.component, []);
    const audience = parseJSON(row.audience, {});
    return {
        ...row,
        schedule_config,
        component,
        audience,
        schedule_display: formatScheduleDisplay(row.schedule_type, schedule_config),
        is_active: Number(row.is_active) === 1 ? 1 : 0,
    };
}

async function listSchedules(branch_id, { active_only = false } = {}) {
    const params = [branch_id];
    let sql = `SELECT *
               FROM onechatting_campaign_schedules
               WHERE branch_id = ?`;
    if (active_only) {
        sql += ` AND is_active = 1`;
    }
    sql += ` ORDER BY create_date DESC, id DESC`;
    const [rows] = await pool.query(sql, params);
    return rows.map(mapScheduleRow);
}

async function getSchedule(branch_id, schedule_id) {
    const [rows] = await pool.query(
        `SELECT * FROM onechatting_campaign_schedules
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
    template_id,
    template_name = null,
    component,
    audience,
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
    if (!Array.isArray(component)) {
        return { ok: false, status: 400, message: "component must be an array" };
    }
    if (!audience || typeof audience !== "object") {
        return { ok: false, status: 400, message: "audience is required" };
    }

    const schedule_id = newId("ocs");
    await pool.query(
        `INSERT INTO onechatting_campaign_schedules
         (schedule_id, branch_id, name, template_id, template_name, component, audience,
          schedule_type, schedule_config, timezone, is_active, create_by, create_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NOW())`,
        [
            schedule_id,
            branch_id,
            String(name).trim(),
            String(template_id).trim(),
            template_name ? String(template_name).trim() : null,
            JSON.stringify(component),
            JSON.stringify(audience),
            schedule_type,
            JSON.stringify(schedule_config),
            timezone || "Asia/Kolkata",
            create_by,
        ]
    );

    const created = await getSchedule(branch_id, schedule_id);
    return { ok: true, data: created };
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

    if (!fields.length) {
        return { ok: true, data: existing };
    }

    values.push(branch_id, schedule_id);
    await pool.query(
        `UPDATE onechatting_campaign_schedules
         SET ${fields.join(", ")}
         WHERE branch_id = ? AND schedule_id = ?`,
        values
    );

    const updated = await getSchedule(branch_id, schedule_id);
    return { ok: true, data: updated };
}

async function deleteSchedule(branch_id, schedule_id) {
    const [result] = await pool.query(
        `DELETE FROM onechatting_campaign_schedules
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
    campaign_id = null,
    recipients_count = 0,
    message = null,
}) {
    const run_id = newId("ocr");
    await pool.query(
        `INSERT INTO onechatting_campaign_schedule_runs
         (run_id, schedule_id, branch_id, status, campaign_id, recipients_count, message, run_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
            run_id,
            schedule_id,
            branch_id,
            status,
            campaign_id,
            recipients_count,
            message,
        ]
    );
    return run_id;
}

async function markScheduleRun(schedule_id, { run_key, campaign_id = null, error = null }) {
    await pool.query(
        `UPDATE onechatting_campaign_schedules
         SET last_run_at = NOW(),
             last_run_key = ?,
             last_campaign_id = COALESCE(?, last_campaign_id),
             last_error = ?,
             modify_date = NOW()
         WHERE schedule_id = ?`,
        [run_key, campaign_id, error, schedule_id]
    );
}

/**
 * Fire due recurring campaigns. Requires createOneChattingCampaignInternal from whatsapp routes.
 */
async function processDueOneChattingCampaignSchedules() {
    const runKey = makeRunKey();
    let createOneChattingCampaignInternal;
    try {
        const mod = await import("../routes/whatsapp.js");
        createOneChattingCampaignInternal = mod.createOneChattingCampaignInternal;
    } catch (error) {
        console.error(
            "[OneChatting Campaign Scheduler] Failed to load create helper:",
            error?.message || error
        );
        return;
    }
    if (typeof createOneChattingCampaignInternal !== "function") {
        console.error(
            "[OneChatting Campaign Scheduler] createOneChattingCampaignInternal is not exported"
        );
        return;
    }

    let rows = [];
    try {
        const [result] = await pool.query(
            `SELECT *
             FROM onechatting_campaign_schedules
             WHERE is_active = 1`
        );
        rows = result || [];
    } catch (error) {
        // Table may not exist yet before migration.
        if (error?.code === "ER_NO_SUCH_TABLE") return;
        console.error("[OneChatting Campaign Scheduler] Query error:", error);
        return;
    }

    for (const row of rows) {
        const schedule = mapScheduleRow(row);
        if (schedule.last_run_key === runKey) continue;
        if (!shouldRunNow(schedule.schedule_type, schedule.schedule_config)) continue;

        // Claim this minute immediately to avoid double-send if job overlaps.
        await markScheduleRun(schedule.schedule_id, { run_key: runKey });

        const occurrenceName = `${schedule.name} (${runKey})`;
        try {
            const result = await createOneChattingCampaignInternal({
                branch_id: schedule.branch_id,
                name: occurrenceName,
                template_id: schedule.template_id,
                component: schedule.component,
                audience: schedule.audience,
            });

            if (!result?.ok) {
                const message =
                    result?.data?.message ||
                    result?.message ||
                    "Failed to create campaign";
                await markScheduleRun(schedule.schedule_id, {
                    run_key: runKey,
                    error: message,
                });
                await insertRunLog({
                    schedule_id: schedule.schedule_id,
                    branch_id: schedule.branch_id,
                    status: "failed",
                    message,
                });
                console.error(
                    `[OneChatting Campaign Scheduler] ${schedule.schedule_id}:`,
                    message
                );
                continue;
            }

            const campaign_id =
                result.data?.campaign_id ||
                result.data?.data?.campaign_id ||
                null;
            const recipients_count = Number(result.recipients_count || 0);

            await markScheduleRun(schedule.schedule_id, {
                run_key: runKey,
                campaign_id,
                error: null,
            });
            await insertRunLog({
                schedule_id: schedule.schedule_id,
                branch_id: schedule.branch_id,
                status: "success",
                campaign_id,
                recipients_count,
                message: "Campaign created",
            });
        } catch (error) {
            const message = error?.message || "Unexpected scheduler error";
            await markScheduleRun(schedule.schedule_id, {
                run_key: runKey,
                error: message,
            });
            await insertRunLog({
                schedule_id: schedule.schedule_id,
                branch_id: schedule.branch_id,
                status: "failed",
                message,
            });
            console.error(
                `[OneChatting Campaign Scheduler] ${schedule.schedule_id}:`,
                error
            );
        }
    }
}

async function runScheduleNow(branch_id, schedule_id, { create_by = null } = {}) {
    const schedule = await getSchedule(branch_id, schedule_id);
    if (!schedule) {
        return { ok: false, status: 404, message: "Schedule not found" };
    }

    const mod = await import("../routes/whatsapp.js");
    const createOneChattingCampaignInternal = mod.createOneChattingCampaignInternal;
    if (typeof createOneChattingCampaignInternal !== "function") {
        return {
            ok: false,
            status: 500,
            message: "Campaign create helper unavailable",
        };
    }

    const runKey = `manual_${makeRunKey()}`;
    const occurrenceName = `${schedule.name} (manual ${new Date().toLocaleString("en-IN")})`;

    const result = await createOneChattingCampaignInternal({
        branch_id: schedule.branch_id,
        name: occurrenceName,
        template_id: schedule.template_id,
        component: schedule.component,
        audience: schedule.audience,
    });

    if (!result?.ok) {
        const message =
            result?.data?.message || result?.message || "Failed to create campaign";
        await insertRunLog({
            schedule_id: schedule.schedule_id,
            branch_id: schedule.branch_id,
            status: "failed",
            message: create_by ? `${message} (by ${create_by})` : message,
        });
        return {
            ok: false,
            status: result.status || 400,
            message,
            data: result.data,
        };
    }

    const campaign_id =
        result.data?.campaign_id || result.data?.data?.campaign_id || null;
    await markScheduleRun(schedule.schedule_id, {
        run_key: runKey,
        campaign_id,
        error: null,
    });
    await insertRunLog({
        schedule_id: schedule.schedule_id,
        branch_id: schedule.branch_id,
        status: "success",
        campaign_id,
        recipients_count: Number(result.recipients_count || 0),
        message: create_by ? `Manual run by ${create_by}` : "Manual run",
    });

    return {
        ok: true,
        data: {
            campaign_id,
            schedule_id: schedule.schedule_id,
            recipients_count: result.recipients_count,
            response: result.data,
        },
    };
}

export {
    listSchedules,
    getSchedule,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    processDueOneChattingCampaignSchedules,
    runScheduleNow,
};
