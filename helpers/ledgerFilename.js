/**
 * Ledger download / share file name:
 * LEDGER_{NAME}_{DD-MM-YYYY}_{DD-MM-YYYY}.PDF (all uppercase)
 */

function toDdMmYyyy(value) {
    const raw = String(value || "").trim();
    const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[3]}-${iso[2]}-${iso[1]}`;

    const dmy = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (dmy) return raw;

    const d = value instanceof Date ? value : new Date(raw);
    if (!Number.isNaN(d.getTime())) {
        const dd = String(d.getDate()).padStart(2, "0");
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const yyyy = d.getFullYear();
        return `${dd}-${mm}-${yyyy}`;
    }
    return raw.replace(/[^\d-]/g, "") || "DATE";
}

function sanitizeLedgerNamePart(name) {
    const cleaned = String(name || "")
        .trim()
        .replace(/[^\w\s.-]+/g, "")
        .replace(/[\s.]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "");
    return cleaned || "PARTY";
}

/**
 * @param {{ name?: string, fromDate: string, toDate: string, extension?: string }} opts
 * @returns {string}
 */
export function buildLedgerDownloadFilename({
    name,
    fromDate,
    toDate,
    extension = "pdf",
} = {}) {
    const safeName = sanitizeLedgerNamePart(name);
    const from = toDdMmYyyy(fromDate);
    const to = toDdMmYyyy(toDate);
    const ext = String(extension || "pdf").replace(/^\./, "");
    return `LEDGER_${safeName}_${from}_${to}.${ext}`.toUpperCase();
}
