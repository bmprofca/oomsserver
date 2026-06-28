import PDFDocument from "pdfkit";
import { pdfTheme } from "./invoicePdfTheme.js";

function money(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "Rs. 0";
    let formatted = x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    // Drop .00 for whole numbers, keep decimals when present (e.g. 100.09)
    formatted = formatted.replace(/\.00$/, "");
    return `Rs. ${formatted}`;
}

function formatBranchAddress(company) {
    if (!company) return "";
    const parts = [];
    if (company.address_line_1) parts.push(company.address_line_1);
    if (company.address_line_2) parts.push(company.address_line_2);
    const cityLine = [company.city, company.state, company.pincode].filter(Boolean).join(", ");
    if (cityLine) parts.push(cityLine);
    if (company.country) parts.push(company.country);
    return parts.join(", ");
}

function formatDate(d) {
    if (!d) return "—";
    try {
        return new Date(d).toLocaleDateString("en-IN", {
            day: "2-digit",
            month: "short",
            year: "numeric",
        });
    } catch {
        return String(d);
    }
}

/**
 * @param {object} params
 * @param {object | null} params.issuerCompany — branch_list row (name, address, gst, pan, phones, emails)
 * @param {object} params.quotation — quotation_id, status, create_date
 * @param {object} params.client — profile fields (name, email, mobile, pan_number, username)
 * @param {object | null} params.clientFirm — SINGLE_FIRM_DATA or empty
 * @param {Array<{ description: string, fees: number, tax_rate: number, tax_value: number, total: number }>} params.lineItems
 * @param {{ subtotalFees: number, taxTotal: number, grandTotal: number }} params.totals
 */
export function buildQuotationPdfBuffer({
    issuerCompany,
    quotation,
    client,
    clientFirm,
    lineItems,
    totals,
}) {
    const t = pdfTheme("compact");
    const doc = new PDFDocument({
        margin: 48,
        size: "A4",
        info: {
            Title: `Quotation ${quotation?.quotation_id || ""}`,
            Subject: "Quotation",
        },
    });

    const chunks = [];
    doc.on("data", (c) => chunks.push(c));

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const fullW = right - left;
    const primary = t.primary;
    const soft = t.soft;
    const border = t.border;

    function ensureSpace(currentY, need, keepFooter = 80) {
        const bottom = doc.page.height - doc.page.margins.bottom - keepFooter;
        if (currentY + need > bottom) {
            doc.addPage();
            return doc.page.margins.top;
        }
        return currentY;
    }

    function drawLabeledCard({ x, y, width, title, lines }) {
        const topPad = 11;
        const bottomPad = 10;
        const lineH = 13;
        const contentLines = Array.isArray(lines) && lines.length > 0 ? lines : ["—"];
        const cardH = topPad + 16 + 8 + contentLines.length * lineH + bottomPad;

        doc.roundedRect(x, y, width, cardH, 8).fill("#ffffff");
        doc.roundedRect(x, y, width, cardH, 8).strokeColor(border).lineWidth(0.9).stroke();
        doc.fillColor(primary).font("Helvetica-Bold").fontSize(10).text(title, x + 12, y + topPad, {
            width: width - 24,
        });

        let textY = y + topPad + 24;
        doc.fillColor("#2d3748").font("Helvetica").fontSize(9);
        for (let i = 0; i < contentLines.length; i++) {
            doc.text(contentLines[i], x + 12, textY, { width: width - 24, lineGap: 1 });
            textY += lineH;
        }
        return cardH;
    }

    let y = doc.page.margins.top - 6;

    doc.rect(left, y, fullW, 30).fill(primary);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(16).text("QUOTATION", left, y + 8, {
        width: fullW,
        align: "center",
    });
    y += 42;

    const issuerName = issuerCompany?.name || "Our Firm";
    const addr = formatBranchAddress(issuerCompany);
    const issuerContact = [
        issuerCompany?.mobile_1,
        issuerCompany?.mobile_2,
        issuerCompany?.email_1,
        issuerCompany?.email_2,
    ]
        .filter(Boolean)
        .join(", ");

    doc.fillColor("#111111").font("Helvetica-Bold").fontSize(14).text(issuerName, left, y, {
        width: fullW,
        align: "center",
    });
    y = doc.y + 4;
    if (addr) {
        doc.fillColor("#4a5568").font("Helvetica").fontSize(9.5).text(addr, left + 22, y, {
            width: fullW - 44,
            align: "center",
        });
        y = doc.y + 3;
    }
    if (issuerContact) {
        doc.fillColor("#4a5568").font("Helvetica").fontSize(9.5).text(issuerContact, left + 22, y, {
            width: fullW - 44,
            align: "center",
        });
        y = doc.y + 3;
    }

    const taxMeta = [issuerCompany?.gst ? `GST: ${issuerCompany.gst}` : null, issuerCompany?.pan ? `PAN: ${issuerCompany.pan}` : null]
        .filter(Boolean)
        .join("   |   ");
    if (taxMeta) {
        doc.fillColor("#4a5568").font("Helvetica").fontSize(9).text(taxMeta, left + 22, y, {
            width: fullW - 44,
            align: "center",
        });
        y = doc.y + 8;
    } else {
        y += 10;
    }
    // Show only the quotation date on the right side, status is not displayed.
    const dateValue = formatDate(quotation?.create_date);
    doc.font("Helvetica").fontSize(9).fillColor("#111111").text(`Date: ${dateValue}`, left, y, {
        width: fullW,
        align: "right",
    });
    y = doc.y + 16;

    const gutter = 14;
    const colW = (fullW - gutter) / 2;
    const clientLines = [
        client?.name ? `Name: ${client.name}` : null,
        client?.email ? `Email: ${client.email}` : null,
        client?.mobile ? `Mobile: ${client.mobile}` : null,
        client?.pan_number ? `PAN: ${client.pan_number}` : null,
    ].filter(Boolean);
    const firmLines = [
        clientFirm?.firm_name ? `Firm: ${clientFirm.firm_name}` : null,
        clientFirm?.firm_type ? `Type: ${clientFirm.firm_type}` : null,
        clientFirm?.pan_no ? `PAN: ${clientFirm.pan_no}` : null,
        clientFirm?.gst_no ? `GST: ${clientFirm.gst_no}` : null,
        clientFirm?.cin_no ? `CIN: ${clientFirm.cin_no}` : null,
        clientFirm?.address ? `Address: ${clientFirm.address}` : null,
    ].filter(Boolean);
    const lineH = 13;
    const clientH = 11 + 16 + 8 + Math.max(clientLines.length, 1) * lineH + 10;
    const firmH = 11 + 16 + 8 + Math.max(firmLines.length, 1) * lineH + 10;
    const twoColH = Math.max(clientH, firmH);
    y = ensureSpace(y, twoColH + 16);
    drawLabeledCard({
        x: left,
        y,
        width: colW,
        title: "",
        lines: clientLines,
    });
    drawLabeledCard({
        x: left + colW + gutter,
        y,
        width: colW,
        title: "",
        lines: firmLines,
    });
    y += twoColH + 18;

    doc.fillColor(primary).font("Helvetica-Bold").fontSize(10).text("Services & fees", left, y);
    y += 14;

    const rowH = 22;
    const xStart = left + 8;
    const tableInnerW = fullW - 16;
    const wNum = 26;
    const wFees = 72;
    const wTaxP = 46;
    const wTaxV = 66;
    const wLine = 78;
    const wDesc = Math.max(110, tableInnerW - wNum - wFees - wTaxP - wTaxV - wLine);
    const xNum = xStart;
    const xDesc = xNum + wNum;
    const xFees = xDesc + wDesc;
    const xTaxP = xFees + wFees;
    const xTaxV = xTaxP + wTaxP;
    const xTot = xTaxV + wTaxV;

    y = ensureSpace(y, 36);
    doc.roundedRect(left, y, fullW, 26, 4).fill(primary);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8);
    doc.text("#", xNum, y + 8, { width: wNum, align: "center" });
    doc.text("Service", xDesc, y + 8, { width: wDesc - 4 });
    doc.text("Fees", xFees, y + 8, { width: wFees, align: "right" });
    doc.text("Tax %", xTaxP, y + 8, { width: wTaxP, align: "right" });
    doc.text("Tax", xTaxV, y + 8, { width: wTaxV, align: "right" });
    doc.text("Amount", xTot, y + 8, { width: wLine, align: "right" });
    y += 30;

    doc.fillColor("#111111").font("Helvetica").fontSize(9);
    for (let i = 0; i < lineItems.length; i++) {
        const row = lineItems[i];
        y = ensureSpace(y, rowH + 6);
        doc.strokeColor(border).lineWidth(0.4).moveTo(left, y).lineTo(right, y).stroke();
        y += 4;
        doc.text(String(i + 1), xNum, y, { width: wNum, align: "center" });
        const desc = row.description || "Service";
        doc.text(desc, xDesc, y, { width: wDesc - 4, lineGap: 2 });
        const rowTop = y;
        doc.text(money(row.fees), xFees, rowTop, { width: wFees, align: "right" });
        doc.text(`${Number(row.tax_rate || 0).toFixed(2)}%`, xTaxP, rowTop, { width: wTaxP, align: "right" });
        doc.text(money(row.tax_value), xTaxV, rowTop, { width: wTaxV, align: "right" });
        doc.text(money(row.total), xTot, rowTop, { width: wLine, align: "right" });
        const h = Math.max(rowH, doc.y - rowTop + 6);
        y = rowTop + h;
    }

    doc.strokeColor(border).lineWidth(0.6).moveTo(left, y).lineTo(right, y).stroke();
    y += 16;

    y = ensureSpace(y, 122);
    const sumX = left + fullW * 0.5;
    const sumW = fullW * 0.5;
    const sumRowH = 30;
    const labelW = sumW * 0.56;
    const valueW = sumW - labelW;
    const totalRows = [
        { label: "Subtotal", value: money(totals.subtotalFees), valueColor: "#111111" },
        { label: "Tax", value: money(totals.taxTotal), valueColor: "#111111" },
        { label: "Grand Total", value: money(totals.grandTotal), valueColor: primary },
    ];

    doc.roundedRect(sumX, y, sumW, sumRowH * totalRows.length, 7).strokeColor(border).lineWidth(0.9).stroke();
    for (let i = 0; i < totalRows.length; i++) {
        const rowY = y + i * sumRowH;
        if (i === totalRows.length - 1) {
            doc.rect(sumX, rowY, sumW, sumRowH).fill(soft);
        }
        doc.strokeColor(border).lineWidth(0.5).moveTo(sumX + labelW, rowY).lineTo(sumX + labelW, rowY + sumRowH).stroke();
        if (i < totalRows.length - 1) {
            doc.strokeColor(border).lineWidth(0.5).moveTo(sumX, rowY + sumRowH).lineTo(sumX + sumW, rowY + sumRowH).stroke();
        }
        doc.fillColor("#2d3748").font("Helvetica-Bold").fontSize(10).text(totalRows[i].label, sumX + 10, rowY + 10, {
            width: labelW - 20,
            align: "left",
        });
        doc.fillColor(totalRows[i].valueColor).font("Helvetica-Bold").fontSize(10.5).text(totalRows[i].value, sumX + labelW + 8, rowY + 10, {
            width: valueW - 16,
            align: "right",
        });
    }
    y += sumRowH * totalRows.length + 18;

    y = ensureSpace(y, 60);
    doc.fillColor("#666666").font("Helvetica").fontSize(8).text(
        "This quotation is generated from our practice management system. Pricing is indicative and may be subject to agreed scope, timelines, and applicable statutory provisions. For acceptance or queries, please contact us using the details above.",
        left,
        y,
        { width: fullW, align: "left", lineGap: 2 }
    );

    return new Promise((resolve, reject) => {
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);
        doc.end();
    });
}
