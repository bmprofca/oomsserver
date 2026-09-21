import axios from "axios";
import crypto from "crypto";
import { resolveRazorpayRuntimeConfig } from "../helpers/razorpayConfig.js";

let configCache = null;
let configCacheAt = 0;
const CONFIG_CACHE_MS = 15000;

export function invalidateRazorpayServiceCache() {
    configCache = null;
    configCacheAt = 0;
}

export async function getRazorpayConfig({ force = false } = {}) {
    if (!force && configCache && Date.now() - configCacheAt < CONFIG_CACHE_MS) {
        return configCache;
    }
    const config = await resolveRazorpayRuntimeConfig();
    configCache = config;
    configCacheAt = Date.now();
    return config;
}

export async function assertRazorpayKeys() {
    const { environment, keyId, keySecret, status } = await getRazorpayConfig();
    if (String(status || "").toLowerCase() === "inactive") {
        const error = new Error("Razorpay payment gateway is inactive. Enable it in Admin → Settings → Razorpay.");
        error.statusCode = 503;
        throw error;
    }
    if (!keyId || !keySecret) {
        const error = new Error(
            "Razorpay integration keys are not configured. Set them in Admin → Settings → Razorpay."
        );
        error.statusCode = 500;
        throw error;
    }

    const expectedPrefix = environment === "live" ? "rzp_live_" : "rzp_test_";
    if (!keyId.toLowerCase().startsWith(expectedPrefix)) {
        const error = new Error(
            `Razorpay key_id does not match environment=${environment}. Expected a key starting with ${expectedPrefix}.`
        );
        error.statusCode = 500;
        throw error;
    }

    return { keyId, keySecret, environment };
}

function wrapRazorpayApiError(error) {
    const status = error.response?.status;
    const description =
        error.response?.data?.error?.description ||
        error.response?.data?.message ||
        error.message;

    if (status === 401) {
        const authError = new Error(
            "Razorpay authentication failed. Update Key ID and Key Secret in Admin → Settings → Razorpay (use the API Key Secret, not the webhook secret)."
        );
        authError.statusCode = 502;
        authError.razorpayDescription = description;
        return authError;
    }

    const wrapped = new Error(description || "Razorpay request failed");
    wrapped.statusCode = status && status >= 400 && status < 500 ? 400 : 502;
    return wrapped;
}

function sanitizeReceipt(value) {
    const raw = String(value || `rcpt${Date.now()}`);
    return raw.replace(/[^a-zA-Z0-9]/g, "").slice(0, 40);
}

export async function createRazorpayOrder({ amountPaise, receipt, notes = {} }) {
    const { keyId, keySecret, environment } = await assertRazorpayKeys();
    const authHeader = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const safeReceipt = sanitizeReceipt(receipt);

    try {
        const response = await axios.post(
            "https://api.razorpay.com/v1/orders",
            {
                amount: amountPaise,
                currency: "INR",
                receipt: safeReceipt,
                notes,
            },
            {
                headers: {
                    Authorization: `Basic ${authHeader}`,
                    "Content-Type": "application/json",
                },
            }
        );

        return {
            orderId: response.data.id,
            amount: response.data.amount,
            currency: response.data.currency || "INR",
            keyId,
            environment,
        };
    } catch (error) {
        throw wrapRazorpayApiError(error);
    }
}

export async function verifyRazorpayPaymentSignature({ orderId, paymentId, signature }) {
    const { keySecret } = await assertRazorpayKeys();
    const generatedSignature = crypto
        .createHmac("sha256", keySecret)
        .update(`${orderId}|${paymentId}`)
        .digest("hex");

    try {
        return crypto.timingSafeEqual(
            Buffer.from(generatedSignature),
            Buffer.from(String(signature || ""))
        );
    } catch {
        return false;
    }
}

export async function verifyRazorpayWebhookSignature({ rawBody, signature }) {
    const { webhookSecret } = await getRazorpayConfig();
    if (!webhookSecret) {
        const error = new Error(
            "Razorpay webhook secret is not configured. Set it in Admin → Settings → Razorpay."
        );
        error.statusCode = 500;
        throw error;
    }
    if (!signature) {
        return false;
    }

    const body = typeof rawBody === "string" ? rawBody : rawBody?.toString("utf8") || "";
    const digest = crypto.createHmac("sha256", webhookSecret).update(body).digest("hex");
    try {
        return crypto.timingSafeEqual(
            Buffer.from(digest),
            Buffer.from(String(signature))
        );
    } catch {
        return false;
    }
}

/** Lightweight credentials check against Razorpay Orders API. */
export async function testRazorpayCredentials() {
    const { keyId, keySecret, environment } = await assertRazorpayKeys();
    const authHeader = Buffer.from(`${keyId}:${keySecret}`).toString("base64");

    try {
        await axios.get("https://api.razorpay.com/v1/orders?count=1", {
            headers: { Authorization: `Basic ${authHeader}` },
            timeout: 15000,
        });
        return {
            ok: true,
            environment,
            key_id: keyId,
            message: "Razorpay credentials are valid.",
        };
    } catch (error) {
        const wrapped = wrapRazorpayApiError(error);
        return {
            ok: false,
            environment,
            key_id: keyId,
            message: wrapped.message,
            statusCode: wrapped.statusCode,
        };
    }
}
