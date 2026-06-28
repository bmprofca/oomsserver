import PDFDocument from "pdfkit";
import { pdfTheme } from "./invoicePdfTheme.js";
import { premiumRenderers } from "./SaleInvoicePremiumLayouts.js";

function money(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "Rs. 0.00";
    return `Rs. ${x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
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

    // Original rendering logic for classic, compact, and minimal templates
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const fullW = right - left;

    doc.rect(left, 24, fullW, 10).fill(t.primary);
    const headerTop = 44;
    doc.fillColor(t.primary).font("Helvetica-Bold").fontSize(t.titleSize).text(title, left, headerTop, {
        align: "left",
        width: fullW * 0.56,
    });
    const businessName = issuer?.name || "Business";
    const invoiceDate = invoice.create_date ? new Date(invoice.create_date).toLocaleDateString("en-IN") : "-";
    const txDate = transactionRow?.transaction_date ? new Date(transactionRow.transaction_date).toLocaleDateString("en-IN") : "-";
    const contactLine = [issuer?.phone, issuer?.email].filter(Boolean).join(" | ");

    const leftColY = headerTop + 30;
    doc.fillColor("#111111").font("Helvetica-Bold").fontSize(formatKey === "compact" ? 10 : 11).text(businessName, left, leftColY, { width: fullW * 0.56 });
    doc.font("Helvetica").fontSize(formatKey === "compact" ? 8 : 9).fillColor("#4a4a4a");
    if (issuer?.address) {
        doc.text(issuer.address, left, doc.y + 2, { width: fullW * 0.56 });
    }
    if (contactLine) {
        doc.text(contactLine, left, doc.y + 2, { width: fullW * 0.56 });
    }

    const leftColBottom = doc.y;
    const metaX = left + fullW * 0.60;
    const metaW = fullW * 0.40;
    doc.roundedRect(metaX, headerTop - 6, metaW, 72, 6).fill(t.soft);
    doc.fillColor("#2b2b2b").font("Helvetica-Bold").fontSize(9).text("Invoice No", metaX + 12, headerTop + 6, { width: metaW * 0.45 });
    doc.text("Date", metaX + 12, headerTop + 22, { width: metaW * 0.45 });
    doc.text("Transaction Date", metaX + 12, headerTop + 38, { width: metaW * 0.45 });
    doc.fillColor("#111111").font("Helvetica").text(String(invoice.invoice_no || "-"), metaX + metaW * 0.48, headerTop + 6, { width: metaW * 0.48, align: "right" });
    doc.text(invoiceDate, metaX + metaW * 0.48, headerTop + 22, { width: metaW * 0.48, align: "right" });
    doc.text(txDate, metaX + metaW * 0.48, headerTop + 38, { width: metaW * 0.48, align: "right" });

    const metaBottom = headerTop - 6 + 72;
    const billTop = Math.max(leftColBottom, metaBottom) + 12;
    doc.roundedRect(left, billTop, fullW, 44, 6).fill("#f9fafc");
    doc.fillColor(t.accent).font("Helvetica-Bold").fontSize(9).text(billToLabel.toUpperCase(), left + 10, billTop + 8);
    doc.fillColor("#111111").font("Helvetica").fontSize(formatKey === "compact" ? 9 : 10).text(partyName || "-", left + 10, billTop + 22, { width: fullW - 20 });

    const rowH = formatKey === "compact" ? 16 : 20;
    let y = billTop + 58;
    const w = fullW;

    doc.rect(left, y, w, rowH).fill(t.primary);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(t.tableHead);
    const colDesc = left + 8;
    const colFees = left + w * 0.52;
    const colTax = left + w * 0.68;
    const colTot = left + w * 0.82;
    doc.text("Description", colDesc, y + 5, { width: colFees - colDesc - 8 });
    doc.text("Fees", colFees, y + 5, { width: colTax - colFees - 4, align: "right" });
    doc.text("Tax", colTax, y + 5, { width: colTot - colTax - 4, align: "right" });
    doc.text("Total", colTot, y + 5, { width: left + w - colTot - 8, align: "right" });

    y += rowH;
    doc.fillColor("#000000").font("Helvetica").fontSize(formatKey === "compact" ? 8 : 9);

    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const desc = it.service_name || it.service_id || "Item";
        if (y > doc.page.height - 120) {
            doc.addPage();
            y = doc.page.margins.top;
        }
        if (i % 2 === 0) {
            doc.rect(left, y, w, rowH).fill("#fafbfd");
            doc.fillColor("#000000");
        }
        doc.text(desc, colDesc, y + 4, { width: colFees - colDesc - 8 });
        doc.text(money(it.fees), colFees, y + 4, { width: colTax - colFees - 4, align: "right" });
        doc.text(money(it.tax_value), colTax, y + 4, { width: colTot - colTax - 4, align: "right" });
        doc.text(money(it.total), colTot, y + 4, { width: left + w - colTot - 8, align: "right" });
        y += rowH;
        doc.moveTo(left, y).lineTo(left + w, y).strokeColor("#eeeeee").lineWidth(0.5).stroke();
    }

    y += 8;
    const labelX = left + w * 0.55;
    const valX = left + w * 0.72;
    doc.roundedRect(labelX - 10, y - 6, w * 0.45, 72, 6).fill(t.soft);
    doc.fillColor("#111111").font("Helvetica").fontSize(t.line);
    doc.fillColor("#000000").text("Subtotal:", labelX, y);
    doc.text(money(invoice.subtotal), valX, y, { width: left + w - valX, align: "right" });
    y += t.line + 2;
    doc.text(`Tax (${Number(invoice.tax_rate || 0).toFixed(2)}%):`, labelX, y);
    doc.text(money(invoice.tax_value), valX, y, { width: left + w - valX, align: "right" });
    y += t.line + 2;
    if (Number(invoice.additional_charge) > 0) {
        doc.text("Additional charges:", labelX, y);
        doc.text(money(invoice.additional_charge), valX, y, { width: left + w - valX, align: "right" });
        y += t.line + 2;
    }
    doc.font("Helvetica-Bold").fontSize(t.line + 1).text("Grand total:", labelX, y);
    doc.text(money(invoice.grand_total), valX, y, { width: left + w - valX, align: "right" });

    if (transactionRow?.remark) {
        y += t.line + 14;
        doc.roundedRect(left, y - 4, w, 34, 5).strokeColor(t.border).lineWidth(0.8).stroke();
        doc.font("Helvetica-Bold").fontSize(8).fillColor("#777777").text("Remark", left + 8, y + 3);
        doc.font("Helvetica").fontSize(9).fillColor("#555555").text(String(transactionRow.remark), left + 8, y + 14, { width: w - 16 });
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