import axios from "axios";
import pool from "../db.js";
import { decrypt } from "../utils/smsEncryption.js";
import { RANDOM_INTEGER } from "./function.js";
import {
    FAST2SMS_API_URL,
    FAST2SMS_AUTH_TOKEN,
    FAST2SMS_SENDER_ID,
    SMS_OTP_ROUTE,
    SMS_OTP_DLT_TEMPLATE_ID,
} from "./Config.js";

export function generateOtp(length = 6) {
    return String(RANDOM_INTEGER(length));
}

function normalizeOtpValue(otp) {
    const value = String(otp ?? "").trim();
    if (!/^\d{4,10}$/.test(value)) {
        throw new Error("A valid numeric OTP is required to send SMS.");
    }
    return value;
}

/** Fast2SMS DLT expects pipe-separated values; project broadcast code uses a trailing pipe. */
function formatDltVariablesValues(...values) {
    const normalized = values.map((value) => String(value ?? "").trim());
    if (normalized.some((value) => !value)) {
        throw new Error("All DLT template variables must have values.");
    }
    return `${normalized.join("|")}|`;
}

export async function sendSmsOtp(targetPhone, otp, { template_id, config_id } = {}) {
    const cleanNumber = String(targetPhone || "").replace(/\D/g, "");
    if (cleanNumber.length < 10) {
        throw new Error("A valid mobile number is required to send OTP.");
    }

    const otpValue = normalizeOtpValue(otp);

    if (!FAST2SMS_AUTH_TOKEN) {
        throw new Error("SMS OTP is not configured. Set FAST2SMS_AUTH_TOKEN in the server environment.");
    }

    let activeConfig = {
        auth_token: FAST2SMS_AUTH_TOKEN,
        sender_id: FAST2SMS_SENDER_ID,
        route: SMS_OTP_ROUTE,
    };
    let dltTemplateId = SMS_OTP_DLT_TEMPLATE_ID || null;

    if (config_id) {
        const [configs] = await pool.query(
            "SELECT * FROM sms_configs WHERE config_id = ? AND status = 'active' LIMIT 1",
            [config_id]
        );
        if (configs.length > 0) {
            activeConfig = {
                auth_token: decrypt(configs[0].auth_token_encrypted),
                sender_id: configs[0].sender_id || FAST2SMS_SENDER_ID,
                route: configs[0].route || SMS_OTP_ROUTE,
            };
        }
    }

    if (template_id) {
        const [templates] = await pool.query(
            "SELECT * FROM sms_templates WHERE template_id = ? AND status = 'active' LIMIT 1",
            [template_id]
        );
        if (templates.length > 0 && templates[0].dlt_template_id) {
            dltTemplateId = templates[0].dlt_template_id;
        }
    }

    const resolvedRoute = dltTemplateId ? "dlt" : (activeConfig.route || SMS_OTP_ROUTE);
    const smsPayload = {
        route: resolvedRoute,
        numbers: cleanNumber,
        flash: 0,
    };

    if (resolvedRoute === "dlt") {
        if (!dltTemplateId) {
            throw new Error("DLT template ID is required. Set SMS_OTP_DLT_TEMPLATE_ID in the server environment.");
        }
        smsPayload.sender_id = activeConfig.sender_id || FAST2SMS_SENDER_ID;
        smsPayload.message = String(dltTemplateId);
        smsPayload.variables_values = formatDltVariablesValues(otpValue);
    } else if (resolvedRoute === "otp") {
        smsPayload.variables_values = otpValue;
    } else {
        smsPayload.sender_id = activeConfig.sender_id || FAST2SMS_SENDER_ID;
        smsPayload.message = `Your OTP is ${otpValue}`;
    }

    const response = await axios.post(FAST2SMS_API_URL, smsPayload, {
        headers: {
            authorization: activeConfig.auth_token,
            "Content-Type": "application/json",
        },
        timeout: 10000,
    });

    if (!response.data?.return) {
        const providerMessage = Array.isArray(response.data?.message)
            ? response.data.message.join(", ")
            : response.data?.message;
        throw new Error(providerMessage || "Fast2SMS rejected the OTP SMS request.");
    }

    return {
        success: true,
        request_id: response.data?.request_id || null,
    };
}
