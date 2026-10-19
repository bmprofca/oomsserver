import crypto from "crypto";

/**
 * AES-256-GCM encryption for credentials stored in the database (same scheme as the SMTP
 * credentials in routes/email.js). The key is derived from a server-side secret so a
 * database dump alone does not reveal stored credentials.
 *
 * Key source (first set wins): APP_ENCRYPTION_KEY, SMTP_ENCRYPTION_KEY, built-in default.
 * Changing the key makes previously stored secrets unreadable (they must be re-entered).
 */
const DEFAULT_SECRET = "ooms-default-smtp-encryption-key-change-me";
let warned = false;

function getKey() {
    const base = process.env.APP_ENCRYPTION_KEY || process.env.SMTP_ENCRYPTION_KEY || DEFAULT_SECRET;
    if (base === DEFAULT_SECRET && !warned) {
        warned = true;
        console.warn("[secretBox] APP_ENCRYPTION_KEY is not set; using the built-in default key for stored credentials.");
    }
    return crypto.createHash("sha256").update(base).digest();
}

export function encryptSecret(text) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
    const encrypted = Buffer.concat([cipher.update(String(text ?? ""), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

/** Returns "" when the payload is empty or cannot be decrypted (e.g. key changed). */
export function decryptSecret(payload) {
    if (!payload) return "";
    try {
        const buf = Buffer.from(String(payload), "base64");
        const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), buf.subarray(0, 12));
        decipher.setAuthTag(buf.subarray(12, 28));
        return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
    } catch (_) {
        return "";
    }
}

export function maskSecret(value) {
    const s = String(value || "").trim();
    if (!s) return "";
    return s.length <= 4 ? "••••" : `••••${s.slice(-4)}`;
}
