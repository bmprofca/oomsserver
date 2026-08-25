import { generateOtp } from "./otp.js";
import { normalizeCountryCode, normalizeMobileDigits } from "./clientPhone.js";
import { sendSmsOtp } from "./smsOtp.js";

export async function generateClientOtp() {
    return generateOtp(6);
}

export async function sendClientOtp({ country_code, mobile, otp }) {
    const normalizedCountryCode = normalizeCountryCode(country_code || "+91");
    const normalizedMobile = normalizeMobileDigits(mobile);

    if (!normalizedMobile) {
        throw new Error("Mobile number is required to send OTP.");
    }

    return sendSmsOtp({
        country_code: normalizedCountryCode,
        mobile: normalizedMobile,
        otp,
    });
}
