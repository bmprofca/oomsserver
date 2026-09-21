import pool from "../db.js";
import { UNIQUE_RANDOM_STRING } from "./function.js";
import { BASE_DOMAIN } from "./Config.js";

function trimStr(value) {
    return typeof value === "string" ? value.trim() : "";
}

function maskSecret(value) {
    const secret = trimStr(value);
    if (!secret) return "";
    if (secret.length <= 4) return "••••";
    return `••••${secret.slice(-4)}`;
}

export function detectRazorpayEnvironment(keyId) {
    const id = trimStr(keyId).toLowerCase();
    if (id.startsWith("rzp_live_")) return "live";
    if (id.startsWith("rzp_test_")) return "test";
    return "";
}

export function defaultRazorpayWebhookUrl() {
    const base = trimStr(BASE_DOMAIN || process.env.BASE_DOMAIN || "").replace(/\/$/, "");
    return base ? `${base}/api/v1/webhook/razorpay` : "";
}

export async function ensureRazorpayConfigTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS razorpay_platform_config (
          id INT NOT NULL AUTO_INCREMENT,
          config_id VARCHAR(50) NOT NULL,
          environment VARCHAR(10) NOT NULL DEFAULT 'test',
          key_id VARCHAR(100) NOT NULL DEFAULT '',
          key_secret VARCHAR(255) NOT NULL DEFAULT '',
          webhook_secret VARCHAR(255) NOT NULL DEFAULT '',
          webhook_url VARCHAR(500) NULL DEFAULT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'active',
          create_by VARCHAR(50) NULL DEFAULT NULL,
          create_date DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
          modify_by VARCHAR(50) NULL DEFAULT NULL,
          modify_date DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          UNIQUE KEY uk_razorpay_platform_config_id (config_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

export async function getRazorpayConfigRow() {
    try {
        await ensureRazorpayConfigTable();
        try {
            const [rows] = await pool.query(
                `SELECT config_id, environment, key_id, key_secret, webhook_secret,
                        webhook_url, status, gateway_fee_percent, gateway_fee_flat,
                        create_date, modify_date
                 FROM razorpay_platform_config
                 ORDER BY id DESC
                 LIMIT 1`
            );
            return rows[0] || null;
        } catch (error) {
            if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
            const [rows] = await pool.query(
                `SELECT config_id, environment, key_id, key_secret, webhook_secret,
                        webhook_url, status, create_date, modify_date
                 FROM razorpay_platform_config
                 ORDER BY id DESC
                 LIMIT 1`
            );
            return rows[0] || null;
        }
    } catch (error) {
        if (error?.code === "ER_NO_SUCH_TABLE") return null;
        throw error;
    }
}

/** Safe payload for admin GET (secrets masked). */
export function serializeRazorpayConfig(row) {
    if (!row) {
        return {
            configured: false,
            status: "inactive",
            environment: "test",
            key_id: "",
            key_secret_masked: "",
            webhook_secret_masked: "",
            webhook_url: defaultRazorpayWebhookUrl(),
            has_key_secret: false,
            has_webhook_secret: false,
            gateway_fee_percent: 0,
            gateway_fee_flat: 0,
        };
    }

    const key_id = trimStr(row.key_id);
    const key_secret = trimStr(row.key_secret);
    const webhook_secret = trimStr(row.webhook_secret);
    const environment =
        detectRazorpayEnvironment(key_id) ||
        (trimStr(row.environment).toLowerCase() === "live" ? "live" : "test");

    return {
        config_id: row.config_id,
        environment,
        key_id,
        key_secret_masked: maskSecret(key_secret),
        webhook_secret_masked: maskSecret(webhook_secret),
        webhook_url: trimStr(row.webhook_url) || defaultRazorpayWebhookUrl(),
        status: row.status || "active",
        configured: Boolean(key_id && key_secret),
        has_key_secret: Boolean(key_secret),
        has_webhook_secret: Boolean(webhook_secret),
        gateway_fee_percent: Number(row.gateway_fee_percent) || 0,
        gateway_fee_flat: Number(row.gateway_fee_flat) || 0,
        create_date: row.create_date || null,
        modify_date: row.modify_date || null,
    };
}

/**
 * Runtime config for payment APIs.
 * Prefers DB row; falls back to SERVER/.env when DB is empty.
 */
export async function resolveRazorpayRuntimeConfig() {
    const row = await getRazorpayConfigRow();
    const fromDb = row && String(row.status || "").toLowerCase() !== "inactive";

    const keyId = fromDb && trimStr(row.key_id)
        ? trimStr(row.key_id)
        : trimStr(process.env.RAZORPAY_KEY_ID);
    const keySecret = fromDb && trimStr(row.key_secret)
        ? trimStr(row.key_secret)
        : trimStr(process.env.RAZORPAY_KEY_SECRET);
    const webhookSecret = fromDb && trimStr(row.webhook_secret)
        ? trimStr(row.webhook_secret)
        : trimStr(process.env.RAZORPAY_WEBHOOK_SECRET);

    const environment =
        detectRazorpayEnvironment(keyId) ||
        (trimStr(process.env.RAZORPAY_ENVIRONMENT).toLowerCase() === "live" ? "live" : "test");

    const webhookUrl =
        (fromDb && trimStr(row?.webhook_url)) ||
        trimStr(process.env.RAZORPAY_WEBHOOK_URL) ||
        defaultRazorpayWebhookUrl();

    return {
        source: fromDb && trimStr(row?.key_id) && trimStr(row?.key_secret) ? "database" : "env",
        environment,
        isLive: environment === "live",
        keyId,
        keySecret,
        webhookSecret,
        webhookUrl,
        status: fromDb ? row.status || "active" : keyId && keySecret ? "active" : "inactive",
    };
}

export async function upsertRazorpayConfig(body = {}, actor = null) {
    await ensureRazorpayConfigTable();
    const existing = await getRazorpayConfigRow();

    const key_id = trimStr(body.key_id ?? existing?.key_id);
    if (!key_id) {
        const err = new Error("key_id is required");
        err.status = 400;
        throw err;
    }
    if (!key_id.toLowerCase().startsWith("rzp_test_") && !key_id.toLowerCase().startsWith("rzp_live_")) {
        const err = new Error("key_id must start with rzp_test_ or rzp_live_");
        err.status = 400;
        throw err;
    }

    const incomingSecret = trimStr(body.key_secret);
    const key_secret = incomingSecret || trimStr(existing?.key_secret);
    if (!key_secret) {
        const err = new Error("key_secret is required");
        err.status = 400;
        throw err;
    }

    const incomingWebhook = trimStr(body.webhook_secret);
    const webhook_secret = incomingWebhook || trimStr(existing?.webhook_secret) || "";

    const environment =
        detectRazorpayEnvironment(key_id) ||
        (trimStr(body.environment).toLowerCase() === "live" ? "live" : "test");

    const status =
        String(body.status || existing?.status || "active").toLowerCase() === "inactive"
            ? "inactive"
            : "active";

    const webhook_url =
        trimStr(body.webhook_url) ||
        trimStr(existing?.webhook_url) ||
        defaultRazorpayWebhookUrl() ||
        null;

    if (existing) {
        await pool.query(
            `UPDATE razorpay_platform_config
             SET environment = ?, key_id = ?, key_secret = ?, webhook_secret = ?,
                 webhook_url = ?, status = ?, modify_by = ?, modify_date = NOW()
             WHERE config_id = ?`,
            [
                environment,
                key_id,
                key_secret,
                webhook_secret,
                webhook_url,
                status,
                actor,
                existing.config_id,
            ]
        );
        return serializeRazorpayConfig({
            ...existing,
            environment,
            key_id,
            key_secret,
            webhook_secret,
            webhook_url,
            status,
        });
    }

    const config_id = await UNIQUE_RANDOM_STRING("razorpay_platform_config", "config_id", {
        length: 16,
    });
    await pool.query(
        `INSERT INTO razorpay_platform_config
            (config_id, environment, key_id, key_secret, webhook_secret, webhook_url, status, create_by, modify_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            config_id,
            environment,
            key_id,
            key_secret,
            webhook_secret,
            webhook_url,
            status,
            actor,
            actor,
        ]
    );

    return serializeRazorpayConfig({
        config_id,
        environment,
        key_id,
        key_secret,
        webhook_secret,
        webhook_url,
        status,
    });
}
