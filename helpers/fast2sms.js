export const FAST2SMS_ROUTES = ["dlt", "dlt_manual", "otp", "q"];

const ROUTE_ALIASES = {
    dlt: "dlt",
    dlt_manual: "dlt_manual",
    "dlt manual": "dlt_manual",
    otp: "otp",
    q: "q",
    quick: "q",
};

export function normalizeFast2SmsRoute(route) {
    const key = String(route || "").trim().toLowerCase();
    return ROUTE_ALIASES[key] || "dlt";
}

export function maskFast2SmsAuthToken(token) {
    const value = String(token || "").trim();
    if (!value) return "";
    if (value.length <= 4) return "****";
    return `${value.slice(0, 4)}${"*".repeat(Math.min(16, value.length - 4))}`;
}
