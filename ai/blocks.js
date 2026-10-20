/**
 * Structured response blocks rendered by the CLIENT_WEB chat UI.
 * Built ONLY from rows returned by tool handlers — never from model-written text —
 * so every table / KPI / chart value is a real database value.
 *
 * Block contract (kept in sync with CLIENT_WEB/src/components/ai/blocks/BlockRenderer.jsx):
 *   { type: "table", title, columns: [{key,label,type}], rows, total, truncated, note? }
 *   { type: "kpi", title?, items: [{label, value, format}] }
 *   { type: "chart", title, kind: "bar"|"line"|"pie", xKey, series: [{key,label}], data }
 *   { type: "clarification", question, options: [string] }
 * Column/KPI formats: "text" | "number" | "money" | "date" | "status"
 */

const COLUMN_TYPES = new Set(["text", "number", "money", "date", "status"]);
const MAX_TABLE_ROWS = 200;
const MAX_CHART_POINTS = 60;

function cleanCell(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "number" || typeof value === "boolean") return value;
    return String(value).slice(0, 500);
}

// Only in-app relative links to existing OOMS pages, e.g. "/task/{task_id}".
const HREF_TEMPLATE_RE = /^\/[a-z0-9/_-]*(\{[a-z_]+\}[a-z0-9/_-]*)*$/;

export function tableBlock({ title, columns, rows, total = null, truncated = false, note = null }) {
    const cols = columns.map((c) => ({
        key: c.key,
        label: c.label,
        type: COLUMN_TYPES.has(c.type) ? c.type : "text",
        ...(c.href && HREF_TEMPLATE_RE.test(c.href) ? { href: c.href } : {}),
    }));
    // Keys referenced by link templates must travel with the row even if not displayed.
    const hrefKeys = new Set();
    for (const c of cols) {
        for (const m of (c.href || "").matchAll(/\{([a-z_]+)\}/g)) hrefKeys.add(m[1]);
    }
    const safeRows = (rows || []).slice(0, MAX_TABLE_ROWS).map((row) => {
        const out = {};
        for (const c of cols) out[c.key] = cleanCell(row[c.key]);
        for (const k of hrefKeys) out[k] = cleanCell(row[k]);
        return out;
    });
    return {
        type: "table",
        title: String(title || "").slice(0, 160),
        columns: cols,
        rows: safeRows,
        total: total ?? safeRows.length,
        truncated: Boolean(truncated || (rows || []).length > MAX_TABLE_ROWS),
        ...(note ? { note: String(note).slice(0, 300) } : {}),
    };
}

export function kpiBlock({ title = null, items }) {
    return {
        type: "kpi",
        ...(title ? { title: String(title).slice(0, 160) } : {}),
        items: (items || []).map((i) => ({
            label: String(i.label).slice(0, 80),
            value: typeof i.value === "number" ? i.value : cleanCell(i.value),
            format: COLUMN_TYPES.has(i.format) ? i.format : "number",
        })),
    };
}

export function chartBlock({ title, kind = "bar", xKey, series, data }) {
    return {
        type: "chart",
        title: String(title || "").slice(0, 160),
        kind: ["bar", "line", "pie"].includes(kind) ? kind : "bar",
        xKey,
        series: series.map((s) => ({ key: s.key, label: String(s.label).slice(0, 60) })),
        data: (data || []).slice(0, MAX_CHART_POINTS).map((row) => {
            const out = { [xKey]: cleanCell(row[xKey]) };
            for (const s of series) out[s.key] = Number(row[s.key]) || 0;
            return out;
        }),
    };
}

export function clarificationBlock({ question, options = [] }) {
    return {
        type: "clarification",
        question: String(question || "").slice(0, 300),
        options: options.slice(0, 8).map((o) => String(o).slice(0, 120)),
    };
}

/** Validate an arbitrary block object (used on blocks read back from storage). */
/**
 * A write action waiting for confirmation (read-write mode). Rendered as a card with
 * Confirm / Cancel; the current state is looked up by action_id when shown again.
 *   { type: "action", action_id, action_type, title, fields: [{label, value}], body?, items?, expires_minutes }
 */
export function actionBlock({ actionId, actionType, preview, expiresMinutes }) {
    return {
        type: "action",
        action_id: actionId,
        action_type: actionType,
        title: String(preview.title || "Confirm action").slice(0, 120),
        fields: (preview.fields || []).slice(0, 10).map((f) => ({ label: String(f.label).slice(0, 40), value: String(f.value ?? "").slice(0, 300) })),
        ...(preview.body ? { body: String(preview.body).slice(0, 5000) } : {}),
        ...(preview.items?.length ? { items: preview.items.slice(0, 10).map((i) => String(i).slice(0, 200)) } : {}),
        expires_minutes: expiresMinutes,
    };
}

export function isValidBlock(block) {
    if (!block || typeof block !== "object") return false;
    return ["table", "kpi", "chart", "clarification", "action"].includes(block.type);
}
