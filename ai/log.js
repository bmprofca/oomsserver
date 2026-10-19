import crypto from "crypto";

/**
 * Structured, redacted operational log for the AI assistant.
 * Never logs message text, tool results, tokens, API keys or raw usernames.
 */
export function hashUser(username) {
    return crypto.createHash("sha256").update(String(username || "")).digest("hex").slice(0, 12);
}

const ALLOWED_FIELDS = new Set([
    "cid", "branch_id", "user", "event", "status", "model", "tools", "tool_count",
    "duration_ms", "input_tokens", "output_tokens", "error_code", "blocks",
]);

export function aiLog(event, fields = {}) {
    const entry = { ts: new Date().toISOString(), scope: "ai", event };
    for (const [k, v] of Object.entries(fields)) {
        if (ALLOWED_FIELDS.has(k) && v !== undefined) entry[k] = v;
    }
    const line = JSON.stringify(entry);
    if (fields.status === "error") console.error(line);
    else console.info(line);
}
