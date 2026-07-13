export const INVOICE_FORMAT_MAPPING = {
    sale: ["classic", "modern", "elegant", "corporate", "creative"],
    purchase: ["classic", "modern", "elegant", "corporate", "creative"],
    payment: ["classic", "modern", "elegant", "corporate", "creative"],
    receive: ["classic", "modern", "elegant", "corporate", "creative"],
    journal: ["classic", "modern", "minimal"],
    contra: ["classic", "modern", "minimal"],
    expense: ["classic", "modern", "minimal"],
};

export function getAvailableFormatsForType(invoiceType) {
    const type = String(invoiceType || "").trim().toLowerCase();
    // Default to classic, modern, minimal if type is unknown
    return INVOICE_FORMAT_MAPPING[type] || ["classic", "modern", "minimal"];
}

export function isValidFormatForType(invoiceType, formatId) {
    const available = getAvailableFormatsForType(invoiceType);
    return available.includes(String(formatId).trim().toLowerCase());
}
