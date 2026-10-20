/**
 * Internal identifiers (task_id, usernames, party ids …) are for the backend only. The model
 * still receives them in tool results — it needs them to call the next tool — but nothing
 * the user sees may contain them, even if the user asks:
 *
 *   - collectIdentifiers(): gathers every ID value from a tool result's data
 *   - scrubText(): removes those exact values + known ID patterns from model text
 *   - sanitizeBlock(): drops ID columns and scrubs every visible string of a block;
 *     link keys used only by href templates stay (they are not displayed)
 *
 * OOMS IDs are opaque random strings (usr_Z2JLMZ270G, PL3WEZZ0PD,
 * APP2025_BRN2025_1748718004331_15120830), so exact-value removal cannot hit real words.
 */

const INTERNAL_KEY_RE = /^(id|username|branch_id|.+_id|.+_username|.+_ids|.+_usernames)$/i;
const ID_PATTERNS = [
    /\busr_[A-Za-z0-9]{6,}\b/g,
    /\b[A-Z]{2,5}\d{4}_[A-Z]{2,5}\d{4}_\d{6,}_\d{3,}\b/g,
];
const MIN_ID_LENGTH = 6;

export function isInternalKey(key) {
    return INTERNAL_KEY_RE.test(String(key || ""));
}

/** Plausible ID value: long enough and not a plain word (has a digit or underscore). */
function looksLikeId(value) {
    return typeof value === "string" && value.length >= MIN_ID_LENGTH && value.length <= 120 && /[\d_]/.test(value) && !/\s/.test(value);
}

/** Walk tool data and add every internal identifier value to `into`. */
export function collectIdentifiers(data, into = new Set(), depth = 0) {
    if (data === null || data === undefined || depth > 8) return into;
    if (Array.isArray(data)) {
        for (const item of data) collectIdentifiers(item, into, depth + 1);
        return into;
    }
    if (typeof data === "object") {
        for (const [key, value] of Object.entries(data)) {
            if (isInternalKey(key)) {
                for (const v of Array.isArray(value) ? value : [value]) if (looksLikeId(v)) into.add(v);
            } else if (value && typeof value === "object") {
                collectIdentifiers(value, into, depth + 1);
            }
        }
    }
    return into;
}

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Remove identifiers from user-visible text and tidy what is left around them. */
export function scrubText(text, ids = new Set()) {
    if (typeof text !== "string" || !text) return text;
    let out = text;
    // Longest first so an ID that contains another is removed whole.
    for (const id of [...ids].sort((a, b) => b.length - a.length)) {
        out = out.replace(new RegExp(`(?<![A-Za-z0-9_])${escapeRe(id)}(?![A-Za-z0-9_])`, "g"), "");
    }
    for (const re of ID_PATTERNS) out = out.replace(re, "");
    if (out === text) return text;
    return out
        .replace(/`\s*`/g, "")
        .replace(/\*\*\s*\*\*/g, "")
        // A label left with nothing after it ("ID: is overdue", "username: )").
        .replace(/\b(user\s*id|username|user\s*name|id)\s*[:#=]\s*(?=[\s,;.)\]|]|$)/gi, "")
        .replace(/\b(user\s*id|username|user\s*name|id)\s*(?=[,;.)\]\n|]|$)/gi, "")
        .replace(/\(\s*(?:task|user|client|party|staff|account)?\s*[,;:/|-]?\s*\)/gi, "")
        .replace(/\[\s*\]/g, "")
        .replace(/\s+([,.;:)])/g, "$1")
        .replace(/\(\s+/g, "(")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/^[ \t]*[-*•][ \t]*[:,]?[ \t]*$/gm, "")
        .replace(/[ \t]+$/gm, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function scrubCell(value, ids) {
    if (typeof value !== "string") return value;
    const cleaned = scrubText(value, ids);
    return cleaned === "" ? null : cleaned;
}

/** Make a block safe to display: no ID columns, no IDs in any visible string. */
export function sanitizeBlock(block, ids = new Set()) {
    if (!block || typeof block !== "object") return block;
    switch (block.type) {
        case "table": {
            const columns = (block.columns || []).filter((c) => !isInternalKey(c.key));
            const visible = new Set(columns.map((c) => c.key));
            const linkKeys = new Set();
            for (const c of columns) for (const m of (c.href || "").matchAll(/\{([a-z_]+)\}/g)) linkKeys.add(m[1]);
            const rows = (block.rows || []).map((row) => {
                const out = {};
                for (const [k, v] of Object.entries(row)) {
                    if (visible.has(k)) out[k] = scrubCell(v, ids);
                    else if (linkKeys.has(k)) out[k] = v; // used only inside the link URL
                }
                return out;
            });
            return {
                ...block,
                title: scrubText(block.title, ids),
                ...(block.note ? { note: scrubText(block.note, ids) } : {}),
                columns,
                rows,
            };
        }
        case "kpi":
            return {
                ...block,
                ...(block.title ? { title: scrubText(block.title, ids) } : {}),
                items: (block.items || []).map((i) => ({ ...i, label: scrubText(i.label, ids), value: scrubCell(i.value, ids) })),
            };
        case "chart":
            return {
                ...block,
                title: scrubText(block.title, ids),
                data: (block.data || []).map((row) => ({ ...row, [block.xKey]: scrubCell(row[block.xKey], ids) })),
            };
        case "clarification":
            return {
                ...block,
                question: scrubText(block.question, ids),
                options: (block.options || []).map((o) => scrubText(o, ids)).filter(Boolean),
            };
        default:
            return block;
    }
}

/** True when text contains something shaped like an OOMS internal ID (usr_…, APP…_BRN…). */
export function containsInternalId(text) {
    return ID_PATTERNS.some((re) => new RegExp(re.source).test(String(text || "")));
}
