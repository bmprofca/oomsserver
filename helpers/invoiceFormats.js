import pool from "../db.js";

/** Visual variants available for every invoice type column in `invoice_formats`. */
export const FORMAT_VARIANT_IDS = [
    "classic", 
    "compact", 
    "minimal",
    "premium_modern",    // Premium template 1
    "premium_elegant",   // Premium template 2  
    "premium_corporate", // Premium template 3
    "premium_creative",  // Premium template 4
    "premium_luxury"     // Premium template 5
];


export const FORMAT_VARIANTS = [
    { format_id: "classic", name: "Classic", description: "Standard layout with clear section headers and spacing." },
    { format_id: "compact", name: "Compact", description: "Dense layout for more line items per page." },
    { format_id: "minimal", name: "Minimal", description: "Minimal chrome, focus on line items and totals." },
];

const ALLOWED = new Set(FORMAT_VARIANT_IDS);

/**
 * Maps `invoice.type` (DB) and API aliases to `invoice_formats` column names.
 * API may use `receive`; DB uses `payment receive` for the same column.
 */
export const INVOICE_TYPE_TO_FORMAT_COLUMN = {
    sale: "sale",
    purchase: "purchase",
    payment: "payment",
    receive: "receive",
    "payment receive": "receive",
    journal: "journal",
    contra: "contra",
    expense: "expense",
};

/** Column names on `invoice_formats` (order matches table). */
export const INVOICE_FORMAT_COLUMNS = ["sale", "purchase", "payment", "receive", "journal", "contra", "expense"];

/** Allowed `type` on GET /formats and PUT /update-formats (case-insensitive). `payment receive` kept for compatibility. */
export const INVOICE_FORMAT_API_TYPES = [
    "sale",
    "purchase",
    "payment",
    "receive",
    "payment receive",
    "contra",
    "journal",
    "expense",
];

// Update normalization if needed
export function normalizeFormatKey(key) {
    const normalized = String(key).trim().toLowerCase();
    if (FORMAT_VARIANT_IDS.includes(normalized)) return normalized;
    return "classic"; // default
}

// Update validation
export function isValidFormatKey(key) {
    return FORMAT_VARIANT_IDS.includes(key);
}

export function listFormatVariants() {
    return FORMAT_VARIANTS.map((v) => ({ ...v }));
}

export function getFormatColumnForInvoiceType(invoiceType) {
    if (invoiceType == null) return null;
    const key = String(invoiceType).trim().toLowerCase();
    return INVOICE_TYPE_TO_FORMAT_COLUMN[key] ?? null;
}

/**
 * Normalize `invoice.type` for equality checks (generate PDF: body type vs row type).
 * Maps `receive` and `payment receive` to the same value.
 */
export function normalizeInvoiceTypeForMatch(raw) {
    const n = String(raw ?? "").trim().toLowerCase();
    if (n === "receive" || n === "payment receive") return "payment receive";
    return n;
}

export function isAllowedFormatApiType(raw) {
    const n = String(raw ?? "").trim().toLowerCase();
    return INVOICE_FORMAT_API_TYPES.includes(n);
}

/**
 * Directory name under `media/format/` for sample PDFs (same as column name).
 */
export function getFormatSampleDirKeyFromApiType(raw) {
    const col = getFormatColumnForInvoiceType(raw);
    return col;
}

/**
 * Ensures one `invoice_formats` row exists for the branch (defaults all columns to classic).
 */
export async function ensureBranchInvoiceFormatsRow(branch_id) {
    const [existing] = await pool.query(
        "SELECT * FROM `invoice_formats` WHERE `branch_id` = ? ORDER BY `id` ASC LIMIT 1",
        [branch_id]
    );
    if (existing.length > 0) {
        return existing[0];
    }
    await pool.query(
        `INSERT INTO \`invoice_formats\` (\`branch_id\`, \`sale\`, \`purchase\`, \`payment\`, \`receive\`, \`journal\`, \`contra\`, \`expense\`)
         VALUES (?, 'classic', 'classic', 'classic', 'classic', 'classic', 'classic', 'classic')`,
        [branch_id]
    );
    const [again] = await pool.query(
        "SELECT * FROM `invoice_formats` WHERE `branch_id` = ? ORDER BY `id` ASC LIMIT 1",
        [branch_id]
    );
    return again[0];
}

export async function getActiveFormatKeyForInvoiceType(branch_id, invoiceType) {
    const col = getFormatColumnForInvoiceType(invoiceType);
    if (!col) {
        return "classic";
    }
    const row = await ensureBranchInvoiceFormatsRow(branch_id);
    const raw = row[col];
    return normalizeFormatKey(raw);
}
