// SaleInvoicePremiumLayouts.js
// Five completely unique premium PDF invoice layouts using gradient backgrounds.
// Black is NEVER used as a background color anywhere. Gradients everywhere.

// ─── Helpers ───────────────────────────────────────────────────

function money(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "Rs. 0.00";
    return `Rs. ${x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

const fmt = money;

/**
 * Fills a rectangle with a left-to-right linear gradient.
 * Falls back to solid color1 if color2 is not provided.
 */
function gRect(doc, x, y, w, h, c1, c2) {
    if (!c2 || c2 === c1) { doc.rect(x, y, w, h).fill(c1); return; }
    const g = doc.linearGradient(x, y, x + w, y);
    g.stop(0, c1).stop(1, c2);
    doc.rect(x, y, w, h).fill(g);
}

/**
 * Fills a rounded rectangle with a left-to-right linear gradient.
 */
function gRRect(doc, x, y, w, h, r, c1, c2) {
    if (!c2 || c2 === c1) { doc.roundedRect(x, y, w, h, r).fill(c1); return; }
    const g = doc.linearGradient(x, y, x + w, y);
    g.stop(0, c1).stop(1, c2);
    doc.roundedRect(x, y, w, h, r).fill(g);
}

/**
 * Check if y + height overflows page; if so add new page.
 */
function overflow(doc, y, h, redrawHeader) {
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
 * Draw a label on the left and a value right-aligned within a box —
 * using widthOfString so the value NEVER wraps onto multiple lines.
 */
function totalsRow(doc, label, value, boxX, boxW, y, pad, labelColor, valueColor, fs) {
    doc.font("Helvetica").fontSize(fs).fillColor(labelColor)
        .text(label, boxX + pad, y, { lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(fs).fillColor(valueColor);
    const vw = doc.widthOfString(value);
    doc.text(value, boxX + boxW - pad - vw, y, { lineBreak: false });
}

// ═══════════════════════════════════════════════════════════════
// Template 1 — MODERN  (Indigo → Violet)
// Layout: Rounded gradient header, two side-by-side party cards,
//         gradient table header, right-side totals summary card.
// ═══════════════════════════════════════════════════════════════
function renderModern(doc, t, { title, billToLabel, invoice, transactionRow, items, partyName, issuer }) {
    const left = doc.page.margins.left;
    const pw   = doc.page.width;
    const right = pw - doc.page.margins.right;
    const W    = right - left;
    const c1   = t.primary;
    const c2   = t.primaryEnd || "#7c3aed";

    // ── Header ──────────────────────────────────────────────────
    gRRect(doc, left, 18, W, 108, 14, c1, c2);

    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(30)
        .text(title.toUpperCase(), left + 30, 44, { lineBreak: false });
    doc.font("Helvetica").fontSize(9).fillColor("rgba(255,255,255,0.65)")
        .text("PROFESSIONAL TAX INVOICE", left + 30, 84, { lineBreak: false });

    // Invoice meta — top right of header
    const invNo   = String(invoice.invoice_no || "-");
    const invDate = invoice.create_date ? new Date(invoice.create_date).toLocaleDateString("en-IN") : "-";
    doc.font("Helvetica").fontSize(8).fillColor("rgba(255,255,255,0.6)")
        .text("INVOICE NO:", right - 30 - doc.widthOfString(invNo, { size: 13 }), 44, { lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(13).fillColor("#ffffff")
        .text(invNo, right - 30 - doc.widthOfString(invNo, { size: 13 }), 57, { lineBreak: false });
    doc.font("Helvetica").fontSize(8).fillColor("rgba(255,255,255,0.6)")
        .text("DATE:", right - 30 - doc.widthOfString(invDate, { size: 11 }), 82, { lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#ffffff")
        .text(invDate, right - 30 - doc.widthOfString(invDate, { size: 11 }), 94, { lineBreak: false });

    // ── Party cards ─────────────────────────────────────────────
    let y = 145;
    const cardW = Math.floor((W - 16) / 2);
    const cardH = 92;

    gRRect(doc, left, y, cardW, cardH, 10, t.soft || "#eef2ff", t.softEnd || "#ede9fe");
    doc.moveTo(left, y).lineTo(left, y + cardH).lineWidth(4).stroke(c1);
    doc.fillColor(c1).font("Helvetica-Bold").fontSize(8)
        .text("ISSUER", left + 16, y + 16, { lineBreak: false });
    doc.fillColor("#1a1a2e").font("Helvetica-Bold").fontSize(11)
        .text(issuer?.name || "Business", left + 16, y + 30, { lineBreak: false });
    if (issuer?.address) {
        doc.fillColor("#555555").font("Helvetica").fontSize(9)
            .text(issuer.address, left + 16, y + 48, { width: cardW - 32, lineGap: 2 });
    }

    const card2X = right - cardW;
    gRRect(doc, card2X, y, cardW, cardH, 10, t.soft || "#eef2ff", t.softEnd || "#ede9fe");
    doc.moveTo(card2X, y).lineTo(card2X, y + cardH).lineWidth(4).stroke(c2);
    doc.fillColor(c2).font("Helvetica-Bold").fontSize(8)
        .text(billToLabel.toUpperCase(), card2X + 16, y + 16, { lineBreak: false });
    doc.fillColor("#1a1a2e").font("Helvetica-Bold").fontSize(11)
        .text(partyName || "-", card2X + 16, y + 30, { lineBreak: false });

    // ── Table ────────────────────────────────────────────────────
    y += cardH + 20;
    const cD  = left;
    const cA  = left + W * 0.55;
    const cT  = left + W * 0.72;
    const cTo = left + W * 0.88;
    const dW  = cA - cD - 20;

    const drawHead = (sy) => {
        gRRect(doc, left, sy, W, 36, 6, c1, c2);
        doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9.5);
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

        doc.rect(left, y, W, rH).fill(i % 2 === 0 ? "#ffffff" : (t.rowAlt || "#f5f3ff"));
        doc.moveTo(left, y + rH).lineTo(right, y + rH).lineWidth(0.5).stroke("#dee2f0");

        const mY = y + Math.round((rH - 12) / 2);
        doc.fillColor("#1a1a2e").font("Helvetica-Bold").fontSize(10)
            .text(txt, cD + 14, y + 14, { width: dW, lineBreak: false });
        doc.fillColor("#444444").font("Helvetica").fontSize(10);
        doc.text(fmt(it.fees),      cA,      mY, { lineBreak: false });
        doc.text(fmt(it.tax_value), cT,      mY, { lineBreak: false });
        doc.fillColor(c2).font("Helvetica-Bold")
            .text(fmt(it.total),    cTo - 8, mY, { lineBreak: false });
        y += rH;
    }

    // ── Totals ───────────────────────────────────────────────────
    y = overflow(doc, y, 175);
    y += 26;
    const tW  = 268;
    const tX  = right - tW;
    const tH  = 155;
    const pad = 22;

    gRRect(doc, tX, y, tW, tH, 12, t.soft || "#eef2ff", t.softEnd || "#ede9fe");
    gRect(doc, tX, y, tW, 5, c1, c2);

    let ty = y + 22;
    totalsRow(doc, "Subtotal",        fmt(invoice.subtotal),          tX, tW, ty, pad, c1, "#222222", 10); ty += 26;
    totalsRow(doc, `Tax (${Number(invoice.tax_rate||0).toFixed(2)}%)`, fmt(invoice.tax_value), tX, tW, ty, pad, c1, "#222222", 10); ty += 26;
    if (Number(invoice.additional_charge) > 0) {
        totalsRow(doc, "Additional", fmt(invoice.additional_charge), tX, tW, ty, pad, c1, "#222222", 10); ty += 26;
    }
    doc.moveTo(tX + 16, ty).lineTo(tX + tW - 16, ty).lineWidth(0.8).stroke("#c7d2fe"); ty += 16;
    totalsRow(doc, "GRAND TOTAL", fmt(invoice.grand_total), tX, tW, ty, pad, c1, c2, 13);

    // Remarks
    if (transactionRow?.remark) {
        const rW = W - tW - 20;
        gRRect(doc, left, y, rW, tH, 12, t.soft || "#eef2ff", t.softEnd || "#ede9fe");
        doc.fillColor(c1).font("Helvetica-Bold").fontSize(8.5)
            .text("NOTES", left + 18, y + 18, { lineBreak: false });
        doc.fillColor("#444444").font("Helvetica").fontSize(9)
            .text(String(transactionRow.remark), left + 18, y + 36, { width: rW - 36, lineGap: 3 });
    }
}

// ═══════════════════════════════════════════════════════════════
// Template 2 — ELEGANT  (Amber → Warm Rose)
// Layout: Centered title, hairline separators, full-width table,
//         accent-border totals box, floating party section.
// ═══════════════════════════════════════════════════════════════
function renderElegant(doc, t, { title, billToLabel, invoice, transactionRow, items, partyName, issuer }) {
    const left  = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const W     = right - left;
    const c1    = t.primary;
    const c2    = t.primaryEnd || "#c2410c";

    // ── Header gradient bar ──────────────────────────────────────
    gRect(doc, left, 20, W, 95, c1, c2);
    // Double accent lines at bottom of header
    gRect(doc, left, 115, W, 3, t.accent || "#f59e0b", t.accentEnd || "#f97316");
    gRect(doc, left, 120, W, 1, t.accent || "#f59e0b", t.accentEnd || "#f97316");

    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(28)
        .text(title.toUpperCase(), left + 24, 42, { lineBreak: false });
    doc.fillColor("rgba(255,255,255,0.65)").font("Helvetica").fontSize(8.5)
        .text("OFFICIAL TAX DOCUMENT", left + 24, 80, { lineBreak: false });

    // Invoice number right-aligned in header
    const invNo   = String(invoice.invoice_no || "-");
    const invDate = invoice.create_date ? new Date(invoice.create_date).toLocaleDateString("en-IN") : "-";
    doc.font("Helvetica").fontSize(8).fillColor("rgba(255,255,255,0.6)")
        .text("INV. NO:", right - 30 - doc.widthOfString(invNo, { size: 12 }), 40, { lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#ffffff")
        .text(invNo, right - 30 - doc.widthOfString(invNo, { size: 12 }), 52, { lineBreak: false });
    doc.font("Helvetica").fontSize(8).fillColor("rgba(255,255,255,0.6)")
        .text("DATE:", right - 30 - doc.widthOfString(invDate, { size: 10 }), 76, { lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#ffffff")
        .text(invDate, right - 30 - doc.widthOfString(invDate, { size: 10 }), 88, { lineBreak: false });

    // ── Metadata row ─────────────────────────────────────────────
    let y = 140;
    const col3W = Math.floor(W / 3);
    const txDate = transactionRow?.transaction_date ? new Date(transactionRow.transaction_date).toLocaleDateString("en-IN") : "-";
    const metaCols = [
        { label: "INVOICE NO",      val: invNo },
        { label: "ISSUE DATE",      val: invDate },
        { label: "TRANSACTION DATE", val: txDate },
    ];
    metaCols.forEach((m, i) => {
        const mx = left + i * col3W;
        doc.fillColor("#888888").font("Helvetica").fontSize(7.5)
            .text(m.label, mx, y, { width: col3W, align: "center", lineBreak: false });
        doc.fillColor("#111111").font("Helvetica-Bold").fontSize(10.5)
            .text(m.val, mx, y + 13, { width: col3W, align: "center", lineBreak: false });
    });
    doc.moveTo(left, y + 40).lineTo(right, y + 40).lineWidth(0.5).stroke("#e5e7eb");

    // ── Party sections ───────────────────────────────────────────
    y += 58;
    const halfW = Math.floor((W - 20) / 2);

    doc.moveTo(left, y).lineTo(left, y + 72).lineWidth(4).stroke(c1);
    doc.fillColor(c1).font("Helvetica-Bold").fontSize(8).text("ISSUED BY", left + 14, y, { lineBreak: false });
    doc.fillColor("#111111").font("Helvetica-Bold").fontSize(11).text(issuer?.name || "Business", left + 14, y + 14, { lineBreak: false });
    if (issuer?.address) {
        doc.fillColor("#555555").font("Helvetica").fontSize(9)
            .text(issuer.address, left + 14, y + 30, { width: halfW - 20, lineGap: 2 });
    }

    const toX = left + halfW + 20;
    doc.moveTo(toX, y).lineTo(toX, y + 72).lineWidth(4).stroke(c2);
    doc.fillColor(c2).font("Helvetica-Bold").fontSize(8)
        .text(billToLabel.toUpperCase(), toX + 14, y, { lineBreak: false });
    doc.fillColor("#111111").font("Helvetica-Bold").fontSize(11)
        .text(partyName || "-", toX + 14, y + 14, { lineBreak: false });

    // ── Table ────────────────────────────────────────────────────
    y += 90;
    const cD  = left;
    const cA  = left + W * 0.55;
    const cT  = left + W * 0.72;
    const cTo = left + W * 0.88;
    const dW  = cA - cD - 18;

    const drawHead = (sy) => {
        gRect(doc, left, sy, W, 34, c1, c2);
        doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9);
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
        doc.rect(left, y, W, rH).fill(i % 2 === 0 ? "#ffffff" : (t.rowAlt || "#fef3c7"));
        doc.moveTo(left, y + rH).lineTo(right, y + rH).lineWidth(0.5).stroke("#f0d9a8");
        const mY = y + Math.round((rH - 12) / 2);
        doc.fillColor("#1a1a1a").font("Helvetica-Bold").fontSize(10)
            .text(txt, cD + 12, y + 12, { width: dW, lineBreak: false });
        doc.fillColor("#555555").font("Helvetica").fontSize(10);
        doc.text(fmt(it.fees),      cA,      mY, { lineBreak: false });
        doc.text(fmt(it.tax_value), cT,      mY, { lineBreak: false });
        doc.fillColor(c1).font("Helvetica-Bold")
            .text(fmt(it.total),    cTo - 8, mY, { lineBreak: false });
        y += rH;
    }

    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).stroke("#e5e7eb");

    // ── Totals ───────────────────────────────────────────────────
    y = overflow(doc, y, 175);
    y += 26;
    const tW  = 262;
    const tX  = right - tW;
    const tH  = 148;
    const pad = 20;

    gRRect(doc, tX, y, tW, tH, 8, t.soft || "#fffbeb", t.softEnd || "#fff7ed");
    gRect(doc, tX, y, 4, tH, c1, c2);

    let ty = y + 20;
    totalsRow(doc, "Subtotal",        fmt(invoice.subtotal),          tX, tW, ty, pad, c1, "#222222", 10); ty += 25;
    totalsRow(doc, `Tax (${Number(invoice.tax_rate||0).toFixed(2)}%)`, fmt(invoice.tax_value), tX, tW, ty, pad, c1, "#222222", 10); ty += 25;
    if (Number(invoice.additional_charge) > 0) {
        totalsRow(doc, "Additional", fmt(invoice.additional_charge), tX, tW, ty, pad, c1, "#222222", 10); ty += 25;
    }
    doc.moveTo(tX + 14, ty).lineTo(tX + tW - 14, ty).lineWidth(0.8).stroke(t.accent || "#f59e0b"); ty += 14;
    totalsRow(doc, "GRAND TOTAL", fmt(invoice.grand_total), tX, tW, ty, pad, c1, c2, 13);

    if (transactionRow?.remark) {
        const rW = W - tW - 18;
        gRRect(doc, left, y, rW, tH, 8, t.soft || "#fffbeb", t.softEnd || "#fff7ed");
        doc.fillColor(c1).font("Helvetica-Bold").fontSize(8.5).text("REMARKS", left + 16, y + 18, { lineBreak: false });
        doc.fillColor("#444444").font("Helvetica").fontSize(9)
            .text(String(transactionRow.remark), left + 16, y + 34, { width: rW - 32, lineGap: 3 });
    }
}

// ═══════════════════════════════════════════════════════════════
// Template 3 — CORPORATE  (Blue → Teal, vertical sidebar)
// Layout: Full-height gradient sidebar, right-side content area,
//         rotated title in sidebar, structured grid header.
// ═══════════════════════════════════════════════════════════════
function renderCorporate(doc, t, { title, billToLabel, invoice, transactionRow, items, partyName, issuer }) {
    const PW   = doc.page.width;
    const PH   = doc.page.height;
    const rMar = doc.page.margins.right;
    const c1   = t.primary;
    const c2   = t.primaryEnd || "#0f766e";

    // ── Gradient sidebar ─────────────────────────────────────────
    const sbW = 108;
    gRect(doc, 0, 0, sbW, PH, c1, c2);
    // Accent stripe
    gRect(doc, sbW, 0, 5, PH, t.accent || "#3b82f6", t.accentEnd || "#14b8a6");

    // Rotated title in sidebar
    doc.save();
    doc.translate(sbW / 2 + 8, PH - 50);
    doc.rotate(-90);
    doc.fillColor(t.accent || "#3b82f6").font("Helvetica-Bold").fontSize(32).text(title.toUpperCase(), 0, 0, { lineBreak: false });
    doc.restore();

    // ── Main content area ─────────────────────────────────────────
    const mLeft = sbW + 18;
    const mRight = PW - rMar;
    const mW     = mRight - mLeft;

    // Gradient header strip
    gRect(doc, mLeft, 30, mW, 86, c1, c2);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(22)
        .text("INVOICE", mLeft + 18, 52, { lineBreak: false });
    doc.fillColor("rgba(255,255,255,0.65)").font("Helvetica").fontSize(8.5)
        .text("OFFICIAL DOCUMENT", mLeft + 18, 84, { lineBreak: false });

    // Meta on right of header strip
    const invNo   = String(invoice.invoice_no || "-");
    const invDate = invoice.create_date ? new Date(invoice.create_date).toLocaleDateString("en-IN") : "-";
    doc.font("Helvetica").fontSize(8).fillColor("rgba(255,255,255,0.6)")
        .text("NO:", mRight - 28 - doc.widthOfString(invNo, { size: 11 }), 38, { lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#ffffff")
        .text(invNo, mRight - 28 - doc.widthOfString(invNo, { size: 11 }), 50, { lineBreak: false });
    doc.font("Helvetica").fontSize(8).fillColor("rgba(255,255,255,0.6)")
        .text("DATE:", mRight - 28 - doc.widthOfString(invDate, { size: 10 }), 74, { lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#ffffff")
        .text(invDate, mRight - 28 - doc.widthOfString(invDate, { size: 10 }), 86, { lineBreak: false });

    doc.moveTo(mLeft, 130).lineTo(mRight, 130).lineWidth(1).stroke(t.soft || "#eff6ff");

    // Metadata grid
    let y = 148;
    const col3W = Math.floor(mW / 3);
    const txDate = transactionRow?.transaction_date ? new Date(transactionRow.transaction_date).toLocaleDateString("en-IN") : "-";
    [{ l: "INVOICE NO", v: invNo }, { l: "DATE", v: invDate }, { l: "TRANSACTION", v: txDate }].forEach((m, i) => {
        const mx = mLeft + i * col3W;
        doc.fillColor(c1).font("Helvetica-Bold").fontSize(8).text(m.l, mx, y, { lineBreak: false });
        doc.fillColor("#111111").font("Helvetica-Bold").fontSize(11).text(m.v, mx, y + 13, { lineBreak: false });
    });

    // Party
    y += 46;
    doc.moveTo(mLeft, y).lineTo(mLeft, y + 74).lineWidth(4).stroke(c1);
    doc.fillColor(c1).font("Helvetica-Bold").fontSize(8).text("FROM", mLeft + 14, y, { lineBreak: false });
    doc.fillColor("#111111").font("Helvetica-Bold").fontSize(11).text(issuer?.name || "Business", mLeft + 14, y + 14, { lineBreak: false });
    if (issuer?.address) {
        doc.fillColor("#555555").font("Helvetica").fontSize(9)
            .text(issuer.address, mLeft + 14, y + 30, { width: mW / 2 - 22, lineGap: 2 });
    }
    const toX = mLeft + mW / 2 + 8;
    doc.moveTo(toX, y).lineTo(toX, y + 74).lineWidth(4).stroke(c2);
    doc.fillColor(c2).font("Helvetica-Bold").fontSize(8).text(billToLabel.toUpperCase(), toX + 14, y, { lineBreak: false });
    doc.fillColor("#111111").font("Helvetica-Bold").fontSize(11).text(partyName || "-", toX + 14, y + 14, { lineBreak: false });

    // ── Table ────────────────────────────────────────────────────
    y += 94;
    const cD  = mLeft;
    const cA  = mLeft + mW * 0.55;
    const cT  = mLeft + mW * 0.72;
    const cTo = mLeft + mW * 0.88;
    const dW  = cA - cD - 18;

    const drawHead = (sy) => {
        gRect(doc, mLeft, sy, mW, 34, c1, c2);
        doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9);
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
        doc.rect(mLeft, y, mW, rH).fill(i % 2 === 0 ? "#ffffff" : (t.rowAlt || "#e0f2fe"));
        doc.moveTo(mLeft, y + rH).lineTo(mRight, y + rH).lineWidth(0.5).stroke("#b5d5e8");
        const mY = y + Math.round((rH - 12) / 2);
        doc.fillColor("#1a1a2e").font("Helvetica-Bold").fontSize(10)
            .text(txt, cD + 12, y + 12, { width: dW, lineBreak: false });
        doc.fillColor("#444444").font("Helvetica").fontSize(10);
        doc.text(fmt(it.fees),      cA,      mY, { lineBreak: false });
        doc.text(fmt(it.tax_value), cT,      mY, { lineBreak: false });
        doc.fillColor(c2).font("Helvetica-Bold")
            .text(fmt(it.total),    cTo - 8, mY, { lineBreak: false });
        y += rH;
    }

    // ── Totals ───────────────────────────────────────────────────
    y = overflow(doc, y, 175);
    y += 26;
    const tW  = 256;
    const tX  = mRight - tW;
    const tH  = 148;
    const pad = 20;

    gRRect(doc, tX, y, tW, tH, 8, t.soft || "#eff6ff", t.softEnd || "#f0fdfa");
    gRect(doc, tX, y, 4, tH, c1, c2);

    let ty = y + 20;
    totalsRow(doc, "Subtotal",        fmt(invoice.subtotal),          tX, tW, ty, pad, c1, "#222222", 10); ty += 25;
    totalsRow(doc, `Tax (${Number(invoice.tax_rate||0).toFixed(2)}%)`, fmt(invoice.tax_value), tX, tW, ty, pad, c1, "#222222", 10); ty += 25;
    if (Number(invoice.additional_charge) > 0) {
        totalsRow(doc, "Additional", fmt(invoice.additional_charge), tX, tW, ty, pad, c1, "#222222", 10); ty += 25;
    }
    doc.moveTo(tX + 14, ty).lineTo(tX + tW - 14, ty).lineWidth(0.8).stroke(t.accent || "#3b82f6"); ty += 14;
    totalsRow(doc, "GRAND TOTAL", fmt(invoice.grand_total), tX, tW, ty, pad, c1, c2, 13);

    if (transactionRow?.remark) {
        doc.fillColor(c1).font("Helvetica-Bold").fontSize(8.5).text("REMARKS", mLeft, y, { lineBreak: false });
        doc.fillColor("#444444").font("Helvetica").fontSize(9)
            .text(String(transactionRow.remark), mLeft, y + 16, { width: mW - tW - 18, lineGap: 3 });
    }
}

// ═══════════════════════════════════════════════════════════════
// Template 4 — CREATIVE  (Rose → Orange, bold agency style)
// Layout: Bold gradient left accent strip, large gradient header,
//         bold party labels, vivid table, accent-top totals.
// ═══════════════════════════════════════════════════════════════
function renderCreative(doc, t, { title, billToLabel, invoice, transactionRow, items, partyName, issuer }) {
    const left  = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const PH    = doc.page.height;
    const W     = right - left;
    const c1    = t.primary;
    const c2    = t.primaryEnd || "#ea580c";

    // ── Vertical accent strip (left edge, full height) ──────────
    gRect(doc, 0, 0, 22, PH, c1, c2);

    // ── Header gradient block ────────────────────────────────────
    gRect(doc, 22, 24, right + doc.page.margins.right - 22, 106, c1, c2);

    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(30)
        .text(title.toUpperCase(), left + 20, 50, { lineBreak: false });
    doc.fillColor("rgba(255,255,255,0.65)").font("Helvetica-Bold").fontSize(8)
        .text("TAX INVOICE", left + 20, 92, { lineBreak: false });

    const invNo   = String(invoice.invoice_no || "-");
    const invDate = invoice.create_date ? new Date(invoice.create_date).toLocaleDateString("en-IN") : "-";
    doc.font("Helvetica").fontSize(8).fillColor("rgba(255,255,255,0.6)")
        .text("INV NO:", right - 24 - doc.widthOfString(invNo, { size: 11 }), 46, { lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#ffffff")
        .text(invNo, right - 24 - doc.widthOfString(invNo, { size: 11 }), 58, { lineBreak: false });
    doc.font("Helvetica").fontSize(8).fillColor("rgba(255,255,255,0.6)")
        .text("DATE:", right - 24 - doc.widthOfString(invDate, { size: 10 }), 82, { lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#ffffff")
        .text(invDate, right - 24 - doc.widthOfString(invDate, { size: 10 }), 94, { lineBreak: false });

    // ── Party section ────────────────────────────────────────────
    let y = 152;
    doc.moveTo(left + 16, y).lineTo(left + 16, y + 78).lineWidth(5).stroke(c1);
    doc.fillColor(c1).font("Helvetica-Bold").fontSize(8).text("FROM", left + 32, y, { lineBreak: false });
    doc.fillColor("#111111").font("Helvetica-Bold").fontSize(12)
        .text(issuer?.name || "Business", left + 32, y + 16, { lineBreak: false });
    if (issuer?.address) {
        doc.fillColor("#555555").font("Helvetica").fontSize(9)
            .text(issuer.address, left + 32, y + 34, { width: W / 2 - 50, lineGap: 2 });
    }

    const toX = left + W / 2 + 16;
    doc.moveTo(toX, y).lineTo(toX, y + 78).lineWidth(5).stroke(c2);
    doc.fillColor(c2).font("Helvetica-Bold").fontSize(8)
        .text(billToLabel.toUpperCase(), toX + 16, y, { lineBreak: false });
    doc.fillColor("#111111").font("Helvetica-Bold").fontSize(12)
        .text(partyName || "-", toX + 16, y + 16, { lineBreak: false });

    // ── Table ────────────────────────────────────────────────────
    y += 100;
    const cD  = left;
    const cA  = left + W * 0.55;
    const cT  = left + W * 0.72;
    const cTo = left + W * 0.88;
    const dW  = cA - cD - 22;

    const drawHead = (sy) => {
        gRect(doc, left, sy, W, 38, c1, c2);
        doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9.5);
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
        doc.rect(left, y, W, rH).fill(i % 2 === 0 ? "#ffffff" : (t.rowAlt || "#ffe4e6"));
        doc.moveTo(left, y + rH).lineTo(right, y + rH).lineWidth(0.5).stroke("#f5c0c0");
        const mY = y + Math.round((rH - 12) / 2);
        doc.fillColor("#1a1a1a").font("Helvetica-Bold").fontSize(10)
            .text(txt, cD + 14, y + 14, { width: dW, lineBreak: false });
        doc.fillColor("#444444").font("Helvetica").fontSize(10);
        doc.text(fmt(it.fees),      cA,      mY, { lineBreak: false });
        doc.text(fmt(it.tax_value), cT,      mY, { lineBreak: false });
        doc.fillColor(c2).font("Helvetica-Bold")
            .text(fmt(it.total),    cTo - 8, mY, { lineBreak: false });
        y += rH;
    }

    // ── Totals ───────────────────────────────────────────────────
    y = overflow(doc, y, 175);
    y += 28;
    const tW  = 262;
    const tX  = right - tW;
    const tH  = 148;
    const pad = 20;

    gRRect(doc, tX, y, tW, tH, 8, t.soft || "#fff1f2", t.softEnd || "#fff7ed");
    gRect(doc, tX, y, tW, 6, c1, c2);

    let ty = y + 24;
    totalsRow(doc, "Subtotal",        fmt(invoice.subtotal),          tX, tW, ty, pad, c1, "#222222", 10); ty += 25;
    totalsRow(doc, `Tax (${Number(invoice.tax_rate||0).toFixed(2)}%)`, fmt(invoice.tax_value), tX, tW, ty, pad, c1, "#222222", 10); ty += 25;
    if (Number(invoice.additional_charge) > 0) {
        totalsRow(doc, "Additional", fmt(invoice.additional_charge), tX, tW, ty, pad, c1, "#222222", 10); ty += 25;
    }
    doc.moveTo(tX + 14, ty).lineTo(tX + tW - 14, ty).lineWidth(1).stroke(t.border || "#fecdd3"); ty += 14;
    totalsRow(doc, "TOTAL", fmt(invoice.grand_total), tX, tW, ty, pad, c1, c2, 14);

    if (transactionRow?.remark) {
        const rW = W - tW - 18;
        gRRect(doc, left, y, rW, tH, 8, t.soft || "#fff1f2", t.softEnd || "#fff7ed");
        doc.moveTo(left, y).lineTo(left, y + tH).lineWidth(4).stroke(c1);
        doc.fillColor(c1).font("Helvetica-Bold").fontSize(8.5).text("NOTES", left + 16, y + 18, { lineBreak: false });
        doc.fillColor("#444444").font("Helvetica").fontSize(9)
            .text(String(transactionRow.remark), left + 16, y + 34, { width: rW - 32, lineGap: 3 });
    }
}

// ═══════════════════════════════════════════════════════════════
// Template 5 — LUXURY  (Violet → Deep Amber/Gold)
// Layout: Full-bleed gradient header with gold accents,
//         side-by-side party boxes with accent borders,
//         gradient table header with gold text,
//         dark gradient totals card (light text on gradient).
// ═══════════════════════════════════════════════════════════════
function renderLuxury(doc, t, { title, billToLabel, invoice, transactionRow, items, partyName, issuer }) {
    const left  = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const PW    = doc.page.width;
    const W     = right - left;
    const c1    = t.primary;
    const c2    = t.primaryEnd || "#a16207";
    const gold  = t.accent  || "#f59e0b";
    const gold2 = t.accentEnd || "#d97706";

    // ── Full-bleed gradient header ───────────────────────────────
    gRect(doc, 0, 0, PW, 130, c1, c2);
    gRect(doc, 0, 130, PW, 4, gold, gold2);

    doc.fillColor(gold).font("Helvetica-Bold").fontSize(30)
        .text(title.toUpperCase(), left, 42, { lineBreak: false });
    doc.fillColor("rgba(255,255,255,0.55)").font("Helvetica").fontSize(8.5)
        .text("OFFICIAL TAX DOCUMENT", left, 82, { lineBreak: false });

    const invNo   = String(invoice.invoice_no || "-");
    const invDate = invoice.create_date ? new Date(invoice.create_date).toLocaleDateString("en-IN") : "-";
    doc.font("Helvetica").fontSize(8).fillColor("rgba(255,255,255,0.55)")
        .text("INVOICE NO:", right - 24 - doc.widthOfString(invNo, { size: 11 }), 40, { lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(11).fillColor(gold)
        .text(invNo, right - 24 - doc.widthOfString(invNo, { size: 11 }), 52, { lineBreak: false });
    doc.font("Helvetica").fontSize(8).fillColor("rgba(255,255,255,0.55)")
        .text("DATE:", right - 24 - doc.widthOfString(invDate, { size: 10 }), 76, { lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(10).fillColor(gold)
        .text(invDate, right - 24 - doc.widthOfString(invDate, { size: 10 }), 88, { lineBreak: false });

    // ── Party boxes ──────────────────────────────────────────────
    let y = 156;
    const bW = Math.floor((W - 20) / 2);
    const bH = 96;

    gRRect(doc, left, y, bW, bH, 8, t.soft || "#faf5ff", t.softEnd || "#fffbeb");
    gRect(doc, left, y, 4, bH, c1, c2);
    doc.fillColor(c1).font("Helvetica-Bold").fontSize(8).text("BILL FROM", left + 16, y + 16, { lineBreak: false });
    doc.fillColor("#111111").font("Helvetica-Bold").fontSize(11).text(issuer?.name || "Business", left + 16, y + 32, { lineBreak: false });
    if (issuer?.address) {
        doc.fillColor("#555555").font("Helvetica").fontSize(9)
            .text(issuer.address, left + 16, y + 50, { width: bW - 32, lineGap: 2 });
    }

    const bX2 = right - bW;
    gRRect(doc, bX2, y, bW, bH, 8, t.soft || "#faf5ff", t.softEnd || "#fffbeb");
    gRect(doc, bX2, y, 4, bH, gold, gold2);
    doc.fillColor(gold2).font("Helvetica-Bold").fontSize(8).text(billToLabel.toUpperCase(), bX2 + 16, y + 16, { lineBreak: false });
    doc.fillColor("#111111").font("Helvetica-Bold").fontSize(11).text(partyName || "-", bX2 + 16, y + 32, { lineBreak: false });

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
        doc.rect(left, y, W, rH).fill(i % 2 === 0 ? "#ffffff" : (t.rowAlt || "#f5f3ff"));
        doc.moveTo(left, y + rH).lineTo(right, y + rH).lineWidth(0.5).stroke("#e8d5b0");
        const mY = y + Math.round((rH - 12) / 2);
        doc.fillColor("#1a1a1a").font("Helvetica-Bold").fontSize(10)
            .text(txt, cD + 14, y + 14, { width: dW, lineBreak: false });
        doc.fillColor("#555555").font("Helvetica").fontSize(10);
        doc.text(fmt(it.fees),      cA,      mY, { lineBreak: false });
        doc.text(fmt(it.tax_value), cT,      mY, { lineBreak: false });
        doc.fillColor(c1).font("Helvetica-Bold")
            .text(fmt(it.total),    cTo - 8, mY, { lineBreak: false });
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
    totalsRow(doc, "Subtotal",        fmt(invoice.subtotal),          tX, tW, ty, pad, "rgba(255,255,255,0.6)", "#ffffff", 10); ty += 25;
    totalsRow(doc, `Tax (${Number(invoice.tax_rate||0).toFixed(2)}%)`, fmt(invoice.tax_value), tX, tW, ty, pad, "rgba(255,255,255,0.6)", "#ffffff", 10); ty += 25;
    if (Number(invoice.additional_charge) > 0) {
        totalsRow(doc, "Additional", fmt(invoice.additional_charge), tX, tW, ty, pad, "rgba(255,255,255,0.6)", "#ffffff", 10); ty += 25;
    }
    doc.moveTo(tX + 14, ty).lineTo(tX + tW - 14, ty).lineWidth(0.8).stroke(gold); ty += 14;
    totalsRow(doc, "GRAND TOTAL", fmt(invoice.grand_total), tX, tW, ty, pad, gold, gold, 14);

    if (transactionRow?.remark) {
        const rW = W - tW - 18;
        gRRect(doc, left, y, rW, tH, 10, t.soft || "#faf5ff", t.softEnd || "#fffbeb");
        gRect(doc, left, y, 4, tH, gold, gold2);
        doc.fillColor(c2).font("Helvetica-Bold").fontSize(8.5).text("REMARKS", left + 16, y + 20, { lineBreak: false });
        doc.fillColor("#333333").font("Helvetica").fontSize(9)
            .text(String(transactionRow.remark), left + 16, y + 36, { width: rW - 32, lineGap: 3 });
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