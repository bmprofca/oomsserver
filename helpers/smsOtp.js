import "dotenv/config";
import pool from "../db.js";
import { decrypt } from "../utils/smtpEncryption.js";
import { normalizeMobileDigits } from "./clientPhone.js";
import { normalizeFast2SmsRoute } from "./fast2sms.js";
import { sendFast2Sms } from "./fast2smsSend.js";

/**
 * SMS architecture (two tiers):
 *
 * 1) Company / platform SMS  → login, register, portal OTP, account contact OTP
 *    Source: `sms_company_fast2sms_config` (DB) OR SERVER .env fallback
 *
 * 2) Branch SMS              → client / user notifications for that branch
 *    Source: `branch_list.sms_channel` + `sms_fast2sms_configs`
 *
 * Login OTP must NEVER use a branch Fast2SMS key.
 */

function envCompanyConfig() {
    const authToken = String(process.env.FAST2SMS_AUTH_TOKEN || "").trim();
    const senderId = String(
        process.env.FAST2SMS_SENDER_ID || process.env.SMS_OTP_SENDER_ID || ""
    )
        .trim()
        .toUpperCase();
    const route = normalizeFast2SmsRoute(
        process.env.SMS_OTP_ROUTE || process.env.FAST2SMS_DEFAULT_ROUTE || "dlt"
    );
    const otpMessageId = String(
        process.env.SMS_OTP_DLT_TEMPLATE_ID || process.env.SMS_OTP_MESSAGE_ID || ""
    ).trim();
    const entityId = String(process.env.FAST2SMS_ENTITY_ID || "").trim();

    return {
        source: "env",
        authToken,
        senderId,
        entityId,
        route,
        otpMessageId,
        configured: Boolean(
            authToken && (route === "q" || (otpMessageId && senderId))
        ),
    };
}

async function dbCompanyConfig() {
    try {
        const [rows] = await pool.query(
            `SELECT config_id, auth_token_encrypted, sender_id, entity_id, route,
                    otp_dlt_message_id, status
             FROM sms_company_fast2sms_config
             WHERE status = 'active'
             ORDER BY id DESC
             LIMIT 1`
        );
        const row = rows[0];
        if (!row?.auth_token_encrypted) return null;

        const authToken = decrypt(row.auth_token_encrypted);
        if (!authToken) return null;

        const route = normalizeFast2SmsRoute(row.route);
        const senderId = String(row.sender_id || "").trim().toUpperCase();
        const otpMessageId = String(row.otp_dlt_message_id || "").trim();
        const entityId = String(row.entity_id || "").trim();

        return {
            source: "database",
            config_id: row.config_id,
            authToken,
            senderId,
            entityId,
            route,
            otpMessageId,
            configured: Boolean(
                authToken && (route === "q" || (otpMessageId && senderId))
            ),
        };
    } catch (error) {
        // Table may not exist yet during rollout — fall back to env.
        if (error?.code === "ER_NO_SUCH_TABLE") return null;
        console.error("COMPANY SMS CONFIG DB READ ERROR:", error?.message || error);
        return null;
    }
}

/**
 * Resolve company Fast2SMS for OTP: DB active row first, then .env.
 */
export async function resolveCompanySmsConfig() {
    const fromDb = await dbCompanyConfig();
    if (fromDb?.configured) return fromDb;

    const fromEnv = envCompanyConfig();
    if (fromEnv.configured) return fromEnv;

    // Return best partial for clearer errors
    return fromDb || fromEnv;
}

/** Sync env-only peek (tests / health). Prefer resolveCompanySmsConfig() for sends. */
export function getSystemSmsOtpConfig() {
    return envCompanyConfig();
}

/**
 * Send OTP via company SMS (DB or env). Not branch config.
 */
export async function sendSmsOtp({ mobile, otp, country_code } = {}) {
    const normalizedMobile = normalizeMobileDigits(mobile);
    if (!normalizedMobile || normalizedMobile.length !== 10) {
        throw new Error("A valid 10-digit mobile number is required to send OTP.");
    }

    const otpValue = String(otp || "").trim();
    if (!otpValue) {
        throw new Error("OTP value is required.");
    }

    const config = await resolveCompanySmsConfig();

    if (!config.authToken) {
        throw new Error(
            "Company SMS is not configured. Set sms_company_fast2sms_config or FAST2SMS_AUTH_TOKEN in .env."
        );
    }
    if (!config.otpMessageId && config.route !== "q") {
        throw new Error(
            "Company OTP template is not configured (otp_dlt_message_id / SMS_OTP_DLT_TEMPLATE_ID)."
        );
    }
    if (!config.senderId && config.route !== "q") {
        throw new Error(
            "Company SMS sender ID is not configured (sender_id / FAST2SMS_SENDER_ID)."
        );
    }

    const message =
        config.route === "q"
            ? `Your ${process.env.APP_NAME || "OOMS"} OTP is ${otpValue}. Valid for 5 minutes.`
            : config.otpMessageId;

    return sendFast2Sms({
        authToken: config.authToken,
        route: config.route,
        numbers: [normalizedMobile],
        senderId: config.senderId,
        message,
        variablesValues: config.route === "q" ? undefined : otpValue,
        entityId: config.entityId,
        country_code,
    });
}
