import PDFDocument from "pdfkit";
import { pdfTheme } from "./invoicePdfTheme.js";
import { gRect, gRRect, fitText, fitLine, money } from "./pdfHelpers.js";

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
    const c2 = t.primaryEnd;

    if (formatKey === "minimal") {
        gRect(doc, left, 24, fullW, 4, c1, c2);
    } else {
        gRRect(doc, left, 24, fullW, 12, 6, c1, c2);
    }

    const headerTop = 50;
    const titleColW = fullW * 0.56;
    doc.fillColor(c1).font("Helvetica-Bold").fontSize(t.titleSize).text(title, left, headerTop, { width: titleColW, lineBreak: false });

    const businessName = issuer?.name || "Business";
    const contactLine = [issuer?.phone, issuer?.email].filter(Boolean).join("  |  ");
    const leftColY = headerTop + 32;
    doc.fillColor("#1a1a1a").font("Helvetica-Bold").fontSize(formatKey === "compact" ? 10 : 11)
        .text(businessName, left, leftColY, { width: titleColW, lineBreak: false });

    const addrParts = [issuer?.address, contactLine].filter(Boolean).join("\n");
    if (addrParts) {
        fitText(doc, addrParts, left, leftColY + 15, titleColW, 42, {
            font: "Helvetica", startSize: 9, minSize: 7, color: "#4a4a4a", lineGap: 1.5,
        });
    }
    const leftColBottom = leftColY + 15 + 42;

    const cardX = left + fullW * 0.58;
    const cardW = fullW * 0.42;
    const dateValue = invoice.create_date ? new Date(invoice.create_date).toLocaleDateString("en-IN") : "-";
    const txValue = transactionRow?.transaction_date ? new Date(transactionRow.transaction_date).toLocaleDateString("en-IN") : "-";
    const cardY = headerTop - 10;

    const metaBg = t.soft;
    const metaBg2 = t.softEnd;
    gRRect(doc, cardX, cardY, cardW, 80, 8, metaBg, metaBg2);

    const labelX = cardX + 12;
    const valW = cardW - 24;
    doc.fillColor(t.accent).font("Helvetica-Bold").fontSize(8);
    doc.text("DOCUMENT NO", labelX, cardY + 14);
    doc.text("DATE", labelX, cardY + 34);
    doc.text("TRANSACTION", labelX, cardY + 54);

    fitLine(doc, String(invoice.invoice_no || "-"), labelX, valW, cardY + 14, { font: "Helvetica", startSize: 9, minSize: 7, color: "#111111", align: "right" });
    fitLine(doc, dateValue, labelX, valW, cardY + 34, { font: "Helvetica", startSize: 9, minSize: 7, color: "#111111", align: "right" });
    fitLine(doc, txValue, labelX, valW, cardY + 54, { font: "Helvetica", startSize: 9, minSize: 7, color: "#111111", align: "right" });

    const cardBottom = cardY + 80;
    let y = Math.max(leftColBottom, cardBottom) + 20;

    const rowH = 26;
    const validLines = lines.filter((row) => row?.label);
    const boxH = rowH + Math.max(0, validLines.length) * rowH;
    gRRect(doc, left, y, fullW, boxH, 8, metaBg, metaBg2);
    y += 14;

    const labelColW = fullW * 0.25;
    const valueColX = left + fullW * 0.28;
    const valueColW = fullW * 0.68;
    for (let i = 0; i < validLines.length; i++) {
        const row = validLines[i];
        doc.font("Helvetica-Bold").fontSize(9).fillColor(c1).text(`${row.label}:`, left + 14, y, { width: labelColW, lineBreak: false });
        fitText(doc, row.value || "-", valueColX, y - 1, valueColW - 14, 16, { font: "Helvetica", startSize: 10, minSize: 8, color: "#111111" });
        y += rowH;
    }

    y += 12;
    gRRect(doc, left, y, fullW, 44, 8, c1, c2);
    doc.fillColor(t.onPrimary).font("Helvetica").fontSize(11).text("Total Amount", left + 18, y + 16, { width: fullW * 0.4 });
    fitLine(doc, money(invoice.grand_total), left + fullW * 0.4, fullW * 0.6 - 18, y + 15, {
        font: "Helvetica-Bold", startSize: 14, minSize: 9, color: t.onPrimary, align: "right",
    });

    if (transactionRow?.remark) {
        y += 56;
        gRRect(doc, left, y, fullW, 44, 8, metaBg, metaBg2);
        doc.font("Helvetica-Bold").fontSize(8.5).fillColor(c1).text("REMARKS", left + 14, y + 12);
        fitText(doc, transactionRow.remark, left + 14, y + 26, fullW - 28, 14, {
            startSize: 9, minSize: 7, color: "#555555", lineGap: 2,
        });
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

    renderSimpleInvoiceLayout(doc, t, { formatKey, title, invoice, transactionRow, lines, issuer });

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

    renderSimpleInvoiceLayout(doc, t, { formatKey, title, invoice, transactionRow, lines, issuer });

    return new Promise((resolve, reject) => {
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);
        doc.end();
    });
}
