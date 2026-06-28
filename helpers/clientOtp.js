export const DEFAULT_CLIENT_OTP = "123456";

export async function generateClientOtp() {
    return DEFAULT_CLIENT_OTP;
}

export async function sendClientOtp({ country_code, mobile, otp }) {
    // country_code is digits only (e.g. 91), without "+"
    const cc = String(country_code || "").replace(/\D/g, "");
    // TODO: integrate real SMS provider
    console.log(`[CLIENT OTP] ${cc}${mobile}: ${otp}`);
    return { success: true };
}
