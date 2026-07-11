import axios from "axios";
import crypto from "crypto";

function trimEnv(value) {
    return typeof value === "string" ? value.trim() : "";
}

function normalizeRazorpayEnvironment(value) {
    const env = trimEnv(value).toLowerCase();
    return env === "live" ? "live" : "test";
}

export function getRazorpayConfig() {
    const baseDomain = trimEnv(process.env.BASE_DOMAIN).replace(/\/$/, "");
    const environment = normalizeRazorpayEnvironment(process.env.RAZORPAY_ENVIRONMENT);

    return {
        environment,
        isLive: environment === "live",
        keyId: trimEnv(process.env.RAZORPAY_KEY_ID),
        keySecret: trimEnv(process.env.RAZORPAY_KEY_SECRET),
        webhookSecret: trimEnv(process.env.RAZORPAY_WEBHOOK_SECRET),
        webhookUrl:
            trimEnv(process.env.RAZORPAY_WEBHOOK_URL) ||
            (baseDomain ? `${baseDomain}/api/v1/webhook/razorpay` : ""),
    };
}

export function assertRazorpayKeys() {
    const { environment, keyId, keySecret } = getRazorpayConfig();
    if (!keyId || !keySecret) {
        const error = new Error("Razorpay integration keys are not configured on the server.");
        error.statusCode = 500;
        throw error;
    }

    const expectedPrefix = environment === "live" ? "rzp_live_" : "rzp_test_";
    if (!keyId.toLowerCase().startsWith(expectedPrefix)) {
        const error = new Error(
            `RAZORPAY_KEY_ID does not match RAZORPAY_ENVIRONMENT=${environment}. Expected a key starting with ${expectedPrefix}.`
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
            "Razorpay authentication failed. Update RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in SERVER/.env from Razorpay Dashboard → Settings → API Keys (use the Key Secret, not the webhook secret)."
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
    const { keyId, keySecret, environment } = assertRazorpayKeys();
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

export function verifyRazorpayPaymentSignature({ orderId, paymentId, signature }) {
    const { keySecret } = assertRazorpayKeys();
    const generatedSignature = crypto
        .createHmac("sha256", keySecret)
        .update(`${orderId}|${paymentId}`)
        .digest("hex");

    return generatedSignature === signature;
}

export function verifyRazorpayWebhookSignature({ rawBody, signature }) {
    const { webhookSecret } = getRazorpayConfig();
    if (!webhookSecret) {
        const error = new Error("Razorpay webhook secret is not configured on the server.");
        error.statusCode = 500;
        throw error;
    }
    if (!signature) {
        return false;
    }

    const body = typeof rawBody === "string" ? rawBody : rawBody?.toString("utf8") || "";
    const digest = crypto.createHmac("sha256", webhookSecret).update(body).digest("hex");
    return digest === signature;
}
