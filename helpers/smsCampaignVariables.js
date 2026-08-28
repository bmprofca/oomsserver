import { GET_BALANCE, USER_SNIPPED_DATA } from "./function.js";

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function formatDateOnly(value = new Date()) {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function variablesTemplateHasPlaceholders(template) {
    return /\{\{[a-zA-Z0-9_]+\}\}/.test(String(template || ""));
}

export function collectPlaceholderKeys(template) {
    const keys = new Set();
    const text = String(template || "");
    let match;
    const re = new RegExp(PLACEHOLDER_RE.source, "g");
    while ((match = re.exec(text)) !== null) {
        keys.add(String(match[1] || "").trim().toLowerCase());
    }
    return keys;
}

/**
 * Build client merge fields for SMS campaign variable substitution.
 * @param {string} branch_id
 * @param {object} recipient
 * @param {Set<string>|string[]} [neededKeys] - lowercase keys without braces
 */
export async function buildSmsClientVariables(
    branch_id,
    recipient = {},
    neededKeys = null
) {
    const needed = neededKeys
        ? neededKeys instanceof Set
            ? neededKeys
            : new Set(
                  [...neededKeys].map((k) => String(k || "").trim().toLowerCase())
              )
        : null;
    const wants = (key) => !needed || needed.has(key);

    const username = String(recipient.username || "").trim();
    let name = String(recipient.name || "").trim();
    let mobile = String(recipient.mobile || "").replace(/\D/g, "").slice(-10);
    let email = String(recipient.email || "").trim();

    if (
        username &&
        ((wants("name") && !name) ||
            (wants("email") && !email) ||
            (wants("mobile") && !mobile))
    ) {
        try {
            const profile = await USER_SNIPPED_DATA(username);
            if (!name && profile?.name) name = String(profile.name).trim();
            if (!email && profile?.email) email = String(profile.email).trim();
            if (!mobile && profile?.mobile) {
                mobile = String(profile.mobile).replace(/\D/g, "").slice(-10);
            }
        } catch {
            // keep whatever we already have
        }
    }

    let balance = "";
    if (username && (wants("balance") || wants("balance_amount"))) {
        try {
            const balanceData = await GET_BALANCE({
                branch_id,
                party_id: username,
                party_type: "client",
            });
            const raw = Number(balanceData?.balance ?? 0);
            balance = Number.isFinite(raw) ? Math.abs(raw).toFixed(2) : "";
        } catch {
            balance = "";
        }
    }

    const appUrl = String(process.env.APP_URL || "https://yourdomain.com").replace(
        /\/$/,
        ""
    );
    const payment_link =
        username && wants("payment_link") ? `${appUrl}/payment/${username}` : "";

    const vars = {};
    if (wants("name")) vars["{{name}}"] = name || username || mobile || "";
    if (wants("email")) vars["{{email}}"] = email;
    if (wants("mobile")) vars["{{mobile}}"] = mobile;
    if (wants("username")) vars["{{username}}"] = username;
    if (wants("balance")) vars["{{balance}}"] = balance;
    if (wants("balance_amount")) vars["{{balance_amount}}"] = balance;
    if (wants("current_date")) vars["{{current_date}}"] = formatDateOnly(new Date());
    if (wants("payment_link")) vars["{{payment_link}}"] = payment_link;
    return vars;
}

/**
 * Fast2SMS DLT English templates reject Unicode (e.g. ₹) in variable slots.
 * Normalizes money-like values to plain "1234.56" and strips ₹ / thousand separators.
 */
export function sanitizeValueForFast2SmsDlt(value) {
    let s = String(value ?? "").trim();
    if (!s) return s;

    s = s.replace(/\u20B9/g, "").replace(/,/g, "").trim();

    const numeric = s.replace(/[^\d.]/g, "");
    if (numeric && /^-?\d+(\.\d+)?$/.test(numeric)) {
        return Math.abs(parseFloat(numeric)).toFixed(2);
    }

    return s;
}

export function sanitizeVariablesValuesForDlt(variablesValues) {
    const raw = String(variablesValues ?? "").trim();
    if (!raw) return raw;
    return raw
        .split("|")
        .map((part) => sanitizeValueForFast2SmsDlt(part))
        .join("|");
}

function replacePlaceholdersInPart(part, variables) {
    if (typeof part !== "string") return "";
    let out = part;
    const entries = Object.entries(variables || {})
        .filter(
            ([key]) =>
                typeof key === "string" &&
                key.startsWith("{{") &&
                key.endsWith("}}")
        )
        .sort((a, b) => b[0].length - a[0].length);
    for (const [key, value] of entries) {
        out = out.split(key).join(value == null ? "" : String(value));
    }
    // Strip any unresolved placeholders so Fast2SMS does not receive {{...}}
    out = out.replace(/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/g, "");
    return out;
}

/**
 * Resolve a pipe-separated Fast2SMS variables_values template for one recipient.
 * Static segments stay as-is; {{name}} / {{balance}} etc. become client data.
 */
export function resolveVariablesValuesTemplate(template, variables) {
    const raw = String(template ?? "");
    if (!raw.trim()) return "";
    if (!variablesTemplateHasPlaceholders(raw)) return raw.trim();

    return raw
        .split("|")
        .map((part) => replacePlaceholdersInPart(part.trim(), variables))
        .join("|");
}

/**
 * Resolve variables_values for a campaign recipient (loads client fields as needed).
 */
export async function resolveSmsVariablesValuesForRecipient(
    branch_id,
    template,
    recipient = {}
) {
    const raw = String(template ?? "").trim();
    if (!raw || !variablesTemplateHasPlaceholders(raw)) {
        return raw;
    }
    const needed = collectPlaceholderKeys(raw);
    const variables = await buildSmsClientVariables(branch_id, recipient, needed);
    return resolveVariablesValuesTemplate(raw, variables);
}

/**
 * Replace sequential `{#var#}` placeholders in DLT message body with
 * pipe-separated resolved variable values (Fast2SMS order).
 */
export function buildSmsPreviewText(messageBody, resolvedVariablesValues) {
    const body = String(messageBody || "");
    const parts = String(resolvedVariablesValues ?? "").split("|");
    let index = 0;
    const replaced = body.replace(/\{#\s*var\s*#\}/gi, () => {
        const value = parts[index] != null ? String(parts[index]) : "";
        index += 1;
        return value;
    });
    if (replaced.trim()) return replaced;
    // No body (message-id only DLT): show resolved vars as a readable line.
    const cleaned = parts.map((p) => String(p || "").trim()).filter(Boolean);
    return cleaned.length ? cleaned.join(" · ") : "";
}

/**
 * Resolve template vars for a recipient and build a human-readable SMS preview.
 */
export async function buildSmsPreviewForRecipient(
    branch_id,
    { message_body, variables_values } = {},
    recipient = {}
) {
    const resolved_variables_values = await resolveSmsVariablesValuesForRecipient(
        branch_id,
        variables_values,
        recipient
    );
    const preview_text = buildSmsPreviewText(message_body, resolved_variables_values);
    return {
        resolved_variables_values,
        preview_text,
        variable_parts: String(resolved_variables_values || "")
            .split("|")
            .map((part) => String(part || "")),
    };
}
