// SaleInvoicePremiumLayouts.js

import PDFDocument from "pdfkit";

function money(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "Rs. 0.00";
    return `Rs. ${x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

// Helper function to format currency with proper alignment
function formatCurrency(value) {
    return money(value);
}

// Premium Template 1: Modern with perfect alignment
export function renderPremiumModern(doc, t, {
    title,
    billToLabel,
    invoice,
    transactionRow,
    items,
    partyName,
    issuer,
}) {
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const fullW = right - left;
    
    // Header
    doc.rect(left, 20, fullW, 85).fill(t.primary);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(28)
        .text(title, left + 25, 45, { width: fullW - 50 });
    doc.font("Helvetica").fontSize(10).fillColor("#e0e0e0")
        .text("Professional Tax Invoice", left + 25, 80);
    
    // Metadata cards
    const metaY = 120;
    const cardWidth = (fullW - 60) / 3;
    const metaData = [
        { label: "INVOICE NUMBER", value: invoice.invoice_no || "-" },
        { label: "INVOICE DATE", value: invoice.create_date ? new Date(invoice.create_date).toLocaleDateString("en-IN") : "-" },
        { label: "TRANSACTION DATE", value: transactionRow?.transaction_date ? new Date(transactionRow.transaction_date).toLocaleDateString("en-IN") : "-" }
    ];
    
    for (let i = 0; i < metaData.length; i++) {
        const x = left + 15 + (i * (cardWidth + 15));
        doc.roundedRect(x, metaY, cardWidth, 55, 8).fill("#f8f9fa");
        doc.fillColor("#6c757d").font("Helvetica-Bold").fontSize(8)
            .text(metaData[i].label, x + 12, metaY + 12);
        doc.fillColor(t.primary).font("Helvetica-Bold").fontSize(12)
            .text(metaData[i].value, x + 12, metaY + 32);
    }
    
    // Business and customer section
    let y = metaY + 75;
    doc.roundedRect(left + 15, y, fullW - 30, 75, 8).fill(t.soft);
    
    doc.fillColor(t.primary).font("Helvetica-Bold").fontSize(10)
        .text("FROM", left + 30, y + 12);
    doc.fillColor("#333333").font("Helvetica-Bold").fontSize(10)
        .text(issuer?.name || "Business", left + 30, y + 28);
    doc.fillColor("#666666").font("Helvetica").fontSize(8);
    if (issuer?.address) {
        doc.text(issuer.address, left + 30, y + 44, { width: (fullW - 60) / 2 });
    }
    
    doc.fillColor(t.primary).font("Helvetica-Bold").fontSize(10)
        .text(billToLabel.toUpperCase(), left + fullW / 2 + 15, y + 12);
    doc.fillColor("#333333").font("Helvetica-Bold").fontSize(10)
        .text(partyName || "-", left + fullW / 2 + 15, y + 28);
    
    // Items table
    y += 95;
    const colDesc = left + 20;
    const colAmount = left + fullW * 0.55;
    const colTax = left + fullW * 0.72;
    const colTotal = left + fullW * 0.88;
    
    // Table header
    doc.roundedRect(left + 15, y, fullW - 30, 32, 6).fill(t.primary);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9);
    doc.text("Description", colDesc + 5, y + 11);
    doc.text("Amount", colAmount, y + 11, { width: 80, align: "right" });
    doc.text("Tax", colTax, y + 11, { width: 70, align: "right" });
    doc.text("Total", colTotal, y + 11, { width: 80, align: "right" });
    
    y += 32;
    
    // Table rows
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const bgColor = i % 2 === 0 ? "#ffffff" : "#f8f9fa";
        doc.rect(left + 15, y, fullW - 30, 28).fill(bgColor);
        
        doc.fillColor("#333333").font("Helvetica").fontSize(9);
        doc.text(it.service_name || "Item", colDesc + 5, y + 9);
        doc.text(formatCurrency(it.fees), colAmount, y + 9, { width: 80, align: "right" });
        doc.text(formatCurrency(it.tax_value), colTax, y + 9, { width: 70, align: "right" });
        doc.text(formatCurrency(it.total), colTotal, y + 9, { width: 80, align: "right" });
        y += 28;
    }
    
    // Totals section - PERFECT ALIGNMENT
    y += 25;
    const totalsWidth = 280;
    const totalsX = right - totalsWidth - 15;
    
    doc.roundedRect(totalsX, y, totalsWidth, 135, 8).fill(t.soft);
    doc.rect(totalsX, y, totalsWidth, 4).fill(t.primary);
    
    let ty = y + 25;
    const labelX = totalsX + 20;
    const valueX = totalsX + totalsWidth - 20;
    
    // Subtotal
    doc.fillColor("#555555").font("Helvetica").fontSize(10);
    doc.text("Subtotal:", labelX, ty);
    doc.text(formatCurrency(invoice.subtotal), valueX, ty, { align: "right" });
    
    ty += 24;
    doc.text(`Tax (${Number(invoice.tax_rate || 0).toFixed(2)}%):`, labelX, ty);
    doc.text(formatCurrency(invoice.tax_value), valueX, ty, { align: "right" });
    
    if (Number(invoice.additional_charge) > 0) {
        ty += 24;
        doc.text("Additional charges:", labelX, ty);
        doc.text(formatCurrency(invoice.additional_charge), valueX, ty, { align: "right" });
    }
    
    // Separator
    ty += 18;
    doc.moveTo(totalsX + 15, ty).lineTo(totalsX + totalsWidth - 15, ty).lineWidth(0.8).stroke("#cccccc");
    
    // Grand Total
    ty += 20;
    doc.fillColor(t.primary).font("Helvetica-Bold").fontSize(12);
    doc.text("GRAND TOTAL:", labelX, ty);
    doc.text(formatCurrency(invoice.grand_total), valueX, ty, { align: "right" });
    
    // Remarks
    if (transactionRow?.remark) {
        y += 160;
        doc.roundedRect(left + 15, y, fullW - 30, 45, 6).fill("#fff8f0");
        doc.fillColor("#e65100").font("Helvetica-Bold").fontSize(8)
            .text("NOTES", left + 30, y + 12);
        doc.fillColor("#555555").font("Helvetica").fontSize(9)
            .text(String(transactionRow.remark), left + 30, y + 28, { width: fullW - 70 });
    }
}

// Premium Template 2: Elegant with perfect alignment
export function renderPremiumElegant(doc, t, {
    title,
    billToLabel,
    invoice,
    transactionRow,
    items,
    partyName,
    issuer,
}) {
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const fullW = right - left;
    
    // Gold border frame
    doc.lineWidth(1.5).strokeColor(t.accent);
    doc.rect(left + 10, 20, fullW - 20, doc.page.height - 80).stroke();
    
    // Title
    doc.fillColor(t.primary).font("Helvetica-Bold").fontSize(24)
        .text(title, left + 30, 45, { width: fullW - 60, align: "center" });
    doc.moveTo(left + 100, 75).lineTo(right - 100, 75).lineWidth(1).stroke(t.accent);
    
    // Invoice details
    const metaY = 95;
    const col1X = left + 40;
    const col2X = left + 180;
    
    doc.fillColor("#666666").font("Helvetica").fontSize(9);
    doc.text("Invoice Number:", col1X, metaY);
    doc.text("Date:", col1X, metaY + 20);
    doc.text("Transaction Date:", col1X, metaY + 40);
    
    doc.fillColor(t.primary).font("Helvetica-Bold").fontSize(10);
    doc.text(String(invoice.invoice_no || "-"), col2X, metaY);
    doc.text(invoice.create_date ? new Date(invoice.create_date).toLocaleDateString("en-IN") : "-", col2X, metaY + 20);
    doc.text(transactionRow?.transaction_date ? new Date(transactionRow.transaction_date).toLocaleDateString("en-IN") : "-", col2X, metaY + 40);
    
    // Party boxes
    let y = 160;
    const boxHeight = 85;
    const boxWidth = (fullW - 80) / 2;
    
    doc.roundedRect(left + 25, y, boxWidth, boxHeight, 4).fill(t.soft);
    doc.fillColor(t.accent).font("Helvetica-Bold").fontSize(10)
        .text("BILL FROM", left + 40, y + 12);
    doc.fillColor("#333333").font("Helvetica-Bold").fontSize(10)
        .text(issuer?.name || "Business", left + 40, y + 32);
    doc.fillColor("#666666").font("Helvetica").fontSize(8);
    if (issuer?.address) {
        doc.text(issuer.address, left + 40, y + 50, { width: boxWidth - 30 });
    }
    
    doc.roundedRect(left + fullW / 2 + 15, y, boxWidth, boxHeight, 4).fill(t.soft);
    doc.fillColor(t.accent).font("Helvetica-Bold").fontSize(10)
        .text(billToLabel.toUpperCase(), left + fullW / 2 + 30, y + 12);
    doc.fillColor("#333333").font("Helvetica-Bold").fontSize(10)
        .text(partyName || "-", left + fullW / 2 + 30, y + 32);
    
    // Items table
    y += boxHeight + 25;
    const colDesc = left + 35;
    const colAmount = left + fullW * 0.55;
    const colTax = left + fullW * 0.72;
    const colTotal = left + fullW * 0.88;
    
    doc.fillColor(t.accent).font("Helvetica-Bold").fontSize(9);
    doc.text("Description", colDesc, y);
    doc.text("Amount", colAmount, y, { width: 80, align: "right" });
    doc.text("Tax", colTax, y, { width: 70, align: "right" });
    doc.text("Total", colTotal, y, { width: 80, align: "right" });
    
    y += 10;
    doc.moveTo(left + 25, y).lineTo(right - 25, y).lineWidth(0.5).stroke();
    y += 12;
    
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (i % 2 === 0) {
            doc.rect(left + 25, y, fullW - 50, 26).fill(t.soft);
        }
        
        doc.fillColor("#444444").font("Helvetica").fontSize(9);
        doc.text(it.service_name || "Item", colDesc + 5, y + 8);
        doc.text(formatCurrency(it.fees), colAmount, y + 8, { width: 80, align: "right" });
        doc.text(formatCurrency(it.tax_value), colTax, y + 8, { width: 70, align: "right" });
        doc.text(formatCurrency(it.total), colTotal, y + 8, { width: 80, align: "right" });
        y += 26;
    }
    
    // Totals section
    y += 25;
    const totalsWidth = 260;
    const totalsX = right - totalsWidth - 30;
    
    doc.roundedRect(totalsX, y, totalsWidth, 135, 4).fill(t.soft);
    
    let ty = y + 25;
    const labelOffset = 25;
    const valueOffset = totalsWidth - 25;
    
    doc.fillColor("#555555").font("Helvetica").fontSize(10);
    doc.text("Subtotal:", totalsX + labelOffset, ty);
    doc.text(formatCurrency(invoice.subtotal), totalsX + valueOffset, ty, { align: "right" });
    
    ty += 24;
    doc.text(`Tax (${Number(invoice.tax_rate || 0).toFixed(2)}%):`, totalsX + labelOffset, ty);
    doc.text(formatCurrency(invoice.tax_value), totalsX + valueOffset, ty, { align: "right" });
    
    if (Number(invoice.additional_charge) > 0) {
        ty += 24;
        doc.text("Additional charges:", totalsX + labelOffset, ty);
        doc.text(formatCurrency(invoice.additional_charge), totalsX + valueOffset, ty, { align: "right" });
    }
    
    ty += 18;
    doc.moveTo(totalsX + 15, ty).lineTo(totalsX + totalsWidth - 15, ty).lineWidth(0.8).stroke();
    
    ty += 20;
    doc.fillColor(t.primary).font("Helvetica-Bold").fontSize(12);
    doc.text("GRAND TOTAL:", totalsX + labelOffset, ty);
    doc.text(formatCurrency(invoice.grand_total), totalsX + valueOffset, ty, { align: "right" });
    
    if (transactionRow?.remark) {
        y += 160;
        doc.roundedRect(left + 25, y, fullW - 50, 45, 4).stroke(t.accent);
        doc.fillColor(t.accent).font("Helvetica-Bold").fontSize(8)
            .text("REMARKS", left + 40, y + 12);
        doc.fillColor("#555555").font("Helvetica").fontSize(9)
            .text(String(transactionRow.remark), left + 40, y + 28, { width: fullW - 100 });
    }
}

// Premium Template 3: Corporate with proper totals
export function renderPremiumCorporate(doc, t, {
    title,
    billToLabel,
    invoice,
    transactionRow,
    items,
    partyName,
    issuer,
}) {
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const fullW = right - left;
    
    // Sidebar
    const sidebarWidth = 85;
    doc.rect(left, 20, sidebarWidth, doc.page.height - 80).fill(t.primary);
    
    doc.save();
    doc.translate(left + 22, 250);
    doc.rotate(-90);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(13)
        .text(title, 0, 0);
    doc.restore();
    
    const mainLeft = left + sidebarWidth + 25;
    const mainW = fullW - sidebarWidth - 25;
    
    // Header
    doc.fillColor(t.primary).font("Helvetica-Bold").fontSize(22)
        .text("TAX INVOICE", mainLeft, 35);
    doc.moveTo(mainLeft, 65).lineTo(mainLeft + mainW, 65).lineWidth(2).stroke(t.accent);
    
    // Metadata grid
    const metaY = 85;
    const metaWidth = mainW / 3;
    
    const metaData = [
        { label: "INVOICE NO", value: invoice.invoice_no || "-" },
        { label: "DATE", value: invoice.create_date ? new Date(invoice.create_date).toLocaleDateString("en-IN") : "-" },
        { label: "TRANSACTION DATE", value: transactionRow?.transaction_date ? new Date(transactionRow.transaction_date).toLocaleDateString("en-IN") : "-" }
    ];
    
    for (let i = 0; i < metaData.length; i++) {
        const x = mainLeft + (i * metaWidth);
        doc.fillColor("#666666").font("Helvetica-Bold").fontSize(8)
            .text(metaData[i].label, x, metaY);
        doc.fillColor("#000000").font("Helvetica-Bold").fontSize(10)
            .text(metaData[i].value, x, metaY + 16);
    }
    
    // Party info
    let y = 145;
    doc.fillColor("#666666").font("Helvetica-Bold").fontSize(9)
        .text("FROM", mainLeft, y);
    doc.fillColor("#000000").font("Helvetica").fontSize(9);
    y += 14;
    doc.text(issuer?.name || "Business", mainLeft, y);
    if (issuer?.address) {
        doc.text(issuer.address, mainLeft, y + 14, { width: mainW / 2 });
    }
    
    doc.fillColor("#666666").font("Helvetica-Bold").fontSize(9)
        .text(billToLabel.toUpperCase(), mainLeft + mainW / 2 + 10, 145);
    doc.fillColor("#000000").font("Helvetica-Bold").fontSize(10)
        .text(partyName || "-", mainLeft + mainW / 2 + 10, 159);
    
    // Items table
    y = 220;
    const colDesc = mainLeft;
    const colAmount = mainLeft + mainW * 0.55;
    const colTax = mainLeft + mainW * 0.72;
    const colTotal = mainLeft + mainW * 0.88;
    
    doc.rect(mainLeft, y, mainW, 30).fill(t.accent);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8);
    doc.text("Description", colDesc + 8, y + 11);
    doc.text("Amount", colAmount, y + 11, { width: 80, align: "right" });
    doc.text("Tax", colTax, y + 11, { width: 70, align: "right" });
    doc.text("Total", colTotal, y + 11, { width: 80, align: "right" });
    
    y += 30;
    
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const bgColor = i % 2 === 0 ? "#ffffff" : "#f8f9fa";
        doc.rect(mainLeft, y, mainW, 26).fill(bgColor);
        
        doc.fillColor("#333333").font("Helvetica").fontSize(8);
        doc.text(it.service_name || "Item", colDesc + 8, y + 8);
        doc.text(formatCurrency(it.fees), colAmount, y + 8, { width: 80, align: "right" });
        doc.text(formatCurrency(it.tax_value), colTax, y + 8, { width: 70, align: "right" });
        doc.text(formatCurrency(it.total), colTotal, y + 8, { width: 80, align: "right" });
        
        doc.moveTo(mainLeft, y + 26).lineTo(mainLeft + mainW, y + 26).lineWidth(0.5).stroke("#e0e0e0");
        y += 26;
    }
    
    // Totals
    y += 25;
    const totalsWidth = 260;
    const totalsX = mainLeft + mainW - totalsWidth;
    
    doc.rect(totalsX, y, totalsWidth, 135).fill(t.soft);
    
    let ty = y + 25;
    const leftLabel = totalsX + 25;
    const rightValue = totalsX + totalsWidth - 25;
    
    doc.fillColor("#555555").font("Helvetica").fontSize(10);
    doc.text("Subtotal:", leftLabel, ty);
    doc.text(formatCurrency(invoice.subtotal), rightValue, ty, { align: "right" });
    
    ty += 24;
    doc.text(`Tax (${Number(invoice.tax_rate || 0).toFixed(2)}%):`, leftLabel, ty);
    doc.text(formatCurrency(invoice.tax_value), rightValue, ty, { align: "right" });
    
    if (Number(invoice.additional_charge) > 0) {
        ty += 24;
        doc.text("Additional charges:", leftLabel, ty);
        doc.text(formatCurrency(invoice.additional_charge), rightValue, ty, { align: "right" });
    }
    
    ty += 18;
    doc.moveTo(totalsX + 15, ty).lineTo(totalsX + totalsWidth - 15, ty).lineWidth(1).stroke(t.accent);
    
    ty += 20;
    doc.fillColor(t.primary).font("Helvetica-Bold").fontSize(12);
    doc.text("GRAND TOTAL:", leftLabel, ty);
    doc.text(formatCurrency(invoice.grand_total), rightValue, ty, { align: "right" });
}

// Premium Template 4: Creative with vibrant design
export function renderPremiumCreative(doc, t, {
    title,
    billToLabel,
    invoice,
    transactionRow,
    items,
    partyName,
    issuer,
}) {
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const fullW = right - left;
    
    // Header
    const accentColor = "#ff6b35";
    doc.rect(left, 20, fullW, 80).fill(accentColor);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(26)
        .text(title, left + 25, 45, { width: fullW - 50 });
    
    // Metadata cards
    const metaY = 115;
    const cardWidth = (fullW - 60) / 3;
    const metaData = [
        { label: "INVOICE NO", value: invoice.invoice_no || "-" },
        { label: "DATE", value: invoice.create_date ? new Date(invoice.create_date).toLocaleDateString("en-IN") : "-" },
        { label: "TRANSACTION DATE", value: transactionRow?.transaction_date ? new Date(transactionRow.transaction_date).toLocaleDateString("en-IN") : "-" }
    ];
    
    for (let i = 0; i < metaData.length; i++) {
        const x = left + 15 + (i * (cardWidth + 15));
        doc.roundedRect(x, metaY, cardWidth, 55, 10).fill("#ffffff");
        doc.fillColor("#6c757d").font("Helvetica-Bold").fontSize(8)
            .text(metaData[i].label, x + 15, metaY + 12);
        doc.fillColor(accentColor).font("Helvetica-Bold").fontSize(12)
            .text(metaData[i].value, x + 15, metaY + 32);
    }
    
    // Party section
    let y = metaY + 75;
    doc.roundedRect(left + 15, y, fullW - 30, 80, 10).fill(t.soft);
    
    doc.fillColor(accentColor).font("Helvetica-Bold").fontSize(10)
        .text("FROM", left + 30, y + 12);
    doc.fillColor("#333333").font("Helvetica-Bold").fontSize(10)
        .text(issuer?.name || "Business", left + 30, y + 30);
    doc.fillColor("#666666").font("Helvetica").fontSize(8);
    if (issuer?.address) {
        doc.text(issuer.address, left + 30, y + 46, { width: (fullW - 60) / 2 });
    }
    
    doc.fillColor(accentColor).font("Helvetica-Bold").fontSize(10)
        .text(billToLabel.toUpperCase(), left + fullW / 2 + 15, y + 12);
    doc.fillColor("#333333").font("Helvetica-Bold").fontSize(10)
        .text(partyName || "-", left + fullW / 2 + 15, y + 30);
    
    // Items table
    y += 100;
    const colDesc = left + 20;
    const colAmount = left + fullW * 0.55;
    const colTax = left + fullW * 0.72;
    const colTotal = left + fullW * 0.88;
    
    doc.roundedRect(left + 15, y, fullW - 30, 35, 8).fill(accentColor);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9);
    doc.text("Description", colDesc + 8, y + 13);
    doc.text("Amount", colAmount, y + 13, { width: 80, align: "right" });
    doc.text("Tax", colTax, y + 13, { width: 70, align: "right" });
    doc.text("Total", colTotal, y + 13, { width: 80, align: "right" });
    
    y += 35;
    
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const bgColor = i % 2 === 0 ? "#ffffff" : "#fff5f0";
        doc.rect(left + 15, y, fullW - 30, 28).fill(bgColor);
        
        doc.fillColor("#333333").font("Helvetica").fontSize(9);
        doc.text(it.service_name || "Item", colDesc + 8, y + 9);
        doc.text(formatCurrency(it.fees), colAmount, y + 9, { width: 80, align: "right" });
        doc.text(formatCurrency(it.tax_value), colTax, y + 9, { width: 70, align: "right" });
        doc.text(formatCurrency(it.total), colTotal, y + 9, { width: 80, align: "right" });
        y += 28;
    }
    
    // Totals
    y += 25;
    const totalsWidth = 280;
    const totalsX = right - totalsWidth - 15;
    
    doc.roundedRect(totalsX, y, totalsWidth, 135, 10).fill(t.soft);
    doc.rect(totalsX, y, totalsWidth, 5).fill(accentColor);
    
    let ty = y + 25;
    const labelOffset = 25;
    const valueOffset = totalsWidth - 25;
    
    doc.fillColor("#555555").font("Helvetica").fontSize(10);
    doc.text("Subtotal:", totalsX + labelOffset, ty);
    doc.text(formatCurrency(invoice.subtotal), totalsX + valueOffset, ty, { align: "right" });
    
    ty += 24;
    doc.text(`Tax (${Number(invoice.tax_rate || 0).toFixed(2)}%):`, totalsX + labelOffset, ty);
    doc.text(formatCurrency(invoice.tax_value), totalsX + valueOffset, ty, { align: "right" });
    
    if (Number(invoice.additional_charge) > 0) {
        ty += 24;
        doc.text("Additional charges:", totalsX + labelOffset, ty);
        doc.text(formatCurrency(invoice.additional_charge), totalsX + valueOffset, ty, { align: "right" });
    }
    
    ty += 18;
    doc.moveTo(totalsX + 15, ty).lineTo(totalsX + totalsWidth - 15, ty).lineWidth(0.8).stroke();
    
    ty += 20;
    doc.fillColor(accentColor).font("Helvetica-Bold").fontSize(12);
    doc.text("GRAND TOTAL:", totalsX + labelOffset, ty);
    doc.text(formatCurrency(invoice.grand_total), totalsX + valueOffset, ty, { align: "right" });
    
    if (transactionRow?.remark) {
        y += 160;
        doc.roundedRect(left + 15, y, fullW - 30, 45, 8).fill("#fff8f0");
        doc.fillColor(accentColor).font("Helvetica-Bold").fontSize(8)
            .text("NOTES", left + 30, y + 12);
        doc.fillColor("#555555").font("Helvetica").fontSize(9)
            .text(String(transactionRow.remark), left + 30, y + 28, { width: fullW - 70 });
    }
}

// Premium Template 5: Luxury with premium alignment
export function renderPremiumLuxury(doc, t, {
    title,
    billToLabel,
    invoice,
    transactionRow,
    items,
    partyName,
    issuer,
}) {
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const fullW = right - left;
    
    // Header
    doc.rect(left, 20, fullW, 95).fill(t.primary);
    doc.rect(left, 20, fullW, 4).fill(t.accent);
    
    doc.fillColor(t.accent).font("Helvetica-Bold").fontSize(28)
        .text(title, left + 30, 50, { width: fullW - 60 });
    doc.fillColor("#888888").font("Helvetica").fontSize(9)
        .text("Official Tax Document", left + 30, 85);
    
    // Metadata cards
    const metaY = 130;
    const cardWidth = (fullW - 70) / 3;
    const metaData = [
        { label: "INVOICE NUMBER", value: invoice.invoice_no || "-" },
        { label: "ISSUE DATE", value: invoice.create_date ? new Date(invoice.create_date).toLocaleDateString("en-IN") : "-" },
        { label: "TRANSACTION DATE", value: transactionRow?.transaction_date ? new Date(transactionRow.transaction_date).toLocaleDateString("en-IN") : "-" }
    ];
    
    for (let i = 0; i < metaData.length; i++) {
        const x = left + 20 + (i * (cardWidth + 15));
        doc.roundedRect(x, metaY, cardWidth, 60, 4).fill(t.soft);
        doc.rect(x, metaY, cardWidth, 4).fill(t.accent);
        doc.fillColor("#666666").font("Helvetica-Bold").fontSize(8)
            .text(metaData[i].label, x + 15, metaY + 15);
        doc.fillColor(t.primary).font("Helvetica-Bold").fontSize(11)
            .text(metaData[i].value, x + 15, metaY + 38);
    }
    
    // Party boxes
    let y = metaY + 85;
    const boxWidth = (fullW - 70) / 2;
    const boxHeight = 95;
    
    doc.roundedRect(left + 20, y, boxWidth, boxHeight, 4).stroke(t.accent);
    doc.fillColor(t.accent).font("Helvetica-Bold").fontSize(9)
        .text("BILL FROM", left + 35, y + 15);
    doc.fillColor("#333333").font("Helvetica-Bold").fontSize(10)
        .text(issuer?.name || "Business", left + 35, y + 35);
    doc.fillColor("#666666").font("Helvetica").fontSize(8);
    if (issuer?.address) {
        doc.text(issuer.address, left + 35, y + 53, { width: boxWidth - 30 });
    }
    
    doc.roundedRect(left + fullW / 2 + 15, y, boxWidth, boxHeight, 4).stroke(t.accent);
    doc.fillColor(t.accent).font("Helvetica-Bold").fontSize(9)
        .text(billToLabel.toUpperCase(), left + fullW / 2 + 30, y + 15);
    doc.fillColor("#333333").font("Helvetica-Bold").fontSize(10)
        .text(partyName || "-", left + fullW / 2 + 30, y + 35);
    
    // Items table
    y += boxHeight + 25;
    const colDesc = left + 25;
    const colAmount = left + fullW * 0.55;
    const colTax = left + fullW * 0.72;
    const colTotal = left + fullW * 0.88;
    
    doc.rect(left + 20, y, fullW - 40, 32).fill(t.primary);
    doc.fillColor(t.accent).font("Helvetica-Bold").fontSize(9);
    doc.text("Description", colDesc + 8, y + 12);
    doc.text("Amount", colAmount, y + 12, { width: 80, align: "right" });
    doc.text("Tax", colTax, y + 12, { width: 70, align: "right" });
    doc.text("Total", colTotal, y + 12, { width: 80, align: "right" });
    
    y += 32;
    
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const bgColor = i % 2 === 0 ? "#ffffff" : "#faf9f7";
        doc.rect(left + 20, y, fullW - 40, 28).fill(bgColor);
        
        doc.fillColor("#444444").font("Helvetica").fontSize(9);
        doc.text(it.service_name || "Item", colDesc + 8, y + 9);
        doc.text(formatCurrency(it.fees), colAmount, y + 9, { width: 80, align: "right" });
        doc.text(formatCurrency(it.tax_value), colTax, y + 9, { width: 70, align: "right" });
        doc.text(formatCurrency(it.total), colTotal, y + 9, { width: 80, align: "right" });
        y += 28;
    }
    
    // Totals
    y += 25;
    const totalsWidth = 300;
    const totalsX = right - totalsWidth - 25;
    
    doc.roundedRect(totalsX, y, totalsWidth, 145, 4).fill(t.soft);
    doc.rect(totalsX, y, totalsWidth, 5).fill(t.accent);
    
    let ty = y + 28;
    const labelLeft = totalsX + 28;
    const valueRight = totalsX + totalsWidth - 28;
    
    doc.fillColor("#555555").font("Helvetica").fontSize(10);
    doc.text("Subtotal:", labelLeft, ty);
    doc.text(formatCurrency(invoice.subtotal), valueRight, ty, { align: "right" });
    
    ty += 26;
    doc.text(`Tax (${Number(invoice.tax_rate || 0).toFixed(2)}%):`, labelLeft, ty);
    doc.text(formatCurrency(invoice.tax_value), valueRight, ty, { align: "right" });
    
    if (Number(invoice.additional_charge) > 0) {
        ty += 26;
        doc.text("Additional charges:", labelLeft, ty);
        doc.text(formatCurrency(invoice.additional_charge), valueRight, ty, { align: "right" });
    }
    
    ty += 22;
    doc.moveTo(totalsX + 20, ty).lineTo(totalsX + totalsWidth - 20, ty).lineWidth(1).stroke(t.accent);
    
    ty += 22;
    doc.fillColor(t.accent).font("Helvetica-Bold").fontSize(13);
    doc.text("GRAND TOTAL:", labelLeft, ty);
    doc.text(formatCurrency(invoice.grand_total), valueRight, ty, { align: "right" });
    
    if (transactionRow?.remark) {
        y += 175;
        doc.roundedRect(left + 20, y, fullW - 40, 50, 4).stroke(t.accent);
        doc.fillColor(t.accent).font("Helvetica-Bold").fontSize(8)
            .text("REMARKS", left + 35, y + 15);
        doc.fillColor("#555555").font("Helvetica").fontSize(9)
            .text(String(transactionRow.remark), left + 35, y + 32, { width: fullW - 90 });
    }
}

// Export all premium renderers
export const premiumRenderers = {
    premium_modern: renderPremiumModern,
    premium_elegant: renderPremiumElegant,
    premium_corporate: renderPremiumCorporate,
    premium_creative: renderPremiumCreative,
    premium_luxury: renderPremiumLuxury
};