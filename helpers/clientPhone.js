export function normalizeCountryCode(country_code) {
    const digits = String(country_code ?? "").trim().replace(/\D/g, "");
    return digits || "91";
}

export function normalizeMobileDigits(mobile) {
    const digits = String(mobile || "").replace(/\D/g, "");
    return digits.length >= 10 ? digits.slice(-10) : digits;
}

export const PROFILE_MOBILE_SQL =
    "RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(p.mobile, ' ', ''), '-', ''), '+', ''), '(', ''), 10)";

export const PROFILE_COUNTRY_CODE_SQL =
    "REPLACE(REPLACE(REPLACE(p.country_code, '+', ''), ' ', ''), '-', '')";
