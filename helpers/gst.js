/**
 * Branch-level GST resolution.
 *
 * GST applies only when branch_list.gst_applicable = '1'
 * AND the document date is on/after branch_list.gst_applicable_after.
 * Rate always comes from process.env.TAX_RATE (never from client or dropped DB columns).
 */

const round2 = (n) => Number(Number(n || 0).toFixed(2));

/** @returns {number} */
export function getTaxRateFromEnv() {
    const rate = Number(process.env.TAX_RATE);
    return Number.isFinite(rate) && rate >= 0 ? rate : 0;
}

/**
 * Normalize any date-like value to YYYY-MM-DD (UTC date parts from Date, or first 10 chars of string).
 * @returns {string|null}
 */
export function toDateOnly(value) {
    if (value == null || value === "") return null;
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) return null;
        const y = value.getUTCFullYear();
        const m = String(value.getUTCMonth() + 1).padStart(2, "0");
        const d = String(value.getUTCDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
    }
    const str = String(value).trim();
    if (!str) return null;
    if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
    const parsed = new Date(str);
    if (Number.isNaN(parsed.getTime())) return null;
    return toDateOnly(parsed);
}

/**
 * @param {import('mysql2/promise').Pool|import('mysql2/promise').PoolConnection} db
 * @param {string} branch_id
 * @returns {Promise<{ gst_applicable: string, gst_applicable_after: string|null }>}
 */
export async function fetchBranchGstSettings(db, branch_id) {
    const [rows] = await db.query(
        `SELECT gst_applicable, gst_applicable_after
         FROM branch_list
         WHERE branch_id = ?
         LIMIT 1`,
        [branch_id]
    );
    const row = rows?.[0];
    return {
        gst_applicable: row?.gst_applicable == null ? "0" : String(row.gst_applicable),
        gst_applicable_after: row?.gst_applicable_after != null
            ? toDateOnly(row.gst_applicable_after)
            : null,
    };
}

/**
 * @param {string|Date|null|undefined} asOfDate
 * @param {{ gst_applicable?: string, gst_applicable_after?: string|null }} settings
 */
export function isGstApplicable(asOfDate, settings = {}) {
    if (String(settings.gst_applicable ?? "0") !== "1") return false;
    const doc = toDateOnly(asOfDate);
    const after = toDateOnly(settings.gst_applicable_after);
    if (!doc || !after) return false;
    return doc >= after;
}

/**
 * @param {{ fees?: number|string, asOfDate?: string|Date|null, settings?: object, taxRate?: number }} args
 * @returns {{ applicable: boolean, tax_rate: number, tax_value: number, total: number, fees: number }}
 */
export function resolveGst({
    fees = 0,
    asOfDate = null,
    settings = {},
    taxRate = null,
} = {}) {
    const feesNum = round2(fees);
    const applicable = isGstApplicable(asOfDate, settings);
    const rate = applicable
        ? (taxRate != null && Number.isFinite(Number(taxRate))
            ? Number(taxRate)
            : getTaxRateFromEnv())
        : 0;
    const tax_rate = round2(rate);
    const tax_value = round2((feesNum * tax_rate) / 100);
    const total = round2(feesNum + tax_value);
    return { applicable, tax_rate, tax_value, total, fees: feesNum };
}

/**
 * Fetch branch settings and resolve GST in one call.
 * @param {import('mysql2/promise').Pool|import('mysql2/promise').PoolConnection} db
 * @param {string} branch_id
 * @param {{ fees?: number|string, asOfDate?: string|Date|null }} opts
 */
export async function resolveBranchGst(db, branch_id, { fees = 0, asOfDate = null } = {}) {
    const settings = await fetchBranchGstSettings(db, branch_id);
    return {
        settings,
        ...resolveGst({ fees, asOfDate, settings }),
    };
}

/**
 * Apply GST on a taxable subtotal after discount (sales/billing pattern).
 * @returns {{ tax_rate: number, tax_value: number, applicable: boolean }}
 */
export function resolveGstOnTaxable({
    taxableAmount = 0,
    asOfDate = null,
    settings = {},
} = {}) {
    const { applicable, tax_rate, tax_value } = resolveGst({
        fees: taxableAmount,
        asOfDate,
        settings,
    });
    return { applicable, tax_rate, tax_value };
}

export default {
    getTaxRateFromEnv,
    toDateOnly,
    fetchBranchGstSettings,
    isGstApplicable,
    resolveGst,
    resolveBranchGst,
    resolveGstOnTaxable,
};
