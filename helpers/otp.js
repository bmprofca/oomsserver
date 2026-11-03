import { RANDOM_INTEGER } from "./function.js";

/** Shared CLIENT_WEB demo office account (see database/scripts/seed-demo-office-account.js). */
export const DEMO_OFFICE_MOBILE = "9999999999";
export const DEMO_OFFICE_OTP = "123456";

export function generateOtp(length = 6) {
    return String(RANDOM_INTEGER(length));
}

/** Normalize to last 10 digits for India mobile comparisons. */
export function normalizeOtpMobile(mobile) {
    return String(mobile || "").replace(/\D/g, "").slice(-10);
}

/** Fixed OTP for the shared demo mobile; otherwise a random OTP. */
export function resolveLoginOtp(mobile, length = 6) {
    if (normalizeOtpMobile(mobile) === DEMO_OFFICE_MOBILE) {
        return DEMO_OFFICE_OTP;
    }
    return generateOtp(length);
}

export function isDemoOfficeMobile(mobile) {
    return normalizeOtpMobile(mobile) === DEMO_OFFICE_MOBILE;
}
