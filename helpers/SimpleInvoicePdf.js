import PDFDocument from "pdfkit";
import { pdfTheme } from "./invoicePdfTheme.js";

function money(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "Rs. 0.00";
    return `Rs. ${x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

// ─── Helpers for simple layouts ──────────────────────────────────────────────
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

/**
 * @param {import("pdfkit")} doc
 * @param {object} t theme from pdfTheme
 */
function renderSimpleInvoiceLayout(doc, t, {
    formatKey,
    title,
    invoice,
    transactionRow,
    lines = [],
    issuer,
}) {
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const fullW = right - left;
    const c1 = t.primary;
    const c2 = t.primaryEnd || t.primary;

    if (formatKey === "minimal") {
        gRect(doc, left, 24, fullW, 4, c1, c2);
    } else {
        gRRect(doc, left, 24, fullW, 12, 6, c1, c2);
    }

    const headerTop = 50;
    doc.fillColor(c1).font("Helvetica-Bold").fontSize(t.titleSize).text(title, left, headerTop, { width: fullW });

    const businessName = issuer?.name || "Business";
    const contactLine = [issuer?.phone, issuer?.email].filter(Boolean).join(" | ");
    const leftColY = headerTop + 34;
    doc.fillColor("#222222").font("Helvetica-Bold").fontSize(formatKey === "compact" ? 10 : 11).text(businessName, left, leftColY, { width: fullW * 0.56 });
    doc.font("Helvetica").fontSize(9).fillColor("#4a4a4a");
    if (issuer?.address) {
        doc.text(issuer.address, left, doc.y + 3, { width: fullW * 0.56, lineGap: 1.5 });
    }
    if (contactLine) {
        doc.text(contactLine, left, doc.y + 3, { width: fullW * 0.56 });
    }

    const leftColBottom = doc.y;
    const cardX = left + fullW * 0.58;
    const cardW = fullW * 0.42;
    const dateValue = invoice.create_date ? new Date(invoice.create_date).toLocaleDateString("en-IN") : "-";
    const txValue = transactionRow?.transaction_date ? new Date(transactionRow.transaction_date).toLocaleDateString("en-IN") : "-";
    const cardY = headerTop - 10;
    
    const metaBg = t.soft || "#f8fafc";
    const metaBg2 = t.softEnd || t.soft;
    gRRect(doc, cardX, cardY, cardW, 80, 8, metaBg, metaBg2);
    
    doc.fillColor(t.accent || "#444444").font("Helvetica-Bold").fontSize(8).text("DOCUMENT NO", cardX + 12, cardY + 14);
    doc.text("DATE", cardX + 12, cardY + 34);
    doc.text("TRANSACTION", cardX + 12, cardY + 54);
    
    doc.fillColor("#111111").font("Helvetica").fontSize(9).text(String(invoice.invoice_no || "-"), cardX + cardW * 0.50, cardY + 14, { width: cardW * 0.46 - 12, align: "right" });
    doc.text(dateValue, cardX + cardW * 0.50, cardY + 34, { width: cardW * 0.46 - 12, align: "right" });
    doc.text(txValue, cardX + cardW * 0.50, cardY + 54, { width: cardW * 0.46 - 12, align: "right" });

    const cardBottom = cardY + 80;
    let y = Math.max(leftColBottom, cardBottom) + 20;
    
    gRRect(doc, left, y, fullW, 26 + Math.max(0, lines.length) * 26, 8, metaBg, metaBg2);
    y += 14;

    for (let i = 0; i < lines.length; i++) {
        const row = lines[i];
        if (!row?.label) continue;
        doc.font("Helvetica-Bold").fontSize(9).fillColor(c1).text(`${row.label}:`, left + 14, y, { width: fullW * 0.25 });
        doc.font("Helvetica").fontSize(10).fillColor("#111111").text(row.value || "-", left + fullW * 0.28, y - 1, { width: fullW * 0.68 });
        y += 26;
    }

    y += 12;
    gRRect(doc, left, y, fullW, 44, 8, c1, c2);
    doc.fillColor("#ffffff").font("Helvetica").fontSize(11).text("Total Amount", left + 18, y + 16, { width: fullW * 0.4 });
    doc.font("Helvetica-Bold").fontSize(14).text(money(invoice.grand_total), left + fullW * 0.4, y + 15, { width: fullW * 0.6 - 18, align: "right" });

    if (transactionRow?.remark) {
        y += 56;
        gRRect(doc, left, y, fullW, 44, 8, metaBg, metaBg2);
        doc.font("Helvetica-Bold").fontSize(8.5).fillColor(c1).text("REMARKS", left + 14, y + 12);
        doc.font("Helvetica").fontSize(9).fillColor("#555555").text(String(transactionRow.remark), left + 14, y + 26, { width: fullW - 28, lineGap: 2 });
    }
}

/**
 * Minimal PDF for payment / journal / contra / expense invoices (no line-item table).
 */
export function streamSimpleInvoicePdf(res, {
    formatKey,
    title,
    invoice,
    transactionRow,
    lines = [],
    issuer,
}) {
    const t = pdfTheme(formatKey);
    const doc = new PDFDocument({
        margin: formatKey === "compact" ? 36 : 50,
        size: "A4",
        info: {
            Title: `${title} ${invoice.invoice_no || ""}`,
            Subject: title,
        },
    });

    const safeNo = String(invoice.invoice_no || invoice.invoice_id || "inv").replace(/[^\w.-]+/g, "_");
    const filename = `invoice_${safeNo}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-cache");

    doc.pipe(res);

    renderSimpleInvoiceLayout(doc, t, {
        formatKey,
        title,
        invoice,
        transactionRow,
        lines,
        issuer,
    });

    doc.end();
}

export function buildSimpleInvoicePdfBuffer({
    formatKey,
    title,
    pdfSubject,
    invoice,
    transactionRow,
    lines = [],
    issuer,
}) {
    const t = pdfTheme(formatKey);
    const doc = new PDFDocument({
        margin: formatKey === "compact" ? 36 : 50,
        size: "A4",
        info: {
            Title: `${title} ${invoice.invoice_no || ""}`,
            Subject: pdfSubject || title,
        },
    });

    const chunks = [];
    doc.on("data", (c) => chunks.push(c));

    renderSimpleInvoiceLayout(doc, t, {
        formatKey,
        title,
        invoice,
        transactionRow,
        lines,
        issuer,
    });

    return new Promise((resolve, reject) => {
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);
        doc.end();
    });
}
