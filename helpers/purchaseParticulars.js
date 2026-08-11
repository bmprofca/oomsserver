/**
 * Readable purchase particulars for lists, ledger, and PDFs.
 * Task example: "Purchase for firm XYZ for service GST Filing (TASK)"
 */
export function formatPurchaseParticularsText({
    firmName = null,
    partyName = null,
    serviceNames = [],
    isTask = false,
} = {}) {
    const services = (Array.isArray(serviceNames) ? serviceNames : [])
        .map((s) => String(s ?? "").trim())
        .filter(Boolean);
    const serviceLabel = services.length > 0 ? services.join(", ") : "";
    const firm = firmName != null ? String(firmName).trim() : "";
    const party = partyName != null ? String(partyName).trim() : "";

    const parts = ["Purchase"];
    if (firm) {
        parts.push(`for firm ${firm}`);
    } else if (party) {
        parts.push(`for ${party}`);
    }
    if (serviceLabel) {
        parts.push(`for service ${serviceLabel}`);
    }

    let text = parts.join(" ");
    if (isTask) {
        text = `${text} (TASK)`;
    }
    if (text === "Purchase" || text === "Purchase (TASK)") {
        return isTask ? "Purchase (TASK)" : "";
    }
    return text;
}
