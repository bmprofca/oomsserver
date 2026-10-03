import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const LIVEKIT_CONFIG_ENCRYPTION_KEY='OomsServer@2024@GmailUnixO099GRR';
function getKey() {
    const source = String(LIVEKIT_CONFIG_ENCRYPTION_KEY );
    if (source.length < 32) {
        const error = new Error(
            "LIVEKIT_CONFIG_ENCRYPTION_KEY must be configured with at least 32 characters"
        );
        error.status = 503;
        throw error;
    }
    return crypto.createHash("sha256").update(source, "utf8").digest();
}

export function encryptVoiceCallConfig(value) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
    const encrypted = Buffer.concat([
        cipher.update(String(value), "utf8"),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptVoiceCallConfig(payload) {
    const buffer = Buffer.from(String(payload || ""), "base64");
    if (buffer.length <= IV_LENGTH + TAG_LENGTH) {
        const error = new Error("Stored LiveKit credentials are invalid");
        error.status = 503;
        throw error;
    }

    try {
        const iv = buffer.subarray(0, IV_LENGTH);
        const tag = buffer.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
        const encrypted = buffer.subarray(IV_LENGTH + TAG_LENGTH);
        const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([
            decipher.update(encrypted),
            decipher.final(),
        ]).toString("utf8");
    } catch {
        const error = new Error(
            "LiveKit credentials could not be decrypted; verify LIVEKIT_CONFIG_ENCRYPTION_KEY"
        );
        error.status = 503;
        throw error;
    }
}
