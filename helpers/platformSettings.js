import pool from "../db.js";
import { encryptSecret, decryptSecret, maskSecret } from "./secretBox.js";

/**
 * Platform settings: every integration URL, key and app-wide value that used to live in
 * SERVER/.env (and in the one-row tables razorpay_platform_config /
 * sms_company_fast2sms_config) is now stored in the `platform_settings` table and managed
 * from the ADMIN panel (Settings → Platform Settings, plus the Razorpay and OTP SMS pages
 * which are views over the same rows).
 *
 * Resolution order: database row → process.env (legacy fallback) → default, except
 * database-only definitions which never fall back to the environment.
 * Secrets are AES-256-GCM encrypted at rest (helpers/secretBox.js) and are never returned
 * in clear text by the admin API; only a masked hint is sent.
 *
 * Values are cached in memory so hot paths (GST maths, B2 uploads, WhatsApp sends, OTP SMS)
 * can read them synchronously. The cache is loaded at server start, refreshed after every
 * admin save in this process, and re-read in the background once it is older than
 * CACHE_TTL_MS, which also keeps the standalone worker process in sync.
 */

export const CACHE_TTL_MS = 60 * 1000;

const BASE_DOMAIN = String(process.env.BASE_DOMAIN || "https://server.ooms.in").trim().replace(/\/+$/, "");

export const PLATFORM_SETTING_GROUPS = [
    {
        key: "application",
        label: "Application",
        description: "App-wide values used by login, invitations and tax calculation.",
    },
    {
        key: "google_calendar",
        label: "Google Calendar appointments",
        description: "Server-side OAuth credentials for the calendar that organizes appointment invitations.",
    },
    {
        key: "storage",
        label: "Backblaze B2 storage",
        description: "Bucket used for client documents, profile images, logos and signatures.",
    },
    {
        key: "razorpay",
        label: "Razorpay payment gateway",
        description: "Platform Razorpay keys used for subscriptions and wallet top-ups, plus the fee added to wallet recharges.",
    },
    {
        key: "otp_sms",
        label: "Fast2SMS (OTP SMS)",
        description: "Platform Fast2SMS account used for login, registration, portal and contact-change OTPs. Branch notification SMS is configured per office.",
    },
    {
        key: "onechatting",
        label: "OneChatting (OOMS System WhatsApp)",
        description: "Platform-level OneChatting API used by the OOMS System WhatsApp channel and live chat.",
    },
    {
        key: "whatsapp_web",
        label: "WhatsApp Web gateway",
        description: "Upstream WhatsApp Web V2 gateway used by the OOMS Web channel (QR / pairing-code sessions).",
    },
    {
        key: "onesaas",
        label: "OneSaaS file upload",
        description: "Public upload endpoint used for wallet invoice PDFs and shared files.",
    },
];

export const ACTIVE_INACTIVE = [
    { value: "active", label: "Active" },
    { value: "inactive", label: "Inactive" },
];

export const FAST2SMS_ROUTE_OPTIONS = [
    { value: "dlt", label: "DLT (template ID)" },
    { value: "dlt_manual", label: "DLT Manual (approved text)" },
    { value: "otp", label: "OTP" },
    { value: "q", label: "Quick SMS (no DLT)" },
];

/**
 * type: text | url | secret | number | select
 * env: legacy SERVER/.env name (fallback only; defaults to the key)
 * envAliases: further legacy env names checked after `env`
 * databaseOnly: never resolve a value from the environment
 * options: for type select — [{ value, label }]
 * uppercase: normalise text to upper case
 * validate(value): throw { status: 400 } for a custom rule
 */
export const PLATFORM_SETTING_DEFS = [
    {
        key: "GOOGLE_CLIENT_ID",
        group: "application",
        label: "Google OAuth client ID",
        type: "text",
        default: "",
        description: "Audience used to verify Google sign-in ID tokens on /auth/google.",
    },
    {
        key: "GOOGLE_CALENDAR_CLIENT_ID",
        group: "google_calendar",
        label: "OAuth client ID",
        type: "secret",
        default: "",
        databaseOnly: true,
        description: "OAuth client authorized for the Google Calendar Events API. Stored encrypted and never returned to the browser.",
    },
    {
        key: "GOOGLE_CALENDAR_CLIENT_SECRET",
        group: "google_calendar",
        label: "OAuth client secret",
        type: "secret",
        default: "",
        databaseOnly: true,
        description: "OAuth client secret. Stored encrypted and never returned to the browser.",
    },
    {
        key: "GOOGLE_CALENDAR_REFRESH_TOKEN",
        group: "google_calendar",
        label: "Organizer refresh token",
        type: "secret",
        default: "",
        databaseOnly: true,
        description: "Offline refresh token for the shared organizer account, with the calendar.events scope. Stored encrypted.",
    },
    {
        key: "GOOGLE_CALENDAR_ID",
        group: "google_calendar",
        label: "Organizer calendar ID",
        type: "text",
        default: "primary",
        databaseOnly: true,
        description: "Google Calendar ID to create appointment events on. Use primary for the connected organizer account's primary calendar.",
    },
    {
        key: "BASE_INVITATION_LINK",
        group: "application",
        label: "Invitation base link",
        type: "url",
        default: "https://ooms-v4.vercel.com/invitation",
        description: "Office-panel URL that staff and admin invitation tokens are appended to.",
    },
    {
        key: "TAX_RATE",
        group: "application",
        label: "GST rate (%)",
        type: "number",
        default: "18",
        min: 0,
        max: 100,
        description: "GST percentage applied when a branch has GST enabled. Changing it affects new entries only.",
    },
    {
        key: "B2_BUCKET",
        group: "storage",
        label: "Bucket name",
        type: "text",
        default: "OOMS-CRM",
        description: "Backblaze B2 bucket name.",
    },
    {
        key: "B2_ACCESS_KEY",
        group: "storage",
        label: "Application key ID",
        type: "secret",
        default: "",
        description: "Backblaze application key ID (keyID).",
    },
    {
        key: "B2_SECRET_KEY",
        group: "storage",
        label: "Application key",
        type: "secret",
        default: "",
        description: "Backblaze application key secret.",
    },
    {
        key: "B2_DOWNLOAD_AUTH_TTL_SECONDS",
        group: "storage",
        label: "Download link validity (seconds)",
        type: "number",
        default: "86400",
        min: 60,
        max: 604800,
        description: "How long signed download URLs stay valid. B2 allows at most 7 days.",
    },
    {
        key: "RAZORPAY_KEY_ID",
        group: "razorpay",
        label: "Key ID",
        type: "text",
        default: "",
        description: "Razorpay API Key ID (rzp_test_… or rzp_live_…). The environment is detected from this prefix.",
        validate(value) {
            const id = value.toLowerCase();
            if (!id.startsWith("rzp_test_") && !id.startsWith("rzp_live_")) {
                throw Object.assign(new Error("Razorpay Key ID must start with rzp_test_ or rzp_live_"), { status: 400 });
            }
        },
    },
    {
        key: "RAZORPAY_KEY_SECRET",
        group: "razorpay",
        label: "Key secret",
        type: "secret",
        default: "",
        description: "API Key Secret from Razorpay Dashboard → Settings → API Keys (not the webhook secret).",
    },
    {
        key: "RAZORPAY_WEBHOOK_SECRET",
        group: "razorpay",
        label: "Webhook secret",
        type: "secret",
        default: "",
        description: "Secret configured on the Razorpay webhook; used to verify payment webhooks.",
    },
    {
        key: "RAZORPAY_WEBHOOK_URL",
        group: "razorpay",
        label: "Webhook URL",
        type: "url",
        default: BASE_DOMAIN ? `${BASE_DOMAIN}/api/v1/webhook/razorpay` : "",
        description: "URL to register in the Razorpay dashboard. Defaults to this server's webhook endpoint.",
    },
    {
        key: "RAZORPAY_STATUS",
        group: "razorpay",
        label: "Gateway status",
        type: "select",
        options: ACTIVE_INACTIVE,
        default: "active",
        description: "Inactive disables Razorpay checkout; manual payment requests keep working.",
    },
    {
        key: "RAZORPAY_GATEWAY_FEE_PERCENT",
        group: "razorpay",
        label: "Gateway fee (%)",
        type: "number",
        default: "0",
        min: 0,
        max: 100,
        description: "Percentage fee added to the net wallet credit on Razorpay top-ups.",
    },
    {
        key: "RAZORPAY_GATEWAY_FEE_FLAT",
        group: "razorpay",
        label: "Gateway fee (flat ₹)",
        type: "number",
        default: "0",
        min: 0,
        description: "Flat fee in INR added to every Razorpay top-up.",
    },
    {
        key: "FAST2SMS_API_URL",
        group: "otp_sms",
        label: "Fast2SMS API URL",
        type: "url",
        default: "https://www.fast2sms.com/dev/bulkV2",
        description: "bulkV2 send endpoint used for every Fast2SMS send (OTP, branch and system SMS).",
    },
    {
        key: "FAST2SMS_WALLET_URL",
        group: "otp_sms",
        label: "Fast2SMS wallet URL",
        type: "url",
        default: "https://www.fast2sms.com/dev/wallet",
        description: "Endpoint used to read a Fast2SMS account balance.",
    },
    {
        key: "FAST2SMS_AUTH_TOKEN",
        group: "otp_sms",
        label: "Authorization token",
        type: "secret",
        default: "",
        description: "Fast2SMS API authorization key for the platform OTP account.",
    },
    {
        key: "FAST2SMS_SENDER_ID",
        group: "otp_sms",
        label: "Sender ID",
        type: "text",
        uppercase: true,
        default: "",
        envAliases: ["SMS_OTP_SENDER_ID"],
        description: "DLT-approved 6-letter sender ID. Required for DLT routes.",
    },
    {
        key: "FAST2SMS_ENTITY_ID",
        group: "otp_sms",
        label: "DLT entity ID",
        type: "text",
        default: "",
        description: "Principal entity ID; sent only on the DLT Manual route.",
    },
    {
        key: "SMS_OTP_ROUTE",
        group: "otp_sms",
        label: "OTP route",
        type: "select",
        options: FAST2SMS_ROUTE_OPTIONS,
        default: "dlt",
        envAliases: ["FAST2SMS_DEFAULT_ROUTE"],
        description: "Fast2SMS route used for OTP messages.",
    },
    {
        key: "SMS_OTP_DLT_TEMPLATE_ID",
        group: "otp_sms",
        label: "OTP DLT message ID",
        type: "text",
        default: "",
        envAliases: ["SMS_OTP_MESSAGE_ID"],
        description: "Approved template with exactly one variable, which receives the OTP. Not used on the Quick SMS route.",
    },
    {
        key: "SMS_OTP_STATUS",
        group: "otp_sms",
        label: "OTP SMS status",
        type: "select",
        options: ACTIVE_INACTIVE,
        default: "active",
        description: "Inactive stops OTP SMS sends (users cannot log in with mobile OTP).",
    },
    {
        key: "ONECHATTING_BASE_URL",
        group: "onechatting",
        label: "API base URL",
        type: "url",
        default: "https://server.onechatting.com",
        description: "OneChatting developer API base, without a trailing slash.",
    },
    {
        key: "ONECHATTING_SYSTEM_DEVELOPER_TOKEN",
        group: "onechatting",
        label: "System developer token",
        type: "secret",
        default: "",
        description: "Token used to send OOMS System WhatsApp template messages.",
    },
    {
        key: "ONECHATTING_PROJECT_DEVELOPER_TOKEN",
        group: "onechatting",
        label: "Project developer token",
        type: "secret",
        default: "",
        description: "Token used to list and import approved templates into OOMS System WhatsApp.",
    },
    {
        key: "WHATSAPPWEB_BASE_URL",
        group: "whatsapp_web",
        label: "Gateway base URL",
        type: "url",
        default: "",
        description: "WhatsApp Web V2 gateway base URL, without a trailing slash.",
    },
    {
        key: "WHATSAPPWEB_API_KEY",
        group: "whatsapp_web",
        label: "Gateway API key",
        type: "secret",
        default: "",
        description: "Sent as x-api-key on every gateway call.",
    },
    {
        key: "ONESAAS_UPLOAD_URL",
        group: "onesaas",
        label: "Upload endpoint",
        type: "url",
        default: "https://upload.onesaas.in/api/upload",
        description: "POST endpoint that accepts multipart uploads and returns a public URL.",
    },
    {
        key: "ONESAAS_UPLOAD_KEY",
        group: "onesaas",
        label: "Upload key",
        type: "secret",
        default: "",
        description: "Sent as the `key` header on uploads.",
    },
];

const DEF_BY_KEY = new Map(PLATFORM_SETTING_DEFS.map((d) => [d.key, d]));

function trimStr(value) {
    return value == null ? "" : String(value).trim();
}

export function getPlatformSettingDef(key) {
    return DEF_BY_KEY.get(String(key || "").trim()) || null;
}

/** Legacy env names that may hold a value for this definition, in priority order. */
export function envNamesFor(def) {
    if (def.databaseOnly) return [];
    return [def.env || def.key, ...(def.envAliases || [])];
}

/**
 * Validate and normalise one incoming value. Throws { status: 400 } on bad input.
 * Returns the string to store ("" means "clear").
 */
export function normalizeSettingValue(def, raw) {
    let value = trimStr(raw);
    if (!value) return "";
    switch (def.type) {
        case "url": {
            let parsed;
            try {
                parsed = new URL(value);
            } catch {
                throw Object.assign(new Error(`${def.label} must be a valid URL`), { status: 400 });
            }
            if (!/^https?:$/.test(parsed.protocol)) {
                throw Object.assign(new Error(`${def.label} must start with http:// or https://`), { status: 400 });
            }
            value = value.replace(/\/+$/, "");
            break;
        }
        case "number": {
            const num = Number(value);
            if (!Number.isFinite(num)) {
                throw Object.assign(new Error(`${def.label} must be a number`), { status: 400 });
            }
            if (def.min != null && num < def.min) {
                throw Object.assign(new Error(`${def.label} must be at least ${def.min}`), { status: 400 });
            }
            if (def.max != null && num > def.max) {
                throw Object.assign(new Error(`${def.label} must be at most ${def.max}`), { status: 400 });
            }
            value = String(num);
            break;
        }
        case "select": {
            const lowered = value.toLowerCase();
            const match = (def.options || []).find((o) => String(o.value).toLowerCase() === lowered);
            if (!match) {
                const allowed = (def.options || []).map((o) => o.value).join(", ");
                throw Object.assign(new Error(`${def.label} must be one of: ${allowed}`), { status: 400 });
            }
            value = String(match.value);
            break;
        }
        case "secret":
        case "text":
        default:
            if (value.length > 4000) {
                throw Object.assign(new Error(`${def.label} is too long`), { status: 400 });
            }
            if (def.uppercase) value = value.toUpperCase();
            break;
    }
    if (typeof def.validate === "function") def.validate(value);
    return value;
}

export const PLATFORM_SETTINGS_DDL = `
    CREATE TABLE IF NOT EXISTS platform_settings (
      setting_key VARCHAR(100) NOT NULL,
      setting_value TEXT NULL,
      is_secret TINYINT(1) NOT NULL DEFAULT 0,
      modify_by VARCHAR(50) NULL DEFAULT NULL,
      modify_date DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (setting_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/**
 * Factory so tests can inject a fake pool / env / clock.
 */
export function createPlatformSettingsStore({
    pool: db = pool,
    env = process.env,
    encrypt = encryptSecret,
    decrypt = decryptSecret,
    now = () => Date.now(),
    ttlMs = CACHE_TTL_MS,
    log = console,
} = {}) {
    /** key -> { value: string, modify_by, modify_date } for rows present in the DB */
    let dbValues = new Map();
    let loadedAt = 0;
    let loaded = false;
    let tableEnsured = false;
    let inflight = null;

    async function ensureTable() {
        if (tableEnsured) return;
        await db.query(PLATFORM_SETTINGS_DDL);
        tableEnsured = true;
    }

    async function load() {
        if (inflight) return inflight;
        inflight = (async () => {
            try {
                await ensureTable();
                const [rows] = await db.query(
                    `SELECT setting_key, setting_value, is_secret, modify_by, modify_date FROM platform_settings`
                );
                const next = new Map();
                for (const row of rows || []) {
                    const def = DEF_BY_KEY.get(row.setting_key);
                    if (!def) continue;
                    let value = trimStr(row.setting_value);
                    if (value && (def.type === "secret" || Number(row.is_secret) === 1)) {
                        value = trimStr(decrypt(value));
                    }
                    next.set(row.setting_key, {
                        value,
                        modify_by: row.modify_by || null,
                        modify_date: row.modify_date || null,
                    });
                }
                dbValues = next;
                loaded = true;
                loadedAt = now();
            } catch (error) {
                log.error("PLATFORM SETTINGS LOAD ERROR:", error?.message || error);
                // Keep whatever we had; env/default fallbacks still work.
                loadedAt = now();
            } finally {
                inflight = null;
            }
        })();
        return inflight;
    }

    function resolve(key) {
        const def = DEF_BY_KEY.get(key);
        if (!def) return { value: "", source: "unknown" };
        const fromDb = dbValues.get(key);
        if (fromDb && fromDb.value) return { value: fromDb.value, source: "database" };
        for (const name of envNamesFor(def)) {
            const fromEnv = trimStr(env[name]);
            if (fromEnv) return { value: fromEnv, source: "env" };
        }
        return { value: trimStr(def.default), source: def.default ? "default" : "unset" };
    }

    function maybeRefresh() {
        if (!loaded || now() - loadedAt > ttlMs) {
            load().catch(() => {});
        }
    }

    /** Synchronous read from cache (DB → env → default). */
    function get(key) {
        maybeRefresh();
        return resolve(key).value;
    }

    function getNumber(key, fallback = 0) {
        const num = Number(get(key));
        return Number.isFinite(num) ? num : fallback;
    }

    /** Always re-reads the DB first; use when a fresh value matters more than latency. */
    async function getFresh(key) {
        await load();
        return resolve(key).value;
    }

    /** Metadata (modify_by / modify_date) of the stored row, if any. */
    function rowMeta(key) {
        const row = dbValues.get(key);
        return { modify_by: row?.modify_by || null, modify_date: row?.modify_date || null };
    }

    /** Masked view for the admin UI. Secrets are never included in clear text. */
    async function describe() {
        await load();
        const fields = PLATFORM_SETTING_DEFS.map((def) => {
            const { value, source } = resolve(def.key);
            const row = dbValues.get(def.key);
            const base = {
                key: def.key,
                group: def.group,
                label: def.label,
                type: def.type,
                description: def.description || "",
                default: def.default ?? "",
                min: def.min ?? null,
                max: def.max ?? null,
                options: def.type === "select" ? def.options || [] : undefined,
                source,
                has_value: Boolean(value),
                modify_by: row?.modify_by || null,
                modify_date: row?.modify_date || null,
            };
            if (def.type === "secret") {
                return { ...base, value: "", masked: maskSecret(value) };
            }
            return { ...base, value };
        });
        return {
            groups: PLATFORM_SETTING_GROUPS.map((g) => ({
                ...g,
                fields: fields.filter((f) => f.group === g.key),
            })),
            loaded_at: loadedAt ? new Date(loadedAt).toISOString() : null,
        };
    }

    /**
     * Save settings. `values` is { KEY: value }. For secrets an empty string means
     * "keep the current value"; list keys in `clear` to blank them explicitly.
     */
    async function update({ values = {}, clear = [] } = {}, actor = null) {
        await ensureTable();
        const writes = [];
        const clearSet = new Set((Array.isArray(clear) ? clear : []).map(trimStr));

        for (const key of clearSet) {
            const def = DEF_BY_KEY.get(key);
            if (!def) throw Object.assign(new Error(`Unknown setting: ${key}`), { status: 400 });
            writes.push({ key, value: "", is_secret: def.type === "secret" ? 1 : 0 });
        }

        for (const [rawKey, rawValue] of Object.entries(values || {})) {
            const key = trimStr(rawKey);
            if (clearSet.has(key)) continue;
            const def = DEF_BY_KEY.get(key);
            if (!def) throw Object.assign(new Error(`Unknown setting: ${key}`), { status: 400 });
            const value = normalizeSettingValue(def, rawValue);
            if (def.type === "secret" && !value) continue; // blank secret = keep
            writes.push({ key, value, is_secret: def.type === "secret" ? 1 : 0 });
        }

        if (!writes.length) {
            return describe();
        }

        for (const w of writes) {
            const stored = w.value && w.is_secret ? encrypt(w.value) : w.value;
            await db.query(
                `INSERT INTO platform_settings (setting_key, setting_value, is_secret, modify_by)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value),
                                         is_secret = VALUES(is_secret),
                                         modify_by = VALUES(modify_by),
                                         modify_date = CURRENT_TIMESTAMP`,
                [w.key, stored, w.is_secret, actor]
            );
        }

        loaded = false; // force a fresh read so modify_date etc. come from the DB
        await load();
        return describe();
    }

    return { load, get, getNumber, getFresh, describe, update, ensureTable, resolve, rowMeta };
}

const store = createPlatformSettingsStore();

export const loadPlatformSettings = () => store.load();
export const getPlatformSetting = (key) => store.get(key);
export const getPlatformSettingNumber = (key, fallback) => store.getNumber(key, fallback);
export const getPlatformSettingFresh = (key) => store.getFresh(key);
export const describePlatformSettings = () => store.describe();
export const updatePlatformSettings = (body, actor) => store.update(body, actor);
export const ensurePlatformSettingsTable = () => store.ensureTable();

export default store;
