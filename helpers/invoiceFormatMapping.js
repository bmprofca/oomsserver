export const INVOICE_FORMAT_MAPPING = {
    sale: ["classic", "modern", "elegant", "corporate", "creative", "compact", "professional", "boutique"],
    purchase: ["classic", "modern", "elegant", "corporate", "creative"],
    payment: ["classic", "modern", "elegant", "corporate", "creative"],
    receive: ["classic", "modern", "elegant", "corporate", "creative"],
    journal: ["classic", "modern", "minimal"],
    expense: ["classic", "modern", "minimal"],
};

/** Supported invoice PDF generation / format types (no contra / quotation / etc.). */
export const INVOICE_GENERATE_TYPES = [
    "sale",
    "purchase",
    "payment",
    "receive",
    "journal",
    "expense",
];

export function getAvailableFormatsForType(invoiceType) {
    const type = String(invoiceType || "").trim().toLowerCase();
    if (type === "payment receive") return INVOICE_FORMAT_MAPPING.receive || [];
    return INVOICE_FORMAT_MAPPING[type] || [];
}

export function isValidFormatForType(invoiceType, formatId) {
    const available = getAvailableFormatsForType(invoiceType);
    return available.includes(String(formatId).trim().toLowerCase());
}

export function isSupportedGenerateType(invoiceType) {
    const type = String(invoiceType || "").trim().toLowerCase();
    const normalized = type === "payment receive" ? "receive" : type;
    return INVOICE_GENERATE_TYPES.includes(normalized);
}
