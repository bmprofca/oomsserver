// pdfHelpers.js
// Shared drawing & formatting helpers used by every invoice PDF layout
// (Sale/Purchase, Simple vouchers, and all 5 premium templates).
//
// Previously each of the three renderer files carried its own copy of
// gRect / gRRect / overflow / totalsRow, and the copies had drifted apart —
// one totalsRow measured text width before placing it, the others placed
// value text at a fixed offset from the label with no width check at all.
// That's what caused numbers to run outside their boxes with real data
// (long invoice numbers, long addresses, big totals). Centralizing here
// means every template gets the same, safe behavior.

export function money(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "Rs. 0.00";
    return `Rs. ${x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

/** Left-to-right gradient rect. Falls back to a solid fill if c2 is missing/equal to c1. */
export function gRect(doc, x, y, w, h, c1, c2) {
    if (!c2 || c2 === c1) { doc.rect(x, y, w, h).fill(c1); return; }
    const g = doc.linearGradient(x, y, x + w, y);
    g.stop(0, c1).stop(1, c2);
    doc.rect(x, y, w, h).fill(g);
}

/** Left-to-right gradient rounded rect. */
export function gRRect(doc, x, y, w, h, r, c1, c2) {
    if (!c2 || c2 === c1) { doc.roundedRect(x, y, w, h, r).fill(c1); return; }
    const g = doc.linearGradient(x, y, x + w, y);
    g.stop(0, c1).stop(1, c2);
    doc.roundedRect(x, y, w, h, r).fill(g);
}

/** Adds a new page (re-drawing a header via callback) if `y + h` would overflow the page. */
export function overflow(doc, y, h, redrawHeader) {
    const limit = doc.page.height - doc.page.margins.bottom - 30;
    if (y + h > limit) {
        doc.addPage();
        const newY = doc.page.margins.top;
        if (typeof redrawHeader === "function") return redrawHeader(newY);
        return newY;
    }
    return y;
}

/**
 * Draws a single line of text, right- or left-aligned, that is guaranteed to
 * fit inside `maxWidth` — it measures the string and shrinks the font size
 * down (to `minSize`) rather than letting it overflow or collide with
 * neighboring text. Use this anywhere a value's length depends on real data
 * (invoice numbers, dates, money amounts) instead of fixed pixel offsets.
 */
export function fitLine(doc, text, x, maxWidth, y, opts = {}) {
    const { font = "Helvetica-Bold", startSize = 10, minSize = 7, color, align = "left" } = opts;
    const str = String(text ?? "");
    doc.font(font);
    if (color) doc.fillColor(color);
    let size = startSize;
    let w = 0;
    while (size >= minSize) {
        doc.fontSize(size);
        w = doc.widthOfString(str);
        if (w <= maxWidth) break;
        size -= 0.5;
    }
    const drawX = align === "right" ? x + maxWidth - w : x;
    doc.text(str, drawX, y, { lineBreak: false });
    return { width: w, size };
}

/**
 * Draws text inside a fixed-size box (maxWidth x maxHeight), shrinking the
 * font as needed so it never spills out. If it still doesn't fit at the
 * minimum size, it's truncated with an ellipsis. Use this for any
 * variable-length field placed inside a card — addresses, remarks, party
 * names — so a long value shrinks or truncates instead of breaking layout.
 */
export function fitText(doc, text, x, y, maxWidth, maxHeight, opts = {}) {
    const { font = "Helvetica", startSize = 9, minSize = 7, color, lineGap = 2 } = opts;
    const str = String(text ?? "");
    doc.font(font);
    if (color) doc.fillColor(color);
    let size = startSize;
    let height = 0;
    while (size >= minSize) {
        doc.fontSize(size);
        height = doc.heightOfString(str, { width: maxWidth, lineGap });
        if (height <= maxHeight) break;
        size -= 0.5;
    }
    doc.fontSize(size);
    doc.text(str, x, y, { width: maxWidth, height: maxHeight, ellipsis: true, lineGap });
    return size;
}

/**
 * Totals row: label on the left, bold value right-aligned within the box.
 * The value is measured and shrunk to fit rather than placed at a fixed
 * offset, so a large grand total can never run past the box edge.
 */
export function totalsRow(doc, label, value, boxX, boxW, y, pad, labelColor, valueColor, fs, isBold = false) {
    doc.font(isBold ? "Helvetica-Bold" : "Helvetica").fontSize(fs).fillColor(labelColor)
        .text(label, boxX + pad, y, { lineBreak: false });
    fitLine(doc, value, boxX + pad, boxW - pad * 2, y, {
        font: "Helvetica-Bold",
        startSize: fs,
        minSize: Math.max(7, fs - 3),
        color: valueColor,
        align: "right",
    });
}

/** Formats a date the same way everywhere; returns "-" for missing/invalid dates. */
export function fmtDate(d) {
    if (!d) return "-";
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return "-";
    return dt.toLocaleDateString("en-IN");
}
