import crypto from "crypto";

const BLOCKED_DATA_KEYS = new Set([
    "token",
    "access_token",
    "refresh_token",
    "password",
    "secret",
    "pan",
    "pan_number",
    "payment_details",
    "document_contents",
]);

export const NOTIFICATION_CATEGORIES = Object.freeze([
    "task",
    "compliance",
    "billing",
    "document",
    "system",
    "message",
]);

export function normalizeNotificationCategory(value) {
    const category = String(value || "system").trim().toLowerCase();
    return NOTIFICATION_CATEGORIES.includes(category) ? category : "system";
}

export function normalizeNotificationRecipients(recipients) {
    const input = Array.isArray(recipients) ? recipients : [recipients];
    const seen = new Set();
    return input
        .map((recipient) => ({
            recipient_type: String(recipient?.recipient_type || "").trim().toLowerCase(),
            recipient_id: String(recipient?.recipient_id || "").trim(),
        }))
        .filter((recipient) => {
            if (!recipient.recipient_type || !recipient.recipient_id) return false;
            const key = `${recipient.recipient_type}:${recipient.recipient_id}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

function redact(value, depth = 0) {
    if (depth > 3) return "[redacted]";
    if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
    if (!value || typeof value !== "object") {
        const text = value == null ? value : String(value);
        return typeof text === "string" && text.length > 2000 ? text.slice(0, 2000) : text;
    }

    return Object.fromEntries(
        Object.entries(value)
            .filter(([key]) => !BLOCKED_DATA_KEYS.has(String(key).toLowerCase()))
            .slice(0, 50)
            .map(([key, item]) => [key, redact(item, depth + 1)])
    );
}

export function sanitizeNotificationData(value) {
    return redact(value || {});
}

export function buildNotificationId(branchId, recipientType, recipientId, eventKey) {
    const input = [branchId, recipientType, recipientId, eventKey].map(String).join("\0");
    return `ntf_${crypto.createHash("sha256").update(input).digest("hex")}`;
}

export function normalizeNotificationInput(input = {}) {
    const eventKey = String(input.event_key || "").trim();
    const title = String(input.title || "").trim();
    const body = String(input.body || "").trim();
    if (!eventKey) throw new Error("event_key is required");
    if (!title) throw new Error("title is required");
    if (!body) throw new Error("body is required");
    if (eventKey.length > 191) throw new Error("event_key is too long");
    if (title.length > 255) throw new Error("title is too long");

    return {
        event_key: eventKey,
        category: normalizeNotificationCategory(input.category),
        title,
        body: body.slice(0, 10000),
        data: sanitizeNotificationData(input.data),
        actor_username: input.actor_username ? String(input.actor_username).trim().slice(0, 100) : null,
        expires_at: input.expires_at || null,
    };
}
