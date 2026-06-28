/**
 * PDF titles for non–sale/purchase invoices (`invoice.type` in DB).
 */
export const SIMPLE_DOC_TITLES_BY_INVOICE_TYPE = {
    "payment receive": "PAYMENT RECEIPT",
    payment: "PAYMENT VOUCHER",
    journal: "JOURNAL VOUCHER",
    contra: "CONTRA VOUCHER",
    expense: "EXPENSE VOUCHER",
};

/** Normalize type string then resolve title (handles `receive` ↔ `payment receive`). */
export function getSimpleDocTitleForInvoiceType(invoiceType) {
    const n = String(invoiceType ?? "").trim().toLowerCase();
    const key = n === "receive" || n === "payment receive" ? "payment receive" : n;
    return SIMPLE_DOC_TITLES_BY_INVOICE_TYPE[key] ?? null;
}

/** Title for sample PDFs keyed by `invoice_formats` column name (receive, payment, …). */
export const SIMPLE_SAMPLE_TITLE_BY_FORMAT_COLUMN = {
    payment: "PAYMENT VOUCHER",
    receive: "PAYMENT RECEIPT",
    journal: "JOURNAL VOUCHER",
    contra: "CONTRA VOUCHER",
    expense: "EXPENSE VOUCHER",
};
