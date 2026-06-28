import PDFDocument from "pdfkit";
import { pdfTheme } from "./invoicePdfTheme.js";

function money(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "Rs. 0.00";
    return `Rs. ${x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
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

    doc.rect(left, 24, fullW, 10).fill(t.primary);
    const headerTop = 44;
    doc.fillColor(t.primary).font("Helvetica-Bold").fontSize(t.titleSize).text(title, left, headerTop, { width: fullW });

    const businessName = issuer?.name || "Business";
    const contactLine = [issuer?.phone, issuer?.email].filter(Boolean).join(" | ");
    const leftColY = headerTop + 30;
    doc.fillColor("#111111").font("Helvetica-Bold").fontSize(formatKey === "compact" ? 10 : 11).text(businessName, left, leftColY, { width: fullW * 0.56 });
    doc.font("Helvetica").fontSize(9).fillColor("#4a4a4a");
    if (issuer?.address) {
        doc.text(issuer.address, left, doc.y + 2, { width: fullW * 0.56 });
    }
    if (contactLine) {
        doc.text(contactLine, left, doc.y + 2, { width: fullW * 0.56 });
    }

    const leftColBottom = doc.y;
    const cardX = left + fullW * 0.58;
    const cardW = fullW * 0.42;
    const dateValue = invoice.create_date ? new Date(invoice.create_date).toLocaleDateString("en-IN") : "-";
    const txValue = transactionRow?.transaction_date ? new Date(transactionRow.transaction_date).toLocaleDateString("en-IN") : "-";
    const cardY = headerTop - 4;
    doc.roundedRect(cardX, cardY, cardW, 76, 6).fill(t.soft);
    doc.fillColor("#222222").font("Helvetica-Bold").fontSize(9).text("Document No", cardX + 10, cardY + 10);
    doc.text("Date", cardX + 10, cardY + 26);
    doc.text("Transaction Date", cardX + 10, cardY + 42);
    doc.font("Helvetica").text(String(invoice.invoice_no || "-"), cardX + cardW * 0.50, cardY + 10, { width: cardW * 0.46, align: "right" });
    doc.text(dateValue, cardX + cardW * 0.50, cardY + 26, { width: cardW * 0.46, align: "right" });
    doc.text(txValue, cardX + cardW * 0.50, cardY + 42, { width: cardW * 0.46, align: "right" });

    const cardBottom = cardY + 76;
    let y = Math.max(leftColBottom, cardBottom) + 12;
    doc.roundedRect(left, y, fullW, 22 + Math.max(0, lines.length) * 24, 6).fill("#f9fafc");
    y += 10;

    for (let i = 0; i < lines.length; i++) {
        const row = lines[i];
        if (!row?.label) continue;
        doc.font("Helvetica-Bold").fontSize(9).fillColor("#4f4f4f").text(`${row.label}:`, left + 10, y, { width: fullW * 0.25 });
        doc.font("Helvetica").fontSize(10).fillColor("#111111").text(row.value || "-", left + fullW * 0.27, y, { width: fullW * 0.70 });
        y += 24;
    }

    y += 6;
    doc.roundedRect(left, y, fullW, 34, 6).fill(t.soft);
    doc.fillColor(t.primary).font("Helvetica-Bold").fontSize(12).text(`Amount: ${money(invoice.grand_total)}`, left + 12, y + 10, { width: fullW - 24, align: "left" });

    if (transactionRow?.remark) {
        y += 46;
        doc.roundedRect(left, y, fullW, 38, 5).strokeColor(t.border).lineWidth(0.8).stroke();
        doc.font("Helvetica-Bold").fontSize(8).fillColor("#777777").text("Remark", left + 8, y + 4);
        doc.font("Helvetica").fontSize(9).fillColor("#555555").text(String(transactionRow.remark), left + 8, y + 16, { width: fullW - 16 });
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
