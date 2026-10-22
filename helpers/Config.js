import "dotenv/config";
import { DSC_COMPANY_SEED as DSC_COMPANIES, DSC_TYPE_SEED as DSC_TYPES } from "./dscCatalog.js";
import { getPlatformSetting } from "./platformSettings.js";

const APP_NAME = process.env.APP_NAME || "OOMS";
const BASE_DOMAIN = process.env.BASE_DOMAIN || "https://server.ooms.in";

/**
 * Google OAuth client ID and the invitation base link are platform settings
 * (ADMIN → Settings → Platform Settings), not .env values. Read them at call time
 * so admin changes apply without a restart.
 */
function getGoogleClientId() {
    return String(getPlatformSetting("GOOGLE_CLIENT_ID") || "").trim();
}

function getInvitationBaseLink() {
    return String(getPlatformSetting("BASE_INVITATION_LINK") || "").trim().replace(/\/+$/, "");
}

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
    APP_NAME,
    getGoogleClientId,
    getInvitationBaseLink,
    DOCUMENT_RESERVED_CATEGORIES,
    DSC_COMPANIES,
    DSC_TYPES,
};
