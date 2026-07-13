import { generateOtp, sendSmsOtp } from "./smsOtp.js";
import { normalizeCountryCode, normalizeMobileDigits } from "./clientPhone.js";

export async function generateClientOtp() {
    return generateOtp(6);
}

export async function sendClientOtp({ country_code, mobile, otp }) {
    const normalizedCountryCode = normalizeCountryCode(country_code || "+91");
    const normalizedMobile = normalizeMobileDigits(mobile);

    if (!normalizedMobile) {
        throw new Error("Mobile number is required to send OTP.");
    }

    await sendSmsOtp(normalizedMobile, String(otp));
    return { success: true, country_code: normalizedCountryCode, mobile: normalizedMobile };
}
