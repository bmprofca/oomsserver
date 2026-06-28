import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const DEFAULT_KEY_FALLBACK = "ooms-default-sms-encryption-key-change-me";

function getKey() {
    const source = process.env.SMS_ENCRYPTION_KEY || process.env.SMTP_ENCRYPTION_KEY || DEFAULT_KEY_FALLBACK;
    return crypto.createHash("sha256").update(source).digest();
}

function encrypt(text) {
    const plain = text === null || text === undefined ? "" : String(text);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
    const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decrypt(payload) {
    if (!payload) return "";
    const buffer = Buffer.from(String(payload), "base64");
    const iv = buffer.subarray(0, IV_LENGTH);
    const tag = buffer.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encrypted = buffer.subarray(IV_LENGTH + TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export {
    encrypt,
    decrypt
};
