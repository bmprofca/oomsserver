import fs from "fs/promises";
import path from "path";
import pool from "../db.js";
import { INVOICE_FORMAT_MAPPING, INVOICE_GENERATE_TYPES } from "./invoiceFormatMapping.js";

const ACCENT_BY_KEY = {
    classic: "#0056b3",
    modern: "#1a202c",
    elegant: "#7c3aed",
    corporate: "#0f172a",
    creative: "#db2777",
    compact: "#0f766e",
    professional: "#1d4ed8",
    boutique: "#c08e7b",
    minimal: "#334155",
};

const DISPLAY_NAMES = {
    classic: "Classic",
    modern: "Modern",
    elegant: "Elegant",
    corporate: "Corporate",
    creative: "Creative",
    compact: "Compact",
    professional: "Professional",
    boutique: "Boutique",
    minimal: "Minimal",
};

const COMMON_VARIABLES = [
    { token: "company_name", label: "Business name" },
    { token: "company_address", label: "Business address" },
    { token: "company_phone", label: "Business phone" },
    { token: "company_email", label: "Business email" },
    { token: "type_label", label: "Document title" },
    { token: "invoice_no", label: "Invoice number" },
    { token: "invoice_date", label: "Issue date" },
    { token: "due_date", label: "Due date" },
    { token: "amount", label: "Amount" },
    { token: "remark", label: "Remark" },
    { token: "generated_date", label: "Generated date" },
];

const ITEM_VARIABLES = [
    { token: "has_items", label: "Show the items table" },
    { token: "items_rows", label: "Item rows HTML", raw: true },
    { token: "subtotal", label: "Subtotal" },
    { token: "tax_amount", label: "Tax" },
];

const PARTY_VARIABLES = [
    { token: "show_parties", label: "Show party cards" },
    { token: "bill_to_label", label: "Primary party label" },
    { token: "party_name", label: "Primary party name" },
    { token: "party_detail", label: "Primary party detail", raw: true },
];

const SECOND_PARTY_VARIABLES = [
    { token: "party2_label", label: "Second party label" },
    { token: "party2_name", label: "Second party name" },
    { token: "party2_detail", label: "Second party detail", raw: true },
];

const SIMPLE_VARIABLES = [
    { token: "is_simple", label: "Show the voucher amount block" },
];

export const INVOICE_FORMAT_VARIABLES = {
    sale: [...COMMON_VARIABLES, ...PARTY_VARIABLES, ...ITEM_VARIABLES],
    purchase: [...COMMON_VARIABLES, ...PARTY_VARIABLES, ...ITEM_VARIABLES],
    payment: [...COMMON_VARIABLES, ...PARTY_VARIABLES, ...SIMPLE_VARIABLES],
    receive: [...COMMON_VARIABLES, ...PARTY_VARIABLES, ...SIMPLE_VARIABLES],
    journal: [...COMMON_VARIABLES, ...PARTY_VARIABLES, ...SECOND_PARTY_VARIABLES, ...SIMPLE_VARIABLES],
    expense: [...COMMON_VARIABLES, ...PARTY_VARIABLES, ...SIMPLE_VARIABLES],
};

const DEFAULT_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><title>{{type_label}}</title></head>
<body>
  <h1>{{company_name}}</h1>
  <p>{{company_address}}</p>
  <p>{{type_label}} · {{invoice_no}}</p>
  <p>{{invoice_date}}{{#if due_date}} · Due {{due_date}}{{/if}}</p>
  {{#if show_parties}}
  <p>{{bill_to_label}}: {{party_name}}</p>
  {{#if party2_name}}<p>{{party2_label}}: {{party2_name}}</p>{{/if}}
  {{/if}}
  {{#if has_items}}{{{items_rows}}}<p>Subtotal {{subtotal}} · Tax {{tax_amount}}</p>{{/if}}
  <p><strong>{{amount}}</strong></p>
  {{#if remark}}<p>{{remark}}</p>{{/if}}
</body>
</html>
`;

let catalogReady = null;

function normalizeType(invoiceType) {
    const type = String(invoiceType || "").trim().toLowerCase();
    return type === "payment receive" ? "receive" : type;
}

export function isInvoiceFormatType(invoiceType) {
    return INVOICE_GENERATE_TYPES.includes(normalizeType(invoiceType));
}

export function variablesForInvoiceType(invoiceType) {
    const type = normalizeType(invoiceType);
    return INVOICE_FORMAT_VARIABLES[type] || COMMON_VARIABLES;
}

function serialize(row) {
    if (!row) return null;
    return {
        id: row.id,
        format_key: row.format_key,
        invoice_type: row.invoice_type,
        name: row.name,
        html: row.html,
        accent_color: row.accent_color,
        status: row.status,
        sort_order: Number(row.sort_order) || 0,
    };
}

async function ensureTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS platform_invoice_formats (
            id INT NOT NULL AUTO_INCREMENT,
            format_key VARCHAR(40) NOT NULL,
            invoice_type VARCHAR(30) NOT NULL,
            name VARCHAR(80) NOT NULL,
            html MEDIUMTEXT NOT NULL,
            accent_color VARCHAR(20) NOT NULL DEFAULT '#2563eb',
            status VARCHAR(20) NOT NULL DEFAULT 'active',
            sort_order INT NOT NULL DEFAULT 0,
            create_date DATETIME DEFAULT CURRENT_TIMESTAMP,
            update_date DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uniq_invoice_format (invoice_type, format_key)
        )
    `);
}

async function readSeedHtml(type, formatKey) {
    const filePath = path.join(process.cwd(), "templates", "format", type, `${formatKey}.html`);
    try {
        return await fs.readFile(filePath, "utf8");
    } catch {
        return DEFAULT_HTML;
    }
}

export async function ensureInvoiceFormatCatalog() {
    if (!catalogReady) {
        catalogReady = (async () => {
            await ensureTable();
            for (const type of INVOICE_GENERATE_TYPES) {
                const keys = INVOICE_FORMAT_MAPPING[type] || [];
                for (let index = 0; index < keys.length; index += 1) {
                    const formatKey = keys[index];
                    const [existing] = await pool.query(
                        "SELECT id FROM platform_invoice_formats WHERE invoice_type = ? AND format_key = ? LIMIT 1",
                        [type, formatKey]
                    );
                    if (existing.length) continue;
                    const html = await readSeedHtml(type, formatKey);
                    await pool.query(
                        `INSERT INTO platform_invoice_formats
                         (format_key, invoice_type, name, html, accent_color, status, sort_order)
                         VALUES (?, ?, ?, ?, ?, 'active', ?)`,
                        [
                            formatKey,
                            type,
                            DISPLAY_NAMES[formatKey] || formatKey,
                            html,
                            ACCENT_BY_KEY[formatKey] || "#2563eb",
                            index,
                        ]
                    );
                }
            }
        })().catch((error) => {
            catalogReady = null;
            throw error;
        });
    }
    await catalogReady;
}

export async function listInvoiceFormats({ invoiceType, activeOnly = false } = {}) {
    await ensureInvoiceFormatCatalog();
    const filters = [];
    const params = [];
    const type = invoiceType ? normalizeType(invoiceType) : "";
    if (type) {
        filters.push("invoice_type = ?");
        params.push(type);
    }
    if (activeOnly) {
        filters.push("status = 'active'");
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const [rows] = await pool.query(
        `SELECT id, format_key, invoice_type, name, html, accent_color, status, sort_order
         FROM platform_invoice_formats
         ${where}
         ORDER BY invoice_type ASC, sort_order ASC, id ASC`,
        params
    );
    return rows.map(serialize);
}

export async function getInvoiceFormat(invoiceType, formatKey) {
    await ensureInvoiceFormatCatalog();
    const [rows] = await pool.query(
        `SELECT id, format_key, invoice_type, name, html, accent_color, status, sort_order
         FROM platform_invoice_formats
         WHERE invoice_type = ? AND format_key = ?
         LIMIT 1`,
        [normalizeType(invoiceType), String(formatKey || "").trim().toLowerCase()]
    );
    return serialize(rows[0]);
}

export async function getInvoiceFormatById(id) {
    await ensureInvoiceFormatCatalog();
    const [rows] = await pool.query(
        `SELECT id, format_key, invoice_type, name, html, accent_color, status, sort_order
         FROM platform_invoice_formats
         WHERE id = ?
         LIMIT 1`,
        [id]
    );
    return serialize(rows[0]);
}

export async function isActiveInvoiceFormat(invoiceType, formatKey) {
    const row = await getInvoiceFormat(invoiceType, formatKey);
    return Boolean(row && row.status === "active");
}

export function validateFormatPayload(body, { requireKey = false } = {}) {
    const name = String(body?.name || "").trim();
    const html = String(body?.html || "");
    const accent = String(body?.accent_color || "").trim();
    const status = String(body?.status || "active").trim().toLowerCase();
    const sortOrder = Number(body?.sort_order);
    const invoiceType = normalizeType(body?.invoice_type);
    const formatKey = String(body?.format_key || "").trim().toLowerCase();

    if (!name || name.length > 80) {
        return { error: "Name is required (max 80 characters)." };
    }
    if (!html.trim()) {
        return { error: "Template HTML is required." };
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(accent)) {
        return { error: "Accent color must be a hex color like #0056b3." };
    }
    if (!["active", "inactive"].includes(status)) {
        return { error: "Status must be active or inactive." };
    }
    if (requireKey) {
        if (!isInvoiceFormatType(invoiceType)) {
            return { error: `Invoice type must be one of: ${INVOICE_GENERATE_TYPES.join(", ")}.` };
        }
        if (!/^[a-z0-9_-]{2,40}$/.test(formatKey)) {
            return { error: "Format key must be 2–40 characters: letters, numbers, _ or -." };
        }
    }
    return {
        value: {
            name,
            html,
            accent_color: accent.toLowerCase(),
            status,
            sort_order: Number.isFinite(sortOrder) ? sortOrder : 0,
            invoice_type: invoiceType,
            format_key: formatKey,
        },
    };
}

export async function updateInvoiceFormat(id, body) {
    const current = await getInvoiceFormatById(id);
    if (!current) return { error: "Format not found.", status: 404 };
    const parsed = validateFormatPayload({
        ...body,
        invoice_type: current.invoice_type,
        format_key: current.format_key,
    });
    if (parsed.error) return parsed;
    const value = parsed.value;
    await pool.query(
        `UPDATE platform_invoice_formats
         SET name = ?, html = ?, accent_color = ?, status = ?, sort_order = ?
         WHERE id = ?`,
        [value.name, value.html, value.accent_color, value.status, value.sort_order, id]
    );
    if (value.accent_color !== current.accent_color) {
        await clearFormatSample(current.invoice_type, current.format_key);
    }
    return { row: await getInvoiceFormatById(id) };
}

export async function deleteInvoiceFormat(id) {
    const current = await getInvoiceFormatById(id);
    if (!current) return { error: "Format not found.", status: 404 };
    const column = current.invoice_type;
    const [used] = await pool.query(
        `SELECT branch_id FROM invoice_formats WHERE \`${column}\` = ? LIMIT 1`,
        [current.format_key]
    );
    if (used.length) {
        return {
            error: "This format is active on a branch. Set it inactive instead of deleting it.",
        };
    }
    await pool.query("DELETE FROM platform_invoice_formats WHERE id = ?", [id]);
    await clearFormatSample(current.invoice_type, current.format_key);
    return { ok: true };
}

export async function clearFormatSample(invoiceType, formatKey) {
    const dir = path.join(process.cwd(), "media", "format", normalizeType(invoiceType));
    const key = String(formatKey || "").trim().toLowerCase();
    await Promise.all([
        fs.unlink(path.join(dir, `${key}.pdf`)).catch(() => {}),
        fs.unlink(path.join(dir, `${key}.accent`)).catch(() => {}),
    ]);
}

export { DEFAULT_HTML, normalizeType as normalizeInvoiceFormatType };
