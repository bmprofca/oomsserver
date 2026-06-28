import "dotenv/config";

const APP_NAME = process.env.APP_NAME || "OOMS";
const BASE_DOMAIN = process.env.BASE_DOMAIN || "https://server.ooms.in";
const GOOGLE_CLIENT_ID =
    process.env.GOOGLE_CLIENT_ID ||
    "706030491156-5rq848qm4eih47h29675u6pdv11m8kvq.apps.googleusercontent.com";
const BASE_INVITATION_LINK =
    process.env.BASE_INVITATION_LINK || "https://ooms-v4.vercel.com/invitation";

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
    DOCUMENT_RESERVED_CATEGORIES,
    DSC_COMPANIES,
    DSC_TYPES,
};
