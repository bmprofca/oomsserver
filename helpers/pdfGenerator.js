import PDFDocument from "pdfkit";
import { money, fmtDate, fitText, totalsRow } from "./pdfHelpers.js";

/**
 * Builds an invoice / voucher PDF with PDFKit (no browser / Puppeteer).
 */
export async function buildUnifiedInvoicePdfBuffer({
    title,
    pdfSubject,
    invoice,
    transactionRow,
    items = [],
    partyName,
    issuer,
    lines = [],
}) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({
                size: "A4",
                margin: 48,
                info: {
                    Title: title || "Invoice",
                    Subject: pdfSubject || title || "Invoice",
                },
            });

            const buffers = [];
            doc.on("data", (chunk) => buffers.push(chunk));
            doc.on("end", () => resolve(Buffer.concat(buffers)));
            doc.on("error", reject);

            const pageW = doc.page.width;
            const left = 48;
            const right = pageW - 48;
            const contentW = right - left;

            drawHeader(doc, issuer, title, left, right, contentW);
            let y = 150;

            y = drawMeta(doc, invoice, transactionRow, left, right, y);
            y = drawParties(doc, partyName, lines, left, contentW, y);

            if (items && items.length > 0) {
                y = drawItemsTable(doc, items, left, contentW, y);
                y = drawTotals(doc, invoice, items, left, contentW, y);
            } else {
                y = drawSimpleAmount(doc, invoice, lines, left, contentW, y);
            }

            const remark = invoice?.remark || invoice?.remarks || transactionRow?.remark;
            if (remark) {
                y = drawRemark(doc, remark, left, contentW, y);
            }

            drawFooter(doc, left, contentW);
            doc.end();
        } catch (error) {
            reject(error);
        }
    });
}

function drawHeader(doc, issuer, title, left, right, contentW) {
    doc.rect(left, 40, contentW, 4).fill("#2563eb");

    doc.fillColor("#0f172a")
        .font("Helvetica-Bold")
        .fontSize(16)
        .text(issuer?.name || "Business", left, 55, { width: contentW * 0.55 });

    fitText(doc, issuer?.address || "", left, 78, contentW * 0.55, 36, {
        font: "Helvetica",
        startSize: 9,
        minSize: 7,
        color: "#475569",
    });

    let contactY = 118;
    if (issuer?.phone) {
        doc.font("Helvetica").fontSize(8).fillColor("#64748b")
            .text(`Phone: ${issuer.phone}`, left, contactY, { width: contentW * 0.55 });
        contactY += 12;
    }
    if (issuer?.email) {
        doc.font("Helvetica").fontSize(8).fillColor("#64748b")
            .text(`Email: ${issuer.email}`, left, contactY, { width: contentW * 0.55 });
    }

    doc.fillColor("#2563eb")
        .font("Helvetica-Bold")
        .fontSize(14)
        .text(title || "INVOICE", left + contentW * 0.55, 55, {
            width: contentW * 0.45,
            align: "right",
        });
}

function drawMeta(doc, invoice, transactionRow, left, right, y) {
    const invoiceNo = invoice?.invoice_no || invoice?.invoice_id || "-";
    const dateRaw =
        transactionRow?.transaction_date ||
        invoice?.create_date ||
        invoice?.created_at ||
        invoice?.date;
    const dateStr = fmtDate(dateRaw);

    doc.fillColor("#64748b").font("Helvetica").fontSize(8)
        .text("INVOICE NO.", left, y);
    doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(11)
        .text(String(invoiceNo), left, y + 12);

    doc.fillColor("#64748b").font("Helvetica").fontSize(8)
        .text("DATE", right - 140, y, { width: 140, align: "right" });
    doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(11)
        .text(dateStr, right - 140, y + 12, { width: 140, align: "right" });

    y += 40;
    doc.strokeColor("#e2e8f0").lineWidth(1)
        .moveTo(left, y).lineTo(right, y).stroke();
    return y + 16;
}

function drawParties(doc, partyName, lines, left, contentW, y) {
    const hasParty = partyName && String(partyName).trim() !== "" && String(partyName) !== "-";
    const hasLines = Array.isArray(lines) && lines.length > 0;
    if (!hasParty && !hasLines) return y;

    doc.fillColor("#64748b").font("Helvetica-Bold").fontSize(8)
        .text("BILL TO / PARTY", left, y);
    y += 14;

    if (hasParty) {
        doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(11)
            .text(String(partyName), left, y, { width: contentW });
        y += 16;
    }

    if (hasLines) {
        doc.font("Helvetica").fontSize(9).fillColor("#334155");
        for (const line of lines) {
            if (!line) continue;
            const label = line.label ? `${line.label}: ` : "";
            const value = line.value != null ? String(line.value) : "";
            if (!label && !value) continue;
            doc.text(`${label}${value}`, left, y, { width: contentW });
            y += 13;
        }
    }

    return y + 12;
}

function drawItemsTable(doc, items, left, contentW, y) {
    const colNo = left;
    const colName = left + 28;
    const colFees = left + contentW - 200;
    const colTax = left + contentW - 120;
    const colTotal = left + contentW - 60;
    const nameW = colFees - colName - 8;

    doc.rect(left, y, contentW, 22).fill("#f1f5f9");
    doc.fillColor("#334155").font("Helvetica-Bold").fontSize(8);
    doc.text("#", colNo + 4, y + 7);
    doc.text("ITEM / SERVICE", colName, y + 7, { width: nameW });
    doc.text("FEES", colFees, y + 7, { width: 70, align: "right" });
    doc.text("TAX", colTax, y + 7, { width: 50, align: "right" });
    doc.text("TOTAL", colTotal, y + 7, { width: 60, align: "right" });
    y += 28;

    doc.font("Helvetica").fontSize(9).fillColor("#0f172a");
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const fees = Number(item.fees ?? item.rate ?? 0) || 0;
        const lineTotal = Number(item.total != null ? item.total : fees) || 0;
        const tax = Number((lineTotal - fees).toFixed(2));
        const name = item.service_name || item.description || "Item / Service";

        const nameHeight = Math.max(
            14,
            doc.heightOfString(String(name), { width: nameW })
        );
        const rowH = Math.max(20, nameHeight + 6);

        if (y + rowH > doc.page.height - 80) {
            doc.addPage();
            y = 48;
        }

        doc.text(String(i + 1), colNo + 4, y);
        doc.text(String(name), colName, y, { width: nameW });
        doc.text(money(fees), colFees, y, { width: 70, align: "right" });
        doc.text(money(tax), colTax, y, { width: 50, align: "right" });
        doc.text(money(lineTotal), colTotal, y, { width: 60, align: "right" });
        y += rowH;
        doc.strokeColor("#f1f5f9").lineWidth(0.5)
            .moveTo(left, y - 2).lineTo(left + contentW, y - 2).stroke();
    }

    return y + 10;
}

function deriveTax(invoice) {
    const subtotal = Number(invoice?.subtotal) || 0;
    const discount = Number(invoice?.discount_value) || 0;
    const additional = Number(invoice?.additional_charge) || 0;
    const total = Number(invoice?.total) || 0;
    if (invoice?.tax_amount != null && Number.isFinite(Number(invoice.tax_amount))) {
        return Number(Number(invoice.tax_amount).toFixed(2));
    }
    if (total > 0 || subtotal > 0) {
        const taxable = subtotal - discount;
        return Number((total - taxable - additional).toFixed(2));
    }
    return 0;
}

function drawTotals(doc, invoice, items, left, contentW, y) {
    const boxW = 220;
    const boxX = left + contentW - boxW;
    const pad = 10;

    const subtotal =
        Number(invoice?.subtotal) ||
        items.reduce((sum, it) => sum + (Number(it.fees ?? it.rate ?? 0) || 0), 0);
    const discount = Number(invoice?.discount_value) || 0;
    const additional = Number(invoice?.additional_charge) || 0;
    const tax = deriveTax(invoice);
    const grand =
        Number(invoice?.grand_total) ||
        Number(invoice?.amount) ||
        Number(invoice?.total) ||
        0;

    if (y + 110 > doc.page.height - 60) {
        doc.addPage();
        y = 48;
    }

    totalsRow(doc, "Subtotal", money(subtotal), boxX, boxW, y, pad, "#64748b", "#0f172a", 9);
    y += 16;
    if (discount > 0) {
        totalsRow(doc, "Discount", money(discount), boxX, boxW, y, pad, "#64748b", "#0f172a", 9);
        y += 16;
    }
    if (tax !== 0) {
        totalsRow(doc, "Tax / GST", money(tax), boxX, boxW, y, pad, "#64748b", "#0f172a", 9);
        y += 16;
    }
    if (additional > 0) {
        totalsRow(doc, "Additional", money(additional), boxX, boxW, y, pad, "#64748b", "#0f172a", 9);
        y += 16;
    }
    y += 4;
    doc.strokeColor("#2563eb").lineWidth(1.5)
        .moveTo(boxX, y).lineTo(boxX + boxW, y).stroke();
    y += 8;
    totalsRow(doc, "Grand Total", money(grand), boxX, boxW, y, pad, "#2563eb", "#2563eb", 11, true);
    return y + 28;
}

function drawSimpleAmount(doc, invoice, lines, left, contentW, y) {
    const amount =
        Number(invoice?.grand_total) ||
        Number(invoice?.amount) ||
        Number(invoice?.total) ||
        0;

    doc.rect(left, y, contentW, 56).fill("#f8fafc");
    doc.fillColor("#64748b").font("Helvetica").fontSize(9)
        .text("AMOUNT", left + 16, y + 12);
    doc.fillColor("#2563eb").font("Helvetica-Bold").fontSize(18)
        .text(money(amount), left + 16, y + 28);

    return y + 72;
}

function drawRemark(doc, remark, left, contentW, y) {
    if (y + 50 > doc.page.height - 60) {
        doc.addPage();
        y = 48;
    }
    doc.fillColor("#92400e").font("Helvetica-Bold").fontSize(8)
        .text("REMARK", left, y);
    y += 12;
    fitText(doc, String(remark), left, y, contentW, 48, {
        font: "Helvetica",
        startSize: 9,
        minSize: 7,
        color: "#78350f",
    });
    return y + 56;
}

function drawFooter(doc, left, contentW) {
    const y = doc.page.height - 40;
    doc.fontSize(8)
        .fillColor("#94a3b8")
        .text("Thank you for your business.", left, y, {
            align: "center",
            width: contentW,
        });
}
