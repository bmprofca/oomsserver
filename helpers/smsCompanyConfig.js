import defaultStore from "./platformSettings.js";
import { normalizeFast2SmsRoute, maskFast2SmsAuthToken } from "./fast2sms.js";

/**
 * Company / platform Fast2SMS used for login, register, portal and contact OTPs.
 * Stored in `platform_settings` (FAST2SMS_* / SMS_OTP_* keys) and edited from
 * ADMIN → Settings → OTP SMS Config or the generic Platform Settings page. The legacy
 * `sms_company_fast2sms_config` table has been removed.
 *
 * Sending lives in helpers/smsOtp.js (resolveCompanySmsConfig); this file is the admin CRUD.
 * Branch notification SMS and the OOMS System SMS channel use different tables.
 */

function trimStr(value) {
    return value == null ? "" : String(value).trim();
}

export function isCompanySmsConfigured({ authToken, route, otpMessageId, senderId, status }) {
    if (trimStr(status).toLowerCase() === "inactive") return false;
    return Boolean(authToken && (route === "q" || (otpMessageId && senderId)));
}

export function serializeCompanySmsConfig(row) {
    if (!row) {
        return {
            configured: false,
            status: "inactive",
            sender_id: "",
            entity_id: "",
            route: "dlt",
            otp_dlt_message_id: "",
            auth_token_masked: "",
            has_auth_token: false,
        };
    }
    const authToken = trimStr(row.auth_token);
    const route = normalizeFast2SmsRoute(row.route);
    const otpMessageId = trimStr(row.otp_dlt_message_id);
    const senderId = trimStr(row.sender_id).toUpperCase();
    const status = trimStr(row.status).toLowerCase() === "inactive" ? "inactive" : "active";
    return {
        sender_id: senderId,
        entity_id: trimStr(row.entity_id),
        route,
        otp_dlt_message_id: otpMessageId,
        status,
        configured: isCompanySmsConfigured({ authToken, route, otpMessageId, senderId, status }),
        has_auth_token: Boolean(authToken),
        auth_token_masked: maskFast2SmsAuthToken(authToken),
        source: row.source || null,
        modify_by: row.modify_by || null,
        modify_date: row.modify_date || null,
    };
}

export function createCompanySmsConfig(store = defaultStore) {
    /** Row-like view of the OTP SMS keys, or null when nothing is set. */
    function rowFromStore() {
        const token = store.resolve("FAST2SMS_AUTH_TOKEN");
        const sender = store.resolve("FAST2SMS_SENDER_ID");
        const entity = store.resolve("FAST2SMS_ENTITY_ID");
        const route = store.resolve("SMS_OTP_ROUTE");
        const template = store.resolve("SMS_OTP_DLT_TEMPLATE_ID");
        const status = store.resolve("SMS_OTP_STATUS");

        if (!token.value && !sender.value && !template.value) return null;

        const metas = ["FAST2SMS_AUTH_TOKEN", "FAST2SMS_SENDER_ID", "SMS_OTP_DLT_TEMPLATE_ID", "SMS_OTP_ROUTE", "SMS_OTP_STATUS"]
            .map((k) => store.rowMeta(k))
            .filter((m) => m.modify_date)
            .sort((a, b) => String(b.modify_date).localeCompare(String(a.modify_date)));

        return {
            auth_token: token.value,
            sender_id: sender.value,
            entity_id: entity.value,
            route: normalizeFast2SmsRoute(route.value),
            otp_dlt_message_id: template.value,
            status: status.value || "active",
            source: token.source,
            modify_by: metas[0]?.modify_by || null,
            modify_date: metas[0]?.modify_date || null,
        };
    }

    async function getCompanySmsConfigRow() {
        await store.load();
        return rowFromStore();
    }

    /** Admin save. Blank auth_token keeps the stored token. */
    async function upsertCompanySmsConfig(body = {}, actor = null) {
        await store.load();
        const existing = rowFromStore();

        const sender_id = trimStr(body.sender_id ?? existing?.sender_id).toUpperCase();
        const entity_id = trimStr(body.entity_id ?? existing?.entity_id);
        const route = normalizeFast2SmsRoute(body.route || existing?.route || "dlt");
        const otp_dlt_message_id = trimStr(body.otp_dlt_message_id ?? existing?.otp_dlt_message_id);
        const status = trimStr(body.status) ? trimStr(body.status).toLowerCase() : existing?.status || "active";

        if (!["active", "inactive"].includes(status)) {
            throw Object.assign(new Error("status must be active or inactive"), { status: 400 });
        }

        const incomingToken = trimStr(body.auth_token);
        if (!incomingToken && !trimStr(existing?.auth_token)) {
            throw Object.assign(new Error("auth_token is required"), { status: 400 });
        }

        if (route !== "q") {
            if (!otp_dlt_message_id) {
                throw Object.assign(
                    new Error("otp_dlt_message_id is required for DLT routes (use Quick SMS route to skip)"),
                    { status: 400 }
                );
            }
            if (!sender_id) {
                throw Object.assign(new Error("sender_id is required for DLT routes"), { status: 400 });
            }
        }

        const values = {
            SMS_OTP_ROUTE: route,
            SMS_OTP_STATUS: status,
        };
        if (incomingToken) values.FAST2SMS_AUTH_TOKEN = incomingToken;
        const clear = [];
        for (const [key, value] of [
            ["FAST2SMS_SENDER_ID", sender_id],
            ["FAST2SMS_ENTITY_ID", entity_id],
            ["SMS_OTP_DLT_TEMPLATE_ID", otp_dlt_message_id],
        ]) {
            if (value) values[key] = value;
            else clear.push(key);
        }

        await store.update({ values, clear }, actor);
        return serializeCompanySmsConfig(rowFromStore());
    }

    return { getCompanySmsConfigRow, upsertCompanySmsConfig };
}

const api = createCompanySmsConfig();

export const getCompanySmsConfigRow = api.getCompanySmsConfigRow;
export const upsertCompanySmsConfig = api.upsertCompanySmsConfig;
