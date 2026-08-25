import axios from "axios";
import { normalizeFast2SmsRoute } from "./fast2sms.js";

export const FAST2SMS_API_URL =
    process.env.FAST2SMS_API_URL || "https://www.fast2sms.com/dev/bulkV2";

export const FAST2SMS_WALLET_URL =
    process.env.FAST2SMS_WALLET_URL || "https://www.fast2sms.com/dev/wallet";

/**
 * Send SMS via Fast2SMS bulkV2 (GET query params + Authorization header).
 * @param {object} opts
 * @param {string} opts.authToken
 * @param {string} opts.route
 * @param {string|string[]} opts.numbers - 10-digit mobiles
 * @param {string} [opts.senderId]
 * @param {string} [opts.message] - DLT message id OR plain text (q / dlt_manual)
 * @param {string} [opts.variablesValues] - pipe-separated vars for dlt/otp
 * @param {string} [opts.entityId]
 * @param {string} [opts.scheduleTime]
 */
export async function sendFast2Sms({
    authToken,
    route,
    numbers,
    senderId,
    message,
    variablesValues,
    entityId,
    scheduleTime,
} = {}) {
    const token = String(authToken || "").trim();
    if (!token) {
        throw new Error("Fast2SMS authorization token is required");
    }

    const resolvedRoute = normalizeFast2SmsRoute(route);
    const numberList = (Array.isArray(numbers) ? numbers : String(numbers || "").split(","))
        .map((n) => String(n || "").replace(/\D/g, "").slice(-10))
        .filter((n) => n.length === 10);

    if (!numberList.length) {
        throw new Error("At least one valid 10-digit mobile number is required");
    }

    const params = {
        route: resolvedRoute,
        numbers: numberList.join(","),
    };

    if (senderId) params.sender_id = String(senderId).trim().toUpperCase();
    if (message != null && String(message).trim() !== "") {
        params.message = String(message).trim();
    }
    if (variablesValues != null && String(variablesValues).trim() !== "") {
        params.variables_values = String(variablesValues).trim();
    }
    if (entityId && resolvedRoute === "dlt_manual") {
        params.entity_id = String(entityId).trim();
    }
    if (scheduleTime) {
        params.schedule_time = String(scheduleTime).trim();
    }

    if (resolvedRoute === "dlt" || resolvedRoute === "otp") {
        if (!params.message) throw new Error("DLT message ID is required");
        if (!params.sender_id) throw new Error("Sender ID is required for DLT route");
    } else if (resolvedRoute === "dlt_manual") {
        if (!params.message) throw new Error("Approved message text is required");
        if (!params.sender_id) throw new Error("Sender ID is required for DLT Manual");
    } else if (resolvedRoute === "q") {
        if (!params.message) throw new Error("Message text is required for Quick SMS");
    }

    const response = await axios.get(FAST2SMS_API_URL, {
        headers: { Authorization: token },
        params,
        timeout: 60000,
        validateStatus: () => true,
    });

    const data = response.data || {};
    const ok = data.return === true || data.return === "true";
    if (!ok) {
        const msg = Array.isArray(data.message)
            ? data.message.join(", ")
            : data.message || data.error || `Fast2SMS error (HTTP ${response.status})`;
        const err = new Error(String(msg));
        err.provider = data;
        err.status = response.status;
        throw err;
    }

    return {
        request_id: data.request_id || null,
        message: data.message,
        raw: data,
        numbers: numberList,
    };
}

export async function fetchFast2SmsWallet(authToken) {
    const token = String(authToken || "").trim();
    if (!token) throw new Error("Fast2SMS authorization token is required");

    const response = await axios.get(FAST2SMS_WALLET_URL, {
        headers: { Authorization: token },
        timeout: 30000,
        validateStatus: () => true,
    });

    return response.data;
}
