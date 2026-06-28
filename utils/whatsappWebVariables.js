const VARIABLE_REGEX = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;

export const WHATSAPPWEB_STANDARD_VARIABLES = [
    "{{name}}",
    "{{mobile}}",
    "{{email}}",
    "{{balance}}",
];

export function normalizeVariableToken(name) {
    const trimmed = String(name ?? "").trim();
    if (!trimmed) return "";

    if (trimmed.startsWith("{{") && trimmed.endsWith("}}")) {
        return trimmed;
    }

    const inner = trimmed.replace(/^\{\{|\}\}$/g, "").trim();
    return inner ? `{{${inner}}}` : "";
}

export function parseVariableNamesFromText(text) {
    const variableSet = new Set();
    const content = text == null ? "" : String(text);
    let match = VARIABLE_REGEX.exec(content);

    while (match) {
        if (match[1]) {
            variableSet.add(match[1]);
        }
        match = VARIABLE_REGEX.exec(content);
    }

    VARIABLE_REGEX.lastIndex = 0;
    return Array.from(variableSet);
}

export function collectContentVariables(content) {
    const variableSet = new Set();

    const walk = (value) => {
        if (typeof value === "string") {
            parseVariableNamesFromText(value).forEach((name) => {
                const token = normalizeVariableToken(name);
                if (token) variableSet.add(token);
            });
            return;
        }
        if (Array.isArray(value)) {
            value.forEach(walk);
            return;
        }
        if (value && typeof value === "object") {
            Object.values(value).forEach(walk);
        }
    };

    walk(content);
    return Array.from(variableSet);
}

export function buildStoredVariablesJson(content) {
    return [...new Set([...WHATSAPPWEB_STANDARD_VARIABLES, ...collectContentVariables(content)])];
}

export function normalizeStoredVariablesJson(value) {
    if (!Array.isArray(value)) return [...WHATSAPPWEB_STANDARD_VARIABLES];
    const normalized = value
        .map((item) => normalizeVariableToken(item))
        .filter(Boolean);
    return [...new Set([...WHATSAPPWEB_STANDARD_VARIABLES, ...normalized])];
}

export function buildVariableMap(input = {}) {
    const map = {};
    for (const [key, val] of Object.entries(input || {})) {
        if (!key) continue;
        const normalizedKey = normalizeVariableToken(key);
        if (!normalizedKey) continue;
        map[normalizedKey] = val == null ? "" : String(val);
    }
    return map;
}

export function replaceVariablesInString(str, variables) {
    if (typeof str !== "string") return str;
    let out = str;
    for (const [key, value] of Object.entries(variables)) {
        out = out.split(key).join(value ?? "");
    }
    return out;
}

export function replaceVariablesInValue(value, variables) {
    if (typeof value === "string") {
        return replaceVariablesInString(value, variables);
    }
    if (Array.isArray(value)) {
        return value.map((item) => replaceVariablesInValue(item, variables));
    }
    if (value && typeof value === "object") {
        const next = {};
        for (const [key, item] of Object.entries(value)) {
            next[key] = replaceVariablesInValue(item, variables);
        }
        return next;
    }
    return value;
}

export function contentUsesVariable(content, variableToken) {
    return JSON.stringify(content || {}).includes(variableToken);
}

export function getBareVariableName(token) {
    const normalized = normalizeVariableToken(token);
    if (!normalized) return "";
    return normalized.slice(2, -2);
}

export const WHATSAPPWEB_VARIABLE_LABELS = {
    name: "Client name",
    mobile: "Client mobile",
    email: "Client email",
    balance: "Outstanding balance",
};
