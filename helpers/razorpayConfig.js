import defaultStore from "./platformSettings.js";
import { maskSecret } from "./secretBox.js";

/**
 * Platform Razorpay configuration. Stored in `platform_settings` under the RAZORPAY_* keys
 * (ADMIN → Settings → Razorpay, or the generic Platform Settings page). The legacy
 * `razorpay_platform_config` table has been removed; scripts/migrate-platform-settings.js
 * copied its last row into these keys.
 */

function trimStr(value) {
    return value == null ? "" : String(value).trim();
}

function toNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

export function detectRazorpayEnvironment(keyId) {
    const id = trimStr(keyId).toLowerCase();
    if (id.startsWith("rzp_live_")) return "live";
    if (id.startsWith("rzp_test_")) return "test";
    return "";
}

export function defaultRazorpayWebhookUrl() {
    const base = trimStr(process.env.BASE_DOMAIN || "https://server.ooms.in").replace(/\/+$/, "");
    return base ? `${base}/api/v1/webhook/razorpay` : "";
}

/** Safe payload for admin GET (secrets masked). */
export function serializeRazorpayConfig(row) {
    if (!row) {
        return {
            configured: false,
            status: "inactive",
            environment: "test",
            key_id: "",
            key_secret_masked: "",
            webhook_secret_masked: "",
            webhook_url: defaultRazorpayWebhookUrl(),
            has_key_secret: false,
            has_webhook_secret: false,
            gateway_fee_percent: 0,
            gateway_fee_flat: 0,
        };
    }

    const key_id = trimStr(row.key_id);
    const key_secret = trimStr(row.key_secret);
    const webhook_secret = trimStr(row.webhook_secret);
    const environment =
        detectRazorpayEnvironment(key_id) ||
        (trimStr(row.environment).toLowerCase() === "live" ? "live" : "test");

    return {
        environment,
        key_id,
        key_secret_masked: maskSecret(key_secret),
        webhook_secret_masked: maskSecret(webhook_secret),
        webhook_url: trimStr(row.webhook_url) || defaultRazorpayWebhookUrl(),
        status: trimStr(row.status).toLowerCase() === "inactive" ? "inactive" : "active",
        configured: Boolean(key_id && key_secret),
        has_key_secret: Boolean(key_secret),
        has_webhook_secret: Boolean(webhook_secret),
        gateway_fee_percent: toNumber(row.gateway_fee_percent, 0),
        gateway_fee_flat: toNumber(row.gateway_fee_flat, 0),
        source: row.source || null,
        modify_by: row.modify_by || null,
        modify_date: row.modify_date || null,
    };
}

/**
 * Build the Razorpay helpers on top of a platform-settings store. The default export
 * functions below use the shared store; tests inject their own.
 */
export function createRazorpayConfig(store = defaultStore) {
    function rowFromStore() {
        const keyId = store.resolve("RAZORPAY_KEY_ID");
        const keySecret = store.resolve("RAZORPAY_KEY_SECRET");
        const webhookSecret = store.resolve("RAZORPAY_WEBHOOK_SECRET");
        const webhookUrl = store.resolve("RAZORPAY_WEBHOOK_URL");
        const status = store.resolve("RAZORPAY_STATUS");
        const feePercent = store.resolve("RAZORPAY_GATEWAY_FEE_PERCENT");
        const feeFlat = store.resolve("RAZORPAY_GATEWAY_FEE_FLAT");

        if (!keyId.value && !keySecret.value) return null;

        const metas = ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "RAZORPAY_STATUS"]
            .map((k) => store.rowMeta(k))
            .filter((m) => m.modify_date)
            .sort((a, b) => String(b.modify_date).localeCompare(String(a.modify_date)));

        return {
            key_id: keyId.value,
            key_secret: keySecret.value,
            webhook_secret: webhookSecret.value,
            webhook_url: webhookUrl.value,
            status: status.value || "active",
            environment: detectRazorpayEnvironment(keyId.value),
            gateway_fee_percent: toNumber(feePercent.value, 0),
            gateway_fee_flat: toNumber(feeFlat.value, 0),
            source: keyId.source === "database" && keySecret.source === "database" ? "database" : keyId.source,
            modify_by: metas[0]?.modify_by || null,
            modify_date: metas[0]?.modify_date || null,
        };
    }

    /** Current config as a row-like object (fresh read), or null when no keys are set. */
    async function getRazorpayConfigRow() {
        await store.load();
        return rowFromStore();
    }

    /** Runtime config for payment APIs (fresh read). */
    async function resolveRazorpayRuntimeConfig() {
        const row = await getRazorpayConfigRow();
        const keyId = trimStr(row?.key_id);
        const keySecret = trimStr(row?.key_secret);
        const environment = detectRazorpayEnvironment(keyId) || "test";
        const status = row ? row.status : "inactive";
        return {
            source: row ? row.source : "unset",
            environment,
            isLive: environment === "live",
            keyId,
            keySecret,
            webhookSecret: trimStr(row?.webhook_secret),
            webhookUrl: trimStr(row?.webhook_url) || defaultRazorpayWebhookUrl(),
            status: status === "inactive" ? "inactive" : keyId && keySecret ? "active" : "inactive",
        };
    }

    /**
     * Save keys from the admin Razorpay page. Blank key_secret / webhook_secret keep the
     * stored value. Gateway fees are saved separately (walletPaymentConfig.js).
     */
    async function upsertRazorpayConfig(body = {}, actor = null) {
        await store.load();
        const existing = rowFromStore();

        const key_id = trimStr(body.key_id ?? existing?.key_id);
        if (!key_id) {
            throw Object.assign(new Error("key_id is required"), { status: 400 });
        }
        if (!detectRazorpayEnvironment(key_id)) {
            throw Object.assign(new Error("key_id must start with rzp_test_ or rzp_live_"), { status: 400 });
        }

        const incomingSecret = trimStr(body.key_secret);
        if (!incomingSecret && !trimStr(existing?.key_secret)) {
            throw Object.assign(new Error("key_secret is required"), { status: 400 });
        }

        const status =
            trimStr(body.status ?? existing?.status ?? "active").toLowerCase() === "inactive" ? "inactive" : "active";

        const webhook_url =
            trimStr(body.webhook_url) || trimStr(existing?.webhook_url) || defaultRazorpayWebhookUrl();

        const values = {
            RAZORPAY_KEY_ID: key_id,
            RAZORPAY_STATUS: status,
            RAZORPAY_WEBHOOK_URL: webhook_url,
        };
        if (incomingSecret) values.RAZORPAY_KEY_SECRET = incomingSecret;
        const incomingWebhook = trimStr(body.webhook_secret);
        if (incomingWebhook) values.RAZORPAY_WEBHOOK_SECRET = incomingWebhook;

        await store.update({ values }, actor);
        return serializeRazorpayConfig(rowFromStore());
    }

    return { getRazorpayConfigRow, resolveRazorpayRuntimeConfig, upsertRazorpayConfig };
}

const api = createRazorpayConfig();

export const getRazorpayConfigRow = api.getRazorpayConfigRow;
export const resolveRazorpayRuntimeConfig = api.resolveRazorpayRuntimeConfig;
export const upsertRazorpayConfig = api.upsertRazorpayConfig;
