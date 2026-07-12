import PDFDocument from "pdfkit";
import { pdfTheme } from "./invoicePdfTheme.js";
import { premiumRenderers } from "./SaleInvoicePremiumLayouts.js";

function money(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "Rs. 0.00";
    return `Rs. ${x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

// ─── Helpers for standard layouts ──────────────────────────────────────────
function gRect(doc, x, y, w, h, c1, c2) {
    if (!c2 || c2 === c1) { doc.rect(x, y, w, h).fill(c1); return; }
    const g = doc.linearGradient(x, y, x + w, y);
    g.stop(0, c1).stop(1, c2);
    doc.rect(x, y, w, h).fill(g);
}

function gRRect(doc, x, y, w, h, r, c1, c2) {
    if (!c2 || c2 === c1) { doc.roundedRect(x, y, w, h, r).fill(c1); return; }
    const g = doc.linearGradient(x, y, x + w, y);
    g.stop(0, c1).stop(1, c2);
    doc.roundedRect(x, y, w, h, r).fill(g);
}

function totalsRow(doc, label, value, boxX, boxW, y, pad, labelColor, valueColor, fs, isBold = false) {
    doc.font(isBold ? "Helvetica-Bold" : "Helvetica").fontSize(fs).fillColor(labelColor)
        .text(label, boxX + pad, y, { lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(fs).fillColor(valueColor);
    const vw = doc.widthOfString(value);
    doc.text(value, boxX + boxW - pad - vw, y, { lineBreak: false });
}

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
 * @param {import("pdfkit")} doc
 * @param {object} t theme from pdfTheme
 * @param {object} opts
 */
function renderSaleInvoiceLayout(doc, t, {
    formatKey,
    title = "TAX INVOICE",
    billToLabel = "Bill to",
    invoice,
    transactionRow,
    items,
    partyName,
    issuer,
}) {
    // Check if this is a premium template
    if (formatKey && formatKey.startsWith("premium_") && premiumRenderers[formatKey]) {
        // Use premium renderer for unique premium templates
        premiumRenderers[formatKey](doc, t, {
            title,
            billToLabel,
            invoice,
            transactionRow,
            items,
            partyName,
            issuer,
        });
        return;
    }

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const fullW = right - left;
    
    const c1 = t.primary;
    const c2 = t.primaryEnd || t.primary;

    // ── Header ──────────────────────────────────────────────────────────────
    if (formatKey === "minimal") {
        gRect(doc, left, 24, fullW, 4, c1, c2);
    } else {
        gRRect(doc, left, 24, fullW, 12, 6, c1, c2);
    }

    const headerTop = 50;
    doc.fillColor(c1).font("Helvetica-Bold").fontSize(t.titleSize).text(title, left, headerTop, {
        align: "left",
        width: fullW * 0.56,
    });
    
    const businessName = issuer?.name || "Business";
    const invoiceDate = invoice.create_date ? new Date(invoice.create_date).toLocaleDateString("en-IN") : "-";
    const txDate = transactionRow?.transaction_date ? new Date(transactionRow.transaction_date).toLocaleDateString("en-IN") : "-";
    const contactLine = [issuer?.phone, issuer?.email].filter(Boolean).join(" | ");

    const leftColY = headerTop + 34;
    doc.fillColor("#222222").font("Helvetica-Bold").fontSize(formatKey === "compact" ? 10 : 11)
        .text(businessName, left, leftColY, { width: fullW * 0.56 });
    doc.font("Helvetica").fontSize(formatKey === "compact" ? 8 : 9).fillColor("#4a4a4a");
    if (issuer?.address) {
        doc.text(issuer.address, left, doc.y + 3, { width: fullW * 0.56, lineGap: 1.5 });
    }
    if (contactLine) {
        doc.text(contactLine, left, doc.y + 3, { width: fullW * 0.56 });
    }

    const leftColBottom = doc.y;
    
    // Metadata card on top right
    const metaX = left + fullW * 0.60;
    const metaW = fullW * 0.40;
    const metaBg = t.soft || "#f8fafc";
    const metaBg2 = t.softEnd || t.soft;
    
    gRRect(doc, metaX, headerTop - 10, metaW, 76, 8, metaBg, metaBg2);
    
    const metaPad = 12;
    const textStart = metaX + metaPad;
    const valW = metaW - metaPad * 2;
    
    doc.fillColor(t.accent || "#444444").font("Helvetica-Bold").fontSize(8)
        .text("INVOICE NO", textStart, headerTop, { width: valW });
    doc.fillColor("#111111").font("Helvetica").fontSize(9)
        .text(String(invoice.invoice_no || "-"), textStart, headerTop, { width: valW, align: "right" });
        
    doc.fillColor(t.accent || "#444444").font("Helvetica-Bold").fontSize(8)
        .text("DATE", textStart, headerTop + 20, { width: valW });
    doc.fillColor("#111111").font("Helvetica").fontSize(9)
        .text(invoiceDate, textStart, headerTop + 20, { width: valW, align: "right" });
        
    doc.fillColor(t.accent || "#444444").font("Helvetica-Bold").fontSize(8)
        .text("TRANSACTION", textStart, headerTop + 40, { width: valW });
    doc.fillColor("#111111").font("Helvetica").fontSize(9)
        .text(txDate, textStart, headerTop + 40, { width: valW, align: "right" });

    const metaBottom = headerTop - 10 + 76;
    
    // Bill To section
    const billTop = Math.max(leftColBottom, metaBottom) + 20;
    gRRect(doc, left, billTop, fullW, 48, 8, metaBg, metaBg2);
    
    if (formatKey !== "minimal") {
        gRRect(doc, left, billTop, 4, 48, 4, c1, c2); // left accent border
    }
    
    doc.fillColor(c1).font("Helvetica-Bold").fontSize(8).text(billToLabel.toUpperCase(), left + 14, billTop + 10);
    doc.fillColor("#111111").font("Helvetica-Bold").fontSize(formatKey === "compact" ? 10 : 11).text(partyName || "-", left + 14, billTop + 24, { width: fullW - 28 });

    // ── Table ───────────────────────────────────────────────────────────────
    const rowH = formatKey === "compact" ? 22 : 28;
    let y = billTop + 68;

    const colDesc = left + 12;
    const colFees = left + fullW * 0.52;
    const colTax = left + fullW * 0.68;
    const colTot = left + fullW * 0.82;
    const colTotW = left + fullW - colTot - 12;
    const cHeadColor = formatKey === "minimal" ? c1 : "#ffffff";

    const drawHead = (sy) => {
        if (formatKey === "minimal") {
            doc.moveTo(left, sy).lineTo(right, sy).lineWidth(1).stroke(t.border);
            doc.moveTo(left, sy + rowH).lineTo(right, sy + rowH).lineWidth(1).stroke(t.border);
        } else {
            gRRect(doc, left, sy, fullW, rowH, 6, c1, c2);
        }
        
        doc.fillColor(cHeadColor).font("Helvetica-Bold").fontSize(t.tableHead);
        doc.text("Description", colDesc, sy + (rowH - t.tableHead)/2);
        doc.text("Fees", colFees, sy + (rowH - t.tableHead)/2, { width: colTax - colFees - 4, align: "right" });
        doc.text("Tax", colTax, sy + (rowH - t.tableHead)/2, { width: colTot - colTax - 4, align: "right" });
        doc.text("Total", colTot, sy + (rowH - t.tableHead)/2, { width: colTotW, align: "right" });
        return sy + rowH;
    };
    
    y = drawHead(y);
    doc.fillColor("#222222").font("Helvetica").fontSize(formatKey === "compact" ? 9 : 10);

    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const desc = it.service_name || it.service_id || "Item";
        y = overflow(doc, y, rowH, drawHead);
        
        if (i % 2 === 0 && formatKey !== "minimal") {
            doc.rect(left, y, fullW, rowH).fill(t.rowAlt || "#f8fafc");
        } else {
            doc.rect(left, y, fullW, rowH).fill("#ffffff");
        }
        doc.fillColor("#222222");
        
        const my = y + (rowH - (formatKey === "compact" ? 9 : 10))/2;
        doc.text(desc, colDesc, my, { width: colFees - colDesc - 8, lineBreak: false });
        doc.text(money(it.fees), colFees, my, { width: colTax - colFees - 4, align: "right" });
        doc.text(money(it.tax_value), colTax, my, { width: colTot - colTax - 4, align: "right" });
        
        doc.fillColor(c1).font("Helvetica-Bold");
        doc.text(money(it.total), colTot, my, { width: colTotW, align: "right" });
        doc.fillColor("#222222").font("Helvetica");
        
        y += rowH;
        if (formatKey === "minimal") {
            doc.moveTo(left, y).lineTo(right, y).strokeColor(t.border).lineWidth(0.5).stroke();
        }
    }

    // ── Totals ──────────────────────────────────────────────────────────────
    y = overflow(doc, y, 140);
    y += 12;
    
    const tW = 260;
    const tX = right - tW;
    const tH = 130;
    const pad = 16;
    
    gRRect(doc, tX, y, tW, tH, 8, metaBg, metaBg2);
    
    if (formatKey !== "minimal") {
        gRect(doc, tX, y, tW, 4, c1, c2);
    }
    
    let ty = y + 18;
    totalsRow(doc, "Subtotal", money(invoice.subtotal), tX, tW, ty, pad, "#444444", "#111111", 10); ty += 22;
    totalsRow(doc, `Tax (${Number(invoice.tax_rate || 0).toFixed(2)}%)`, money(invoice.tax_value), tX, tW, ty, pad, "#444444", "#111111", 10); ty += 22;
    
    if (Number(invoice.additional_charge) > 0) {
        totalsRow(doc, "Additional charges", money(invoice.additional_charge), tX, tW, ty, pad, "#444444", "#111111", 10); ty += 22;
    }
    
    doc.moveTo(tX + pad, ty).lineTo(tX + tW - pad, ty).lineWidth(1).stroke(t.border); ty += 12;
    totalsRow(doc, "GRAND TOTAL", money(invoice.grand_total), tX, tW, ty, pad, c1, c2, 13, true);

    if (transactionRow?.remark) {
        const rW = fullW - tW - 20;
        gRRect(doc, left, y, rW, tH, 8, metaBg, metaBg2);
        doc.font("Helvetica-Bold").fontSize(8.5).fillColor(c1).text("NOTES", left + pad, y + 16);
        doc.font("Helvetica").fontSize(9).fillColor("#555555").text(String(transactionRow.remark), left + pad, y + 32, { width: rW - pad*2, lineGap: 2 });
    }
}

/**
 * Sale or purchase style PDF with line items (from `sale_items`).
 */
export function streamSaleInvoicePdf(res, {
    formatKey,
    title = "TAX INVOICE",
    pdfSubject = "Invoice",
    billToLabel = "Bill to",
    invoice,
    transactionRow,
    items,
    partyName,
    issuer,
}) {
    const t = pdfTheme(formatKey);
    const doc = new PDFDocument({
        margin: formatKey === "compact" ? 36 : 50,
        size: "A4",
        info: {
            Title: `${title} ${invoice.invoice_no || ""}`,
            Subject: pdfSubject,
        },
    });

    const safeNo = String(invoice.invoice_no || invoice.invoice_id || "inv").replace(/[^\w.-]+/g, "_");
    const filename = `invoice_${safeNo}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-cache");

    doc.pipe(res);

    renderSaleInvoiceLayout(doc, t, {
        formatKey,
        title,
        billToLabel,
        invoice,
        transactionRow,
        items,
        partyName,
        issuer,
    });

    doc.end();
}

/**
 * Build sale/purchase invoice PDF as a buffer (same layout as streaming).
 */
export function buildSaleInvoicePdfBuffer({
    formatKey,
    title = "TAX INVOICE",
    pdfSubject = "Invoice",
    billToLabel = "Bill to",
    invoice,
    transactionRow,
    items,
    partyName,
    issuer,
}) {
    const t = pdfTheme(formatKey);
    const doc = new PDFDocument({
        margin: formatKey === "compact" ? 36 : 50,
        size: "A4",
        info: {
            Title: `${title} ${invoice.invoice_no || ""}`,
            Subject: pdfSubject,
        },
    });

    const chunks = [];
    doc.on("data", (c) => chunks.push(c));

    renderSaleInvoiceLayout(doc, t, {
        formatKey,
        title,
        billToLabel,
        invoice,
        transactionRow,
        items,
        partyName,
        issuer,
    });

    return new Promise((resolve, reject) => {
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);
        doc.end();
    });
}