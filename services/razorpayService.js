import axios from "axios";
import crypto from "crypto";

export function getRazorpayConfig() {
    const baseDomain = (process.env.BASE_DOMAIN || "").replace(/\/$/, "");
    return {
        keyId: process.env.RAZORPAY_KEY_ID || "",
        keySecret: process.env.RAZORPAY_KEY_SECRET || "",
        webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || "",
        webhookUrl:
            process.env.RAZORPAY_WEBHOOK_URL ||
            (baseDomain ? `${baseDomain}/api/v1/webhook/razorpay` : ""),
    };
}

export function assertRazorpayKeys() {
    const { keyId, keySecret } = getRazorpayConfig();
    if (!keyId || !keySecret) {
        const error = new Error("Razorpay integration keys are not configured on the server.");
        error.statusCode = 500;
        throw error;
    }
    return { keyId, keySecret };
}

export async function createRazorpayOrder({ amountPaise, receipt, notes = {} }) {
    const { keyId, keySecret } = assertRazorpayKeys();
    const authHeader = Buffer.from(`${keyId}:${keySecret}`).toString("base64");

    const response = await axios.post(
        "https://api.razorpay.com/v1/orders",
        {
            amount: amountPaise,
            currency: "INR",
            receipt,
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
    };
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
