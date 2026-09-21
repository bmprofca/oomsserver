import pool from "../db.js";
import { UNIQUE_RANDOM_STRING } from "./function.js";

/**
 * Platform PBX API URL for OOMS System Call channel.
 * Branch stores its own x-api-key; staff store extensions.
 */

export async function getCallSystemConfigRow() {
    try {
        const [rows] = await pool.query(
            `SELECT config_id, api_base_url, status, create_date, modify_date
             FROM call_system_pbx_config
             ORDER BY id DESC
             LIMIT 1`
        );
        return rows[0] || null;
    } catch (error) {
        if (error?.code === "ER_NO_SUCH_TABLE") return null;
        throw error;
    }
}

export function serializeCallSystemConfig(row) {
    if (!row) {
        return {
            configured: false,
            status: "inactive",
            api_base_url: "",
        };
    }
    const api_base_url = String(row.api_base_url || "").trim();
    return {
        config_id: row.config_id,
        api_base_url,
        status: row.status || "active",
        configured: Boolean(api_base_url),
        create_date: row.create_date || null,
        modify_date: row.modify_date || null,
    };
}

/** Active config for outbound dials. Returns null if missing/inactive. */
export async function resolveCallSystemConfigForDial() {
    const row = await getCallSystemConfigRow();
    if (!row || String(row.status || "").toLowerCase() !== "active") {
        return null;
    }
    const api_base_url = String(row.api_base_url || "").trim().replace(/\/$/, "");
    if (!api_base_url) return null;
    return {
        config_id: row.config_id,
        api_base_url,
        status: row.status,
    };
}

export async function upsertCallSystemConfig(body = {}, actor = null) {
    const existing = await getCallSystemConfigRow();
    const api_base_url = String(body.api_base_url || "").trim().replace(/\/$/, "");
    if (!api_base_url) {
        const err = new Error("api_base_url is required");
        err.status = 400;
        throw err;
    }
    try {
        // eslint-disable-next-line no-new
        new URL(api_base_url);
    } catch {
        const err = new Error("api_base_url must be a valid URL");
        err.status = 400;
        throw err;
    }

    const status =
        String(body.status || existing?.status || "active").toLowerCase() === "inactive"
            ? "inactive"
            : "active";

    if (existing) {
        await pool.query(
            `UPDATE call_system_pbx_config
             SET api_base_url = ?, status = ?, modify_by = ?, modify_date = NOW()
             WHERE config_id = ?`,
            [api_base_url, status, actor, existing.config_id]
        );
        return serializeCallSystemConfig({
            ...existing,
            api_base_url,
            status,
        });
    }

    const config_id = await UNIQUE_RANDOM_STRING("call_system_pbx_config", "config_id", {
        length: 16,
    });
    await pool.query(
        `INSERT INTO call_system_pbx_config
            (config_id, api_base_url, status, create_by, modify_by)
         VALUES (?, ?, ?, ?, ?)`,
        [config_id, api_base_url, status, actor, actor]
    );
    return serializeCallSystemConfig({
        config_id,
        api_base_url,
        status,
    });
}
