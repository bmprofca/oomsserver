import { normalizeMobileDigits } from "./clientPhone.js";
import { normalizeFast2SmsRoute } from "./fast2sms.js";
import { sendFast2Sms } from "./fast2smsSend.js";
import { getPlatformSetting } from "./platformSettings.js";
import { isCompanySmsConfigured } from "./smsCompanyConfig.js";

/**
 * SMS architecture (two tiers):
 *
 * 1) Company / platform SMS  → login, register, portal OTP, account contact OTP
 *    Source: platform_settings (FAST2SMS_AUTH_TOKEN, FAST2SMS_SENDER_ID, FAST2SMS_ENTITY_ID,
 *            SMS_OTP_ROUTE, SMS_OTP_DLT_TEMPLATE_ID, SMS_OTP_STATUS) — ADMIN → OTP SMS Config
 *
 * 2) Branch SMS              → client / user notifications for that branch
 *    Source: `branch_list.sms_channel` + `sms_fast2sms_configs`
 *
 * Login OTP must NEVER use a branch Fast2SMS key.
 */

function trimStr(value) {
    return value == null ? "" : String(value).trim();
}

/** Sync read of the company OTP SMS config from the platform-settings cache. */
export function getSystemSmsOtpConfig() {
    const authToken = trimStr(getPlatformSetting("FAST2SMS_AUTH_TOKEN"));
    const senderId = trimStr(getPlatformSetting("FAST2SMS_SENDER_ID")).toUpperCase();
    const entityId = trimStr(getPlatformSetting("FAST2SMS_ENTITY_ID"));
    const route = normalizeFast2SmsRoute(getPlatformSetting("SMS_OTP_ROUTE") || "dlt");
    const otpMessageId = trimStr(getPlatformSetting("SMS_OTP_DLT_TEMPLATE_ID"));
    const status = trimStr(getPlatformSetting("SMS_OTP_STATUS")).toLowerCase() === "inactive" ? "inactive" : "active";

    return {
        source: "platform_settings",
        authToken,
        senderId,
        entityId,
        route,
        otpMessageId,
        status,
        configured: isCompanySmsConfigured({ authToken, route, otpMessageId, senderId, status }),
    };
}

/** Resolve company Fast2SMS for OTP. Kept async for callers that await it. */
export async function resolveCompanySmsConfig() {
    return getSystemSmsOtpConfig();
}

/**
 * Send OTP via company SMS. Not branch config.
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

    if (config.status === "inactive") {
        throw new Error("OTP SMS is inactive. Enable it in Admin → Settings → OTP SMS Config.");
    }
    if (!config.authToken) {
        throw new Error(
            "Company SMS is not configured. Set the Fast2SMS authorization token in Admin → Settings → OTP SMS Config."
        );
    }
    if (!config.otpMessageId && config.route !== "q") {
        throw new Error("Company OTP template is not configured (OTP DLT message ID).");
    }
    if (!config.senderId && config.route !== "q") {
        throw new Error("Company SMS sender ID is not configured.");
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
