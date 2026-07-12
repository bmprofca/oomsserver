// SaleInvoicePremiumLayouts.js
// Five premium PDF invoice layouts with gradient backgrounds. Black is never
// used as a background color anywhere.
//
// Rewritten to fix layout bugs from the previous version:
//  - Header invoice-no/date used to be positioned by measuring the string
//    and subtracting from a fixed x — with a long invoice number that pushes
//    the start of the text left, sometimes under the title. Now placed in a
//    fixed-width right-aligned box that shrinks the font instead of drifting
//    left indefinitely (see `metaBox` below).
//  - Party/issuer cards had a fixed height but unbounded text (`lineGap`
//    with no `height`), so a long address could grow past the card border.
//    Now uses `fitText`, which shrinks or ellipsizes to the card's actual
//    remaining height.
//  - Totals values were right-aligned via `{ width, align: 'right' }`, which
//    doesn't stop a wide value from visually crowding the label to its left.
//    Now uses the shared `totalsRow`, which measures and shrinks the value.
//  - All gradient/box/totals helpers are now imported from `pdfHelpers.js`
//    instead of being copy-pasted per file, so the three renderer files
//    can't drift out of sync again.

import { gRect, gRRect, overflow, fitText, fitLine, totalsRow, money as fmt } from "./pdfHelpers.js";

/** Right-aligned "LABEL / VALUE" pair inside a fixed box — used for invoice no / date in headers. */
function metaBox(doc, label, value, boxRight, boxW, y, { labelColor, valueColor, labelSize = 7.5, valueSize = 11 }) {
    const x = boxRight - boxW;
    doc.font("Helvetica").fontSize(labelSize).fillColor(labelColor)
        .text(label, x, y, { width: boxW, align: "right", lineBreak: false });
    fitLine(doc, value, x, boxW, y + labelSize + 3, {
        font: "Helvetica-Bold", startSize: valueSize, minSize: 8, color: valueColor, align: "right",
    });
}

// ═══════════════════════════════════════════════════════════════
// Template 1 — MODERN  (Indigo → Violet)
// Rounded gradient header, two side-by-side party cards,
// gradient table header, right-side totals summary card.
// ═══════════════════════════════════════════════════════════════
function renderModern(doc, t, { title, billToLabel, invoice, transactionRow, items, partyName, issuer }) {
    const left = doc.page.margins.left;
    const pw   = doc.page.width;
    const right = pw - doc.page.margins.right;
    const W    = right - left;
    const c1   = t.primary;
    const c2   = t.primaryEnd;
    const onP  = t.onPrimary;
    const onPs = t.onPrimarySubtle;

    // ── Header ──────────────────────────────────────────────────
    gRRect(doc, left, 18, W, 108, 14, c1, c2);

    doc.fillColor(onP).font("Helvetica-Bold").fontSize(28)
        .text(title.toUpperCase(), left + 30, 42, { width: W * 0.5, lineBreak: false });
    doc.font("Helvetica").fontSize(9).fillColor(onPs)
        .text("PROFESSIONAL TAX INVOICE", left + 30, 82, { lineBreak: false });

    const invNo   = String(invoice.invoice_no || "-");
    const invDate = invoice.create_date ? new Date(invoice.create_date).toLocaleDateString("en-IN") : "-";
    metaBox(doc, "INVOICE NO", invNo, right - 30, 170, 40, { labelColor: onPs, valueColor: onP, valueSize: 13 });
    metaBox(doc, "DATE", invDate, right - 30, 170, 80, { labelColor: onPs, valueColor: onP, valueSize: 11 });

    // ── Party cards ─────────────────────────────────────────────
    let y = 145;
    const cardW = Math.floor((W - 16) / 2);
    const cardH = 92;
    const padIn = 16;

    gRRect(doc, left, y, cardW, cardH, 10, t.soft, t.softEnd);
    doc.moveTo(left, y).lineTo(left, y + cardH).lineWidth(4).stroke(c1);
    doc.fillColor(c1).font("Helvetica-Bold").fontSize(8).text("ISSUER", left + padIn, y + 16, { lineBreak: false });
    fitText(doc, issuer?.name || "Business", left + padIn, y + 30, cardW - padIn * 2, 16, { font: "Helvetica-Bold", startSize: 11, color: "#1a1a2e" });
    if (issuer?.address) {
        fitText(doc, issuer.address, left + padIn, y + 48, cardW - padIn * 2, cardH - 48 - 12, { startSize: 9, color: "#555555" });
    }

    const card2X = right - cardW;
    gRRect(doc, card2X, y, cardW, cardH, 10, t.soft, t.softEnd);
    doc.moveTo(card2X, y).lineTo(card2X, y + cardH).lineWidth(4).stroke(c2);
    doc.fillColor(c2).font("Helvetica-Bold").fontSize(8).text(billToLabel.toUpperCase(), card2X + padIn, y + 16, { lineBreak: false });
    fitText(doc, partyName || "-", card2X + padIn, y + 30, cardW - padIn * 2, cardH - 30 - 12, { font: "Helvetica-Bold", startSize: 11, color: "#1a1a2e" });

    // ── Table ────────────────────────────────────────────────────
    y += cardH + 20;
    const cD  = left;
    const cA  = left + W * 0.55;
    const cT  = left + W * 0.72;
    const cTo = left + W * 0.88;
    const dW  = cA - cD - 20;

    const drawHead = (sy) => {
        gRRect(doc, left, sy, W, 36, 6, c1, c2);
        doc.fillColor(onP).font("Helvetica-Bold").fontSize(9.5);
        doc.text("DESCRIPTION", cD + 14, sy + 13, { lineBreak: false });
        doc.text("AMOUNT",  cA,      sy + 13, { lineBreak: false });
        doc.text("TAX",     cT,      sy + 13, { lineBreak: false });
        doc.text("TOTAL",   cTo - 8, sy + 13, { lineBreak: false });
        return sy + 36;
    };
    y = drawHead(y);

    for (let i = 0; i < items.length; i++) {
        const it  = items[i];
        const txt = it.service_name || "Item";
        doc.font("Helvetica").fontSize(10);
        const rH  = Math.max(40, doc.heightOfString(txt, { width: dW }) + 22);
        y = overflow(doc, y, rH, drawHead);

        doc.rect(left, y, W, rH).fill(i % 2 === 0 ? "#ffffff" : t.rowAlt);
        doc.moveTo(left, y + rH).lineTo(right, y + rH).lineWidth(0.5).stroke(t.border);

        const mY = y + Math.round((rH - 12) / 2);
        doc.fillColor("#1a1a2e").font("Helvetica-Bold").fontSize(10)
            .text(txt, cD + 14, y + 14, { width: dW, lineBreak: false });
        doc.fillColor("#444444").font("Helvetica").fontSize(10);
        doc.text(fmt(it.fees),      cA,      mY, { lineBreak: false });
        doc.text(fmt(it.tax_value), cT,      mY, { lineBreak: false });
        fitLine(doc, fmt(it.total), cTo - 8, right - 12 - (cTo - 8), mY, { font: "Helvetica-Bold", startSize: 10, minSize: 8, color: c2, align: "right" });
        y += rH;
    }

    // ── Totals ───────────────────────────────────────────────────
    y = overflow(doc, y, 175);
    y += 26;
    const tW  = 268;
    const tX  = right - tW;
    const tH  = 155;
    const pad = 22;

    gRRect(doc, tX, y, tW, tH, 12, t.soft, t.softEnd);
    gRect(doc, tX, y, tW, 5, c1, c2);

    let ty = y + 22;
    totalsRow(doc, "Subtotal",        fmt(invoice.subtotal),          tX, tW, ty, pad, c1, "#222222", 10); ty += 26;
    totalsRow(doc, `Tax (${Number(invoice.tax_rate||0).toFixed(2)}%)`, fmt(invoice.tax_value), tX, tW, ty, pad, c1, "#222222", 10); ty += 26;
    if (Number(invoice.additional_charge) > 0) {
        totalsRow(doc, "Additional", fmt(invoice.additional_charge), tX, tW, ty, pad, c1, "#222222", 10); ty += 26;
    }
    doc.moveTo(tX + 16, ty).lineTo(tX + tW - 16, ty).lineWidth(0.8).stroke(t.border); ty += 16;
    totalsRow(doc, "GRAND TOTAL", fmt(invoice.grand_total), tX, tW, ty, pad, c1, c2, 13, true);

    if (transactionRow?.remark) {
        const rW = W - tW - 20;
        gRRect(doc, left, y, rW, tH, 12, t.soft, t.softEnd);
        doc.fillColor(c1).font("Helvetica-Bold").fontSize(8.5).text("NOTES", left + 18, y + 18, { lineBreak: false });
        fitText(doc, transactionRow.remark, left + 18, y + 36, rW - 36, tH - 36 - 16, { startSize: 9, color: "#444444", lineGap: 3 });
    }
}

// ═══════════════════════════════════════════════════════════════
// Template 2 — ELEGANT  (Amber → Deep Rose)
// Centered title, hairline separators, full-width table,
// accent-border totals box, floating party section.
// ═══════════════════════════════════════════════════════════════
function renderElegant(doc, t, { title, billToLabel, invoice, transactionRow, items, partyName, issuer }) {
    const left  = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const W     = right - left;
    const c1    = t.primary;
    const c2    = t.primaryEnd;
    const onP   = t.onPrimary;
    const onPs  = t.onPrimarySubtle;

    // ── Header gradient bar ──────────────────────────────────────
    gRect(doc, left, 20, W, 95, c1, c2);
    gRect(doc, left, 115, W, 3, t.accent, t.accentEnd);
    gRect(doc, left, 120, W, 1, t.accent, t.accentEnd);

    doc.fillColor(onP).font("Helvetica-Bold").fontSize(26)
        .text(title.toUpperCase(), left + 24, 40, { width: W * 0.55, lineBreak: false });
    doc.fillColor(onPs).font("Helvetica").fontSize(8.5)
        .text("OFFICIAL TAX DOCUMENT", left + 24, 78, { lineBreak: false });

    const invNo   = String(invoice.invoice_no || "-");
    const invDate = invoice.create_date ? new Date(invoice.create_date).toLocaleDateString("en-IN") : "-";
    metaBox(doc, "INV. NO", invNo, right - 26, 160, 36, { labelColor: onPs, valueColor: onP, valueSize: 12 });
    metaBox(doc, "DATE", invDate, right - 26, 160, 74, { labelColor: onPs, valueColor: onP, valueSize: 10 });

    // ── Metadata row ─────────────────────────────────────────────
    let y = 140;
    const col3W = Math.floor(W / 3);
    const txDate = transactionRow?.transaction_date ? new Date(transactionRow.transaction_date).toLocaleDateString("en-IN") : "-";
    const metaCols = [
        { label: "INVOICE NO",       val: invNo },
        { label: "ISSUE DATE",       val: invDate },
        { label: "TRANSACTION DATE", val: txDate },
    ];
    metaCols.forEach((m, i) => {
        const mx = left + i * col3W;
        doc.fillColor("#8a7a6a").font("Helvetica").fontSize(7.5)
            .text(m.label, mx, y, { width: col3W, align: "center", lineBreak: false });
        fitLine(doc, m.val, mx, col3W, y + 13, { font: "Helvetica-Bold", startSize: 10.5, minSize: 8, color: "#1f1a17", align: "left" });
    });
    doc.moveTo(left, y + 40).lineTo(right, y + 40).lineWidth(0.5).stroke("#e8ddd0");

    // ── Party sections ───────────────────────────────────────────
    y += 58;
    const halfW = Math.floor((W - 20) / 2);

    doc.moveTo(left, y).lineTo(left, y + 72).lineWidth(4).stroke(c1);
    doc.fillColor(c1).font("Helvetica-Bold").fontSize(8).text("ISSUED BY", left + 14, y, { lineBreak: false });
    fitText(doc, issuer?.name || "Business", left + 14, y + 14, halfW - 20, 16, { font: "Helvetica-Bold", startSize: 11, color: "#1f1a17" });
    if (issuer?.address) {
        fitText(doc, issuer.address, left + 14, y + 30, halfW - 20, 42, { startSize: 9, color: "#5a4d42" });
    }

    const toX = left + halfW + 20;
    doc.moveTo(toX, y).lineTo(toX, y + 72).lineWidth(4).stroke(c2);
    doc.fillColor(c2).font("Helvetica-Bold").fontSize(8).text(billToLabel.toUpperCase(), toX + 14, y, { lineBreak: false });
    fitText(doc, partyName || "-", toX + 14, y + 14, halfW - 20, 56, { font: "Helvetica-Bold", startSize: 11, color: "#1f1a17" });

    // ── Table ────────────────────────────────────────────────────
    y += 90;
    const cD  = left;
    const cA  = left + W * 0.55;
    const cT  = left + W * 0.72;
    const cTo = left + W * 0.88;
    const dW  = cA - cD - 18;

    const drawHead = (sy) => {
        gRect(doc, left, sy, W, 34, c1, c2);
        doc.fillColor(onP).font("Helvetica-Bold").fontSize(9);
        doc.text("DESCRIPTION", cD + 12, sy + 12, { lineBreak: false });
        doc.text("AMOUNT",  cA,      sy + 12, { lineBreak: false });
        doc.text("TAX",     cT,      sy + 12, { lineBreak: false });
        doc.text("TOTAL",   cTo - 8, sy + 12, { lineBreak: false });
        return sy + 34;
    };
    y = drawHead(y);

    for (let i = 0; i < items.length; i++) {
        const it  = items[i];
        const txt = it.service_name || "Item";
        doc.font("Helvetica").fontSize(10);
        const rH = Math.max(38, doc.heightOfString(txt, { width: dW }) + 20);
        y = overflow(doc, y, rH, drawHead);
        doc.rect(left, y, W, rH).fill(i % 2 === 0 ? "#ffffff" : t.rowAlt);
        doc.moveTo(left, y + rH).lineTo(right, y + rH).lineWidth(0.5).stroke(t.border);
        const mY = y + Math.round((rH - 12) / 2);
        doc.fillColor("#241c15").font("Helvetica-Bold").fontSize(10)
            .text(txt, cD + 12, y + 12, { width: dW, lineBreak: false });
        doc.fillColor("#5a4d42").font("Helvetica").fontSize(10);
        doc.text(fmt(it.fees),      cA,      mY, { lineBreak: false });
        doc.text(fmt(it.tax_value), cT,      mY, { lineBreak: false });
        fitLine(doc, fmt(it.total), cTo - 8, right - 12 - (cTo - 8), mY, { font: "Helvetica-Bold", startSize: 10, minSize: 8, color: c1, align: "right" });
        y += rH;
    }

    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).stroke(t.border);

    // ── Totals ───────────────────────────────────────────────────
    y = overflow(doc, y, 175);
    y += 26;
    const tW  = 262;
    const tX  = right - tW;
    const tH  = 148;
    const pad = 20;

    gRRect(doc, tX, y, tW, tH, 8, t.soft, t.softEnd);
    gRect(doc, tX, y, 4, tH, c1, c2);

    let ty = y + 20;
    totalsRow(doc, "Subtotal",        fmt(invoice.subtotal),          tX, tW, ty, pad, c1, "#222222", 10); ty += 25;
    totalsRow(doc, `Tax (${Number(invoice.tax_rate||0).toFixed(2)}%)`, fmt(invoice.tax_value), tX, tW, ty, pad, c1, "#222222", 10); ty += 25;
    if (Number(invoice.additional_charge) > 0) {
        totalsRow(doc, "Additional", fmt(invoice.additional_charge), tX, tW, ty, pad, c1, "#222222", 10); ty += 25;
    }
    doc.moveTo(tX + 14, ty).lineTo(tX + tW - 14, ty).lineWidth(0.8).stroke(t.accent); ty += 14;
    totalsRow(doc, "GRAND TOTAL", fmt(invoice.grand_total), tX, tW, ty, pad, c1, c2, 13, true);

    if (transactionRow?.remark) {
        const rW = W - tW - 18;
        gRRect(doc, left, y, rW, tH, 8, t.soft, t.softEnd);
        doc.fillColor(c1).font("Helvetica-Bold").fontSize(8.5).text("REMARKS", left + 16, y + 18, { lineBreak: false });
        fitText(doc, transactionRow.remark, left + 16, y + 34, rW - 32, tH - 34 - 14, { startSize: 9, color: "#5a4d42", lineGap: 3 });
    }
}

// ═══════════════════════════════════════════════════════════════
// Template 3 — CORPORATE  (Blue → Teal, vertical sidebar)
// Full-height gradient sidebar, right-side content area,
// rotated title in sidebar, structured grid header.
// ═══════════════════════════════════════════════════════════════
function renderCorporate(doc, t, { title, billToLabel, invoice, transactionRow, items, partyName, issuer }) {
    const PW   = doc.page.width;
    const PH   = doc.page.height;
    const rMar = doc.page.margins.right;
    const c1   = t.primary;
    const c2   = t.primaryEnd;
    const onP  = t.onPrimary;
    const onPs = t.onPrimarySubtle;

    // ── Gradient sidebar ─────────────────────────────────────────
    const sbW = 108;
    gRect(doc, 0, 0, sbW, PH, c1, c2);
    gRect(doc, sbW, 0, 5, PH, t.accent, t.accentEnd);

    doc.save();
    doc.translate(sbW / 2 + 8, PH - 50);
    doc.rotate(-90);
    doc.fillColor(t.accentEnd).font("Helvetica-Bold").fontSize(30).text(title.toUpperCase(), 0, 0, { lineBreak: false });
    doc.restore();

    // ── Main content area ─────────────────────────────────────────
    const mLeft = sbW + 18;
    const mRight = PW - rMar;
    const mW     = mRight - mLeft;

    gRect(doc, mLeft, 30, mW, 86, c1, c2);
    doc.fillColor(onP).font("Helvetica-Bold").fontSize(22)
        .text("INVOICE", mLeft + 18, 52, { lineBreak: false });
    doc.fillColor(onPs).font("Helvetica").fontSize(8.5)
        .text("OFFICIAL DOCUMENT", mLeft + 18, 82, { lineBreak: false });

    const invNo   = String(invoice.invoice_no || "-");
    const invDate = invoice.create_date ? new Date(invoice.create_date).toLocaleDateString("en-IN") : "-";
    metaBox(doc, "NO", invNo, mRight - 22, 150, 36, { labelColor: onPs, valueColor: onP, valueSize: 11 });
    metaBox(doc, "DATE", invDate, mRight - 22, 150, 68, { labelColor: onPs, valueColor: onP, valueSize: 10 });

    doc.moveTo(mLeft, 130).lineTo(mRight, 130).lineWidth(1).stroke(t.soft);

    // Metadata grid
    let y = 148;
    const col3W = Math.floor(mW / 3);
    const txDate = transactionRow?.transaction_date ? new Date(transactionRow.transaction_date).toLocaleDateString("en-IN") : "-";
    [{ l: "INVOICE NO", v: invNo }, { l: "DATE", v: invDate }, { l: "TRANSACTION", v: txDate }].forEach((m, i) => {
        const mx = mLeft + i * col3W;
        doc.fillColor(c1).font("Helvetica-Bold").fontSize(8).text(m.l, mx, y, { lineBreak: false });
        fitLine(doc, m.v, mx, col3W - 10, y + 13, { font: "Helvetica-Bold", startSize: 11, minSize: 8, color: "#111111", align: "left" });
    });

    // Party
    y += 46;
    doc.moveTo(mLeft, y).lineTo(mLeft, y + 74).lineWidth(4).stroke(c1);
    doc.fillColor(c1).font("Helvetica-Bold").fontSize(8).text("FROM", mLeft + 14, y, { lineBreak: false });
    fitText(doc, issuer?.name || "Business", mLeft + 14, y + 14, mW / 2 - 22, 16, { font: "Helvetica-Bold", startSize: 11, color: "#111111" });
    if (issuer?.address) {
        fitText(doc, issuer.address, mLeft + 14, y + 30, mW / 2 - 22, 44, { startSize: 9, color: "#555555" });
    }
    const toX = mLeft + mW / 2 + 8;
    doc.moveTo(toX, y).lineTo(toX, y + 74).lineWidth(4).stroke(c2);
    doc.fillColor(c2).font("Helvetica-Bold").fontSize(8).text(billToLabel.toUpperCase(), toX + 14, y, { lineBreak: false });
    fitText(doc, partyName || "-", toX + 14, y + 14, mW / 2 - 22, 58, { font: "Helvetica-Bold", startSize: 11, color: "#111111" });

    // ── Table ────────────────────────────────────────────────────
    y += 94;
    const cD  = mLeft;
    const cA  = mLeft + mW * 0.55;
    const cT  = mLeft + mW * 0.72;
    const cTo = mLeft + mW * 0.88;
    const dW  = cA - cD - 18;

    const drawHead = (sy) => {
        gRect(doc, mLeft, sy, mW, 34, c1, c2);
        doc.fillColor(onP).font("Helvetica-Bold").fontSize(9);
        doc.text("DESCRIPTION", cD + 12, sy + 12, { lineBreak: false });
        doc.text("AMOUNT",  cA,       sy + 12, { lineBreak: false });
        doc.text("TAX",     cT,       sy + 12, { lineBreak: false });
        doc.text("TOTAL",   cTo - 8,  sy + 12, { lineBreak: false });
        return sy + 34;
    };
    y = drawHead(y);

    for (let i = 0; i < items.length; i++) {
        const it  = items[i];
        const txt = it.service_name || "Item";
        doc.font("Helvetica").fontSize(10);
        const rH = Math.max(38, doc.heightOfString(txt, { width: dW }) + 20);
        y = overflow(doc, y, rH, drawHead);
        doc.rect(mLeft, y, mW, rH).fill(i % 2 === 0 ? "#ffffff" : t.rowAlt);
        doc.moveTo(mLeft, y + rH).lineTo(mRight, y + rH).lineWidth(0.5).stroke(t.border);
        const mY = y + Math.round((rH - 12) / 2);
        doc.fillColor("#1a1a2e").font("Helvetica-Bold").fontSize(10)
            .text(txt, cD + 12, y + 12, { width: dW, lineBreak: false });
        doc.fillColor("#444444").font("Helvetica").fontSize(10);
        doc.text(fmt(it.fees),      cA,      mY, { lineBreak: false });
        doc.text(fmt(it.tax_value), cT,      mY, { lineBreak: false });
        fitLine(doc, fmt(it.total), cTo - 8, mRight - 12 - (cTo - 8), mY, { font: "Helvetica-Bold", startSize: 10, minSize: 8, color: c2, align: "right" });
        y += rH;
    }

    // ── Totals ───────────────────────────────────────────────────
    y = overflow(doc, y, 175);
    y += 26;
    const tW  = 256;
    const tX  = mRight - tW;
    const tH  = 148;
    const pad = 20;

    gRRect(doc, tX, y, tW, tH, 8, t.soft, t.softEnd);
    gRect(doc, tX, y, 4, tH, c1, c2);

    let ty = y + 20;
    totalsRow(doc, "Subtotal",        fmt(invoice.subtotal),          tX, tW, ty, pad, c1, "#222222", 10); ty += 25;
    totalsRow(doc, `Tax (${Number(invoice.tax_rate||0).toFixed(2)}%)`, fmt(invoice.tax_value), tX, tW, ty, pad, c1, "#222222", 10); ty += 25;
    if (Number(invoice.additional_charge) > 0) {
        totalsRow(doc, "Additional", fmt(invoice.additional_charge), tX, tW, ty, pad, c1, "#222222", 10); ty += 25;
    }
    doc.moveTo(tX + 14, ty).lineTo(tX + tW - 14, ty).lineWidth(0.8).stroke(t.accent); ty += 14;
    totalsRow(doc, "GRAND TOTAL", fmt(invoice.grand_total), tX, tW, ty, pad, c1, c2, 13, true);

    if (transactionRow?.remark) {
        doc.fillColor(c1).font("Helvetica-Bold").fontSize(8.5).text("REMARKS", mLeft, y, { lineBreak: false });
        fitText(doc, transactionRow.remark, mLeft, y + 16, mW - tW - 18, tH - 16, { startSize: 9, color: "#444444", lineGap: 3 });
    }
}

// ═══════════════════════════════════════════════════════════════
// Template 4 — CREATIVE  (Violet → Magenta, bold agency style)
// Bold gradient left accent strip, large gradient header,
// bold party labels, vivid table, accent-top totals.
// ═══════════════════════════════════════════════════════════════
function renderCreative(doc, t, { title, billToLabel, invoice, transactionRow, items, partyName, issuer }) {
    const left  = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const PH    = doc.page.height;
    const W     = right - left;
    const c1    = t.primary;
    const c2    = t.primaryEnd;
    const onP   = t.onPrimary;
    const onPs  = t.onPrimarySubtle;

    // ── Vertical accent strip (left edge, full height) ──────────
    gRect(doc, 0, 0, 22, PH, c1, c2);

    // ── Header gradient block ────────────────────────────────────
    gRect(doc, 22, 24, right + doc.page.margins.right - 22, 106, c1, c2);

    doc.fillColor(onP).font("Helvetica-Bold").fontSize(28)
        .text(title.toUpperCase(), left + 20, 48, { width: W * 0.55, lineBreak: false });
    doc.fillColor(onPs).font("Helvetica-Bold").fontSize(8)
        .text("TAX INVOICE", left + 20, 90, { lineBreak: false });

    const invNo   = String(invoice.invoice_no || "-");
    const invDate = invoice.create_date ? new Date(invoice.create_date).toLocaleDateString("en-IN") : "-";
    metaBox(doc, "INV NO", invNo, right - 24, 160, 44, { labelColor: onPs, valueColor: onP, valueSize: 11 });
    metaBox(doc, "DATE", invDate, right - 24, 160, 80, { labelColor: onPs, valueColor: onP, valueSize: 10 });

    // ── Party section ────────────────────────────────────────────
    let y = 152;
    doc.moveTo(left + 16, y).lineTo(left + 16, y + 78).lineWidth(5).stroke(c1);
    doc.fillColor(c1).font("Helvetica-Bold").fontSize(8).text("FROM", left + 32, y, { lineBreak: false });
    fitText(doc, issuer?.name || "Business", left + 32, y + 16, W / 2 - 50, 18, { font: "Helvetica-Bold", startSize: 12, color: "#111111" });
    if (issuer?.address) {
        fitText(doc, issuer.address, left + 32, y + 34, W / 2 - 50, 40, { startSize: 9, color: "#555555" });
    }

    const toX = left + W / 2 + 16;
    doc.moveTo(toX, y).lineTo(toX, y + 78).lineWidth(5).stroke(c2);
    doc.fillColor(c2).font("Helvetica-Bold").fontSize(8)
        .text(billToLabel.toUpperCase(), toX + 16, y, { lineBreak: false });
    fitText(doc, partyName || "-", toX + 16, y + 16, W / 2 - 50, 58, { font: "Helvetica-Bold", startSize: 12, color: "#111111" });

    // ── Table ────────────────────────────────────────────────────
    y += 100;
    const cD  = left;
    const cA  = left + W * 0.55;
    const cT  = left + W * 0.72;
    const cTo = left + W * 0.88;
    const dW  = cA - cD - 22;

    const drawHead = (sy) => {
        gRect(doc, left, sy, W, 38, c1, c2);
        doc.fillColor(onP).font("Helvetica-Bold").fontSize(9.5);
        doc.text("DESCRIPTION", cD + 14, sy + 14, { lineBreak: false });
        doc.text("AMOUNT",  cA,       sy + 14, { lineBreak: false });
        doc.text("TAX",     cT,       sy + 14, { lineBreak: false });
        doc.text("TOTAL",   cTo - 8,  sy + 14, { lineBreak: false });
        return sy + 38;
    };
    y = drawHead(y);

    for (let i = 0; i < items.length; i++) {
        const it  = items[i];
        const txt = it.service_name || "Item";
        doc.font("Helvetica").fontSize(10);
        const rH = Math.max(40, doc.heightOfString(txt, { width: dW }) + 22);
        y = overflow(doc, y, rH, drawHead);
        doc.rect(left, y, W, rH).fill(i % 2 === 0 ? "#ffffff" : t.rowAlt);
        doc.moveTo(left, y + rH).lineTo(right, y + rH).lineWidth(0.5).stroke(t.border);
        const mY = y + Math.round((rH - 12) / 2);
        doc.fillColor("#1a1a1a").font("Helvetica-Bold").fontSize(10)
            .text(txt, cD + 14, y + 14, { width: dW, lineBreak: false });
        doc.fillColor("#444444").font("Helvetica").fontSize(10);
        doc.text(fmt(it.fees),      cA,      mY, { lineBreak: false });
        doc.text(fmt(it.tax_value), cT,      mY, { lineBreak: false });
        fitLine(doc, fmt(it.total), cTo - 8, right - 12 - (cTo - 8), mY, { font: "Helvetica-Bold", startSize: 10, minSize: 8, color: c2, align: "right" });
        y += rH;
    }

    // ── Totals ───────────────────────────────────────────────────
    y = overflow(doc, y, 175);
    y += 28;
    const tW  = 262;
    const tX  = right - tW;
    const tH  = 148;
    const pad = 20;

    gRRect(doc, tX, y, tW, tH, 8, t.soft, t.softEnd);
    gRect(doc, tX, y, tW, 6, c1, c2);

    let ty = y + 24;
    totalsRow(doc, "Subtotal",        fmt(invoice.subtotal),          tX, tW, ty, pad, c1, "#222222", 10); ty += 25;
    totalsRow(doc, `Tax (${Number(invoice.tax_rate||0).toFixed(2)}%)`, fmt(invoice.tax_value), tX, tW, ty, pad, c1, "#222222", 10); ty += 25;
    if (Number(invoice.additional_charge) > 0) {
        totalsRow(doc, "Additional", fmt(invoice.additional_charge), tX, tW, ty, pad, c1, "#222222", 10); ty += 25;
    }
    doc.moveTo(tX + 14, ty).lineTo(tX + tW - 14, ty).lineWidth(1).stroke(t.border); ty += 14;
    totalsRow(doc, "TOTAL", fmt(invoice.grand_total), tX, tW, ty, pad, c1, c2, 14, true);

    if (transactionRow?.remark) {
        const rW = W - tW - 18;
        gRRect(doc, left, y, rW, tH, 8, t.soft, t.softEnd);
        doc.moveTo(left, y).lineTo(left, y + tH).lineWidth(4).stroke(c1);
        doc.fillColor(c1).font("Helvetica-Bold").fontSize(8.5).text("NOTES", left + 16, y + 18, { lineBreak: false });
        fitText(doc, transactionRow.remark, left + 16, y + 34, rW - 32, tH - 34 - 14, { startSize: 9, color: "#444444", lineGap: 3 });
    }
}

// ═══════════════════════════════════════════════════════════════
// Template 5 — LUXURY  (Deep plum/indigo → gold, jewel-box feel)
// Full-bleed gradient header with gold accents,
// side-by-side party boxes with accent borders,
// gradient table header with gold text,
// dark gradient totals card (light text on gradient).
// ═══════════════════════════════════════════════════════════════
function renderLuxury(doc, t, { title, billToLabel, invoice, transactionRow, items, partyName, issuer }) {
    const left  = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const PW    = doc.page.width;
    const W     = right - left;
    const c1    = t.primary;
    const c2    = t.primaryEnd;
    const gold  = t.accent;
    const gold2 = t.accentEnd;

    // ── Full-bleed gradient header ───────────────────────────────
    gRect(doc, 0, 0, PW, 130, c1, c2);
    gRect(doc, 0, 130, PW, 4, gold, gold2);

    doc.fillColor(gold).font("Helvetica-Bold").fontSize(28)
        .text(title.toUpperCase(), left, 40, { width: W * 0.55, lineBreak: false });
    doc.fillColor(t.onPrimarySubtle).font("Helvetica").fontSize(8.5)
        .text("OFFICIAL TAX DOCUMENT", left, 80, { lineBreak: false });

    const invNo   = String(invoice.invoice_no || "-");
    const invDate = invoice.create_date ? new Date(invoice.create_date).toLocaleDateString("en-IN") : "-";
    metaBox(doc, "INVOICE NO", invNo, right - 24, 170, 36, { labelColor: t.onPrimarySubtle, valueColor: gold, valueSize: 11 });
    metaBox(doc, "DATE", invDate, right - 24, 170, 72, { labelColor: t.onPrimarySubtle, valueColor: gold, valueSize: 10 });

    // ── Party boxes ──────────────────────────────────────────────
    let y = 156;
    const bW = Math.floor((W - 20) / 2);
    const bH = 96;

    gRRect(doc, left, y, bW, bH, 8, t.soft, t.softEnd);
    gRect(doc, left, y, 4, bH, c1, c2);
    doc.fillColor(c1).font("Helvetica-Bold").fontSize(8).text("BILL FROM", left + 16, y + 16, { lineBreak: false });
    fitText(doc, issuer?.name || "Business", left + 16, y + 32, bW - 32, 16, { font: "Helvetica-Bold", startSize: 11, color: "#111111" });
    if (issuer?.address) {
        fitText(doc, issuer.address, left + 16, y + 50, bW - 32, bH - 50 - 12, { startSize: 9, color: "#555555" });
    }

    const bX2 = right - bW;
    gRRect(doc, bX2, y, bW, bH, 8, t.soft, t.softEnd);
    gRect(doc, bX2, y, 4, bH, gold, gold2);
    doc.fillColor("#92650c").font("Helvetica-Bold").fontSize(8).text(billToLabel.toUpperCase(), bX2 + 16, y + 16, { lineBreak: false });
    fitText(doc, partyName || "-", bX2 + 16, y + 32, bW - 32, bH - 32 - 12, { font: "Helvetica-Bold", startSize: 11, color: "#111111" });

    // ── Table ────────────────────────────────────────────────────
    y += bH + 24;
    const cD  = left;
    const cA  = left + W * 0.55;
    const cT  = left + W * 0.72;
    const cTo = left + W * 0.88;
    const dW  = cA - cD - 20;

    const drawHead = (sy) => {
        gRect(doc, left, sy, W, 36, c1, c2);
        doc.fillColor(gold).font("Helvetica-Bold").fontSize(9.5);
        doc.text("DESCRIPTION", cD + 14, sy + 12, { lineBreak: false });
        doc.text("AMOUNT",  cA,       sy + 12, { lineBreak: false });
        doc.text("TAX",     cT,       sy + 12, { lineBreak: false });
        doc.text("TOTAL",   cTo - 8,  sy + 12, { lineBreak: false });
        return sy + 36;
    };
    y = drawHead(y);

    for (let i = 0; i < items.length; i++) {
        const it  = items[i];
        const txt = it.service_name || "Item";
        doc.font("Helvetica").fontSize(10);
        const rH = Math.max(40, doc.heightOfString(txt, { width: dW }) + 22);
        y = overflow(doc, y, rH, drawHead);
        doc.rect(left, y, W, rH).fill(i % 2 === 0 ? "#ffffff" : t.rowAlt);
        doc.moveTo(left, y + rH).lineTo(right, y + rH).lineWidth(0.5).stroke(t.border);
        const mY = y + Math.round((rH - 12) / 2);
        doc.fillColor("#1a1a1a").font("Helvetica-Bold").fontSize(10)
            .text(txt, cD + 14, y + 14, { width: dW, lineBreak: false });
        doc.fillColor("#555555").font("Helvetica").fontSize(10);
        doc.text(fmt(it.fees),      cA,      mY, { lineBreak: false });
        doc.text(fmt(it.tax_value), cT,      mY, { lineBreak: false });
        fitLine(doc, fmt(it.total), cTo - 8, right - 12 - (cTo - 8), mY, { font: "Helvetica-Bold", startSize: 10, minSize: 8, color: c1, align: "right" });
        y += rH;
    }

    // ── Totals — dark gradient card (light text) ─────────────────
    y = overflow(doc, y, 175);
    y += 28;
    const tW  = 260;
    const tX  = right - tW;
    const tH  = 150;
    const pad = 20;

    gRRect(doc, tX, y, tW, tH, 10, c1, c2);
    gRect(doc, tX, y, 4, tH, gold, gold2);

    let ty = y + 22;
    totalsRow(doc, "Subtotal",        fmt(invoice.subtotal),          tX, tW, ty, pad, "rgba(255,255,255,0.65)", "#ffffff", 10); ty += 25;
    totalsRow(doc, `Tax (${Number(invoice.tax_rate||0).toFixed(2)}%)`, fmt(invoice.tax_value), tX, tW, ty, pad, "rgba(255,255,255,0.65)", "#ffffff", 10); ty += 25;
    if (Number(invoice.additional_charge) > 0) {
        totalsRow(doc, "Additional", fmt(invoice.additional_charge), tX, tW, ty, pad, "rgba(255,255,255,0.65)", "#ffffff", 10); ty += 25;
    }
    doc.moveTo(tX + 14, ty).lineTo(tX + tW - 14, ty).lineWidth(0.8).stroke(gold); ty += 14;
    totalsRow(doc, "GRAND TOTAL", fmt(invoice.grand_total), tX, tW, ty, pad, gold, gold, 14, true);

    if (transactionRow?.remark) {
        const rW = W - tW - 18;
        gRRect(doc, left, y, rW, tH, 10, t.soft, t.softEnd);
        gRect(doc, left, y, 4, tH, gold, gold2);
        doc.fillColor(c2).font("Helvetica-Bold").fontSize(8.5).text("REMARKS", left + 16, y + 20, { lineBreak: false });
        fitText(doc, transactionRow.remark, left + 16, y + 36, rW - 32, tH - 36 - 16, { startSize: 9, color: "#333333", lineGap: 3 });
    }
}

// ─── Export as premiumRenderers map (consumed by SaleInvoicePdf.js) ────────
export const premiumRenderers = {
    premium_modern:    renderModern,
    premium_elegant:   renderElegant,
    premium_corporate: renderCorporate,
    premium_creative:  renderCreative,
    premium_luxury:    renderLuxury,
};
