import "dotenv/config";

const APP_NAME = process.env.APP_NAME || "OOMS";
const BASE_DOMAIN = process.env.BASE_DOMAIN || "https://server.ooms.in";
const GOOGLE_CLIENT_ID =
    process.env.GOOGLE_CLIENT_ID ||
    "706030491156-5rq848qm4eih47h29675u6pdv11m8kvq.apps.googleusercontent.com";
const BASE_INVITATION_LINK =
    process.env.BASE_INVITATION_LINK || "https://ooms-v4.vercel.com/invitation";

const FAST2SMS_API_URL =
    process.env.FAST2SMS_API_URL || "https://www.fast2sms.com/dev/bulkV2";
const FAST2SMS_AUTH_TOKEN = process.env.FAST2SMS_AUTH_TOKEN || "";
const FAST2SMS_SENDER_ID = process.env.FAST2SMS_SENDER_ID || "ONESAA";
const FAST2SMS_DEFAULT_ROUTE = process.env.FAST2SMS_DEFAULT_ROUTE || "dlt";
const SMS_OTP_ROUTE = process.env.SMS_OTP_ROUTE || "otp";
const SMS_OTP_DLT_TEMPLATE_ID = process.env.SMS_OTP_DLT_TEMPLATE_ID || "";

function maskFast2SmsAuthToken(token = FAST2SMS_AUTH_TOKEN) {
    const value = String(token || "").trim();
    if (!value) return "";
    if (value.length <= 4) return "****";
    return `${value.slice(0, 4)}********************`;
}

const FAST2SMS_AUTH_TOKEN_MASKED = maskFast2SmsAuthToken();

const DSC_TYPES = [
    {
        name: "Class 3 DSC",
        value: "class_3_dsc",
    },
];

const DSC_COMPANIES = [
    {
        name: "OneSaaS Technologies Private Limited",
        value: "onesaas",
    },
];

const DOCUMENT_RESERVED_CATEGORIES = [
    {
        name: "GST",
        value: "gst",
    },
    {
        name: "MCA",
        value: "mca",
    },
    {
        name: "Income Tax",
        value: "it",
    },
    {
        name: "Task",
        value: "task",
    },
];

export {
    BASE_DOMAIN,
    GOOGLE_CLIENT_ID,
    APP_NAME,
    BASE_INVITATION_LINK,
    FAST2SMS_API_URL,
    FAST2SMS_AUTH_TOKEN,
    FAST2SMS_AUTH_TOKEN_MASKED,
    FAST2SMS_SENDER_ID,
    FAST2SMS_DEFAULT_ROUTE,
    SMS_OTP_ROUTE,
    SMS_OTP_DLT_TEMPLATE_ID,
    maskFast2SmsAuthToken,
    DOCUMENT_RESERVED_CATEGORIES,
    DSC_COMPANIES,
    DSC_TYPES,
};
