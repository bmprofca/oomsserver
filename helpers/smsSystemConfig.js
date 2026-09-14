import pool from "../db.js";
import { encrypt, decrypt } from "../utils/smtpEncryption.js";
import { UNIQUE_RANDOM_STRING } from "./function.js";
import { normalizeFast2SmsRoute, maskFast2SmsAuthToken } from "./fast2sms.js";

/**
 * Platform Fast2SMS config for OOMS System SMS channel only.
 * OTP continues to use sms_company_fast2sms_config / env.
 */

export async function getSystemSmsConfigRow() {
    try {
        const [rows] = await pool.query(
            `SELECT config_id, auth_token_encrypted, sender_id, entity_id, route,
                    status, create_date, modify_date
             FROM sms_system_fast2sms_config
             ORDER BY id DESC
             LIMIT 1`
        );
        return rows[0] || null;
    } catch (error) {
        if (error?.code === "ER_NO_SUCH_TABLE") return null;
        throw error;
    }
}

export function serializeSystemSmsConfig(row, { includeToken = false } = {}) {
    if (!row) {
        return {
            configured: false,
            status: "inactive",
            sender_id: "",
            entity_id: "",
            route: "dlt",
            auth_token_masked: "",
        };
    }
    const authToken = row.auth_token_encrypted
        ? decrypt(row.auth_token_encrypted)
        : "";
    return {
        config_id: row.config_id,
        sender_id: row.sender_id || "",
        entity_id: row.entity_id || "",
        route: normalizeFast2SmsRoute(row.route),
        status: row.status || "active",
        configured: Boolean(authToken),
        auth_token_masked: maskFast2SmsAuthToken(authToken),
        auth_token: includeToken ? authToken : undefined,
        create_date: row.create_date || null,
        modify_date: row.modify_date || null,
    };
}

/** Active decrypted config for sends. Returns null if missing/inactive. */
export async function resolveSystemSmsConfigForSend() {
    const row = await getSystemSmsConfigRow();
    if (!row || String(row.status || "").toLowerCase() !== "active") {
        return null;
    }
    const authToken = row.auth_token_encrypted
        ? decrypt(row.auth_token_encrypted)
        : "";
    if (!authToken) return null;
    return {
        config_id: row.config_id,
        auth_token: authToken,
        sender_id: String(row.sender_id || "").trim().toUpperCase(),
        entity_id: String(row.entity_id || "").trim(),
        route: normalizeFast2SmsRoute(row.route),
        status: row.status,
    };
}

export async function upsertSystemSmsConfig(body = {}, actor = null) {
    const existing = await getSystemSmsConfigRow();
    const sender_id = String(body.sender_id || "").trim().toUpperCase() || null;
    const entity_id = String(body.entity_id || "").trim() || null;
    const route = normalizeFast2SmsRoute(body.route || existing?.route || "dlt");
    const status =
        body.status != null && String(body.status).trim()
            ? String(body.status).trim().toLowerCase()
            : existing?.status || "active";

    if (!["active", "inactive"].includes(status)) {
        throw Object.assign(new Error("status must be active or inactive"), {
            status: 400,
        });
    }

    let auth_token_encrypted = existing?.auth_token_encrypted || null;
    if (body.auth_token != null && String(body.auth_token).trim() !== "") {
        auth_token_encrypted = encrypt(String(body.auth_token).trim());
    }

    if (!auth_token_encrypted) {
        throw Object.assign(new Error("auth_token is required"), { status: 400 });
    }

    if (existing?.config_id) {
        await pool.query(
            `UPDATE sms_system_fast2sms_config
             SET auth_token_encrypted = ?, sender_id = ?, entity_id = ?, route = ?,
                 status = ?, modify_by = ?, modify_date = CURRENT_TIMESTAMP
             WHERE config_id = ?`,
            [
                auth_token_encrypted,
                sender_id,
                entity_id,
                route,
                status,
                actor,
                existing.config_id,
            ]
        );
        return serializeSystemSmsConfig(await getSystemSmsConfigRow());
    }

    const config_id = await UNIQUE_RANDOM_STRING(
        "sms_system_fast2sms_config",
        "config_id",
        { prefix: "ssfc" }
    );
    await pool.query(
        `INSERT INTO sms_system_fast2sms_config
         (config_id, auth_token_encrypted, sender_id, entity_id, route, status, create_by, modify_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            config_id,
            auth_token_encrypted,
            sender_id,
            entity_id,
            route,
            status,
            actor,
            actor,
        ]
    );
    return serializeSystemSmsConfig(await getSystemSmsConfigRow());
}
