// PurchaseInvoicePremiumLayouts.js

import PDFDocument from "pdfkit";

function money(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "Rs. 0.00";
    return `Rs. ${x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

function formatCurrency(value) {
    return money(value);
}

// Template 1: Premium Modern Purchase
export function renderPurchasePremiumModern(doc, t, {
    title,
    billToLabel = "Supplier",
    invoice,
    transactionRow,
    items,
    partyName,
    issuer,
}) {
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const fullW = right - left;
    
    doc.rect(left, 20, fullW, 85).fill("#1a237e");
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(28)
        .text("PURCHASE INVOICE", left + 25, 45, { width: fullW - 50 });
    doc.font("Helvetica").fontSize(10).fillColor("#e0e0e0")
        .text("Purchase Order", left + 25, 80);
    
    const metaY = 120;
    const cardWidth = (fullW - 60) / 3;
    const metaData = [
        { label: "PO NUMBER", value: invoice.invoice_no || "-" },
        { label: "PO DATE", value: invoice.create_date ? new Date(invoice.create_date).toLocaleDateString("en-IN") : "-" },
        { label: "DELIVERY DATE", value: transactionRow?.transaction_date ? new Date(transactionRow.transaction_date).toLocaleDateString("en-IN") : "-" }
    ];
    
    for (let i = 0; i < metaData.length; i++) {
        const x = left + 15 + (i * (cardWidth + 15));
        doc.roundedRect(x, metaY, cardWidth, 55, 8).fill("#f8f9fa");
        doc.fillColor("#6c757d").font("Helvetica-Bold").fontSize(8)
            .text(metaData[i].label, x + 12, metaY + 12);
        doc.fillColor("#1a237e").font("Helvetica-Bold").fontSize(12)
            .text(metaData[i].value, x + 12, metaY + 32);
    }
    
    let y = metaY + 75;
    doc.roundedRect(left + 15, y, fullW - 30, 75, 8).fill(t.soft);
    
    doc.fillColor("#1a237e").font("Helvetica-Bold").fontSize(10)
        .text("SUPPLIER", left + 30, y + 12);
    doc.fillColor("#333333").font("Helvetica-Bold").fontSize(10)
        .text(partyName || "-", left + 30, y + 28);
    if (issuer?.address) {
        doc.fillColor("#666666").font("Helvetica").fontSize(8)
            .text(issuer.address, left + 30, y + 44, { width: (fullW - 60) / 2 });
    }
    
    doc.fillColor("#1a237e").font("Helvetica-Bold").fontSize(10)
        .text("BILL TO", left + fullW / 2 + 15, y + 12);
    doc.fillColor("#333333").font("Helvetica-Bold").fontSize(10)
        .text(issuer?.name || "Business", left + fullW / 2 + 15, y + 28);
    
    y += 95;
    const colDesc = left + 20;
    const colAmount = left + fullW * 0.55;
    const colTax = left + fullW * 0.72;
    const colTotal = left + fullW * 0.88;
    
    doc.roundedRect(left + 15, y, fullW - 30, 32, 6).fill("#1a237e");
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9);
    doc.text("Product / Service", colDesc + 5, y + 11);
    doc.text("Amount", colAmount, y + 11, { width: 80, align: "right" });
    doc.text("Tax", colTax, y + 11, { width: 70, align: "right" });
    doc.text("Total", colTotal, y + 11, { width: 80, align: "right" });
    
    y += 32;
    
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
    
    y += 25;
    const totalsWidth = 280;
    const totalsX = right - totalsWidth - 15;
    
    doc.roundedRect(totalsX, y, totalsWidth, 135, 8).fill(t.soft);
    doc.rect(totalsX, y, totalsWidth, 4).fill("#1a237e");
    
    let ty = y + 25;
    const labelX = totalsX + 20;
    const valueX = totalsX + totalsWidth - 20;
    
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
    
    ty += 18;
    doc.moveTo(totalsX + 15, ty).lineTo(totalsX + totalsWidth - 15, ty).lineWidth(0.8).stroke("#cccccc");
    
    ty += 20;
    doc.fillColor("#1a237e").font("Helvetica-Bold").fontSize(12);
    doc.text("TOTAL AMOUNT:", labelX, ty);
    doc.text(formatCurrency(invoice.grand_total), valueX, ty, { align: "right" });
    
    if (transactionRow?.remark) {
        y += 160;
        doc.roundedRect(left + 15, y, fullW - 30, 45, 6).fill("#fff8e1");
        doc.fillColor("#e65100").font("Helvetica-Bold").fontSize(8)
            .text("REMARKS", left + 30, y + 12);
        doc.fillColor("#555555").font("Helvetica").fontSize(9)
            .text(String(transactionRow.remark), left + 30, y + 28, { width: fullW - 70 });
    }
}

// Template 2: Premium Elegant Purchase
export function renderPurchasePremiumElegant(doc, t, {
    title,
    billToLabel = "Supplier",
    invoice,
    transactionRow,
    items,
    partyName,
    issuer,
}) {
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const fullW = right - left;
    
    doc.lineWidth(1.5).strokeColor("#b8860b");
    doc.rect(left + 10, 20, fullW - 20, doc.page.height - 80).stroke();
    
    doc.fillColor("#4a3728").font("Helvetica-Bold").fontSize(24)
        .text("PURCHASE ORDER", left + 30, 45, { width: fullW - 60, align: "center" });
    doc.moveTo(left + 100, 75).lineTo(right - 100, 75).lineWidth(1).stroke("#b8860b");
    
    const metaY = 95;
    doc.fillColor("#666666").font("Helvetica").fontSize(9);
    doc.text("PO Number:", left + 40, metaY);
    doc.text("Order Date:", left + 40, metaY + 20);
    doc.text("Expected Delivery:", left + 40, metaY + 40);
    
    doc.fillColor("#4a3728").font("Helvetica-Bold").fontSize(10);
    doc.text(String(invoice.invoice_no || "-"), left + 170, metaY);
    doc.text(invoice.create_date ? new Date(invoice.create_date).toLocaleDateString("en-IN") : "-", left + 170, metaY + 20);
    doc.text(transactionRow?.transaction_date ? new Date(transactionRow.transaction_date).toLocaleDateString("en-IN") : "-", left + 170, metaY + 40);
    
    let y = 150;
    const boxWidth = (fullW - 80) / 2;
    
    doc.roundedRect(left + 25, y, boxWidth, 85, 4).fill(t.soft);
    doc.fillColor("#b8860b").font("Helvetica-Bold").fontSize(10)
        .text("SUPPLIER", left + 40, y + 12);
    doc.fillColor("#333333").font("Helvetica-Bold").fontSize(10)
        .text(partyName || "-", left + 40, y + 32);
    
    doc.roundedRect(left + fullW / 2 + 15, y, boxWidth, 85, 4).fill(t.soft);
    doc.fillColor("#b8860b").font("Helvetica-Bold").fontSize(10)
        .text("SHIP TO", left + fullW / 2 + 30, y + 12);
    doc.fillColor("#333333").font("Helvetica-Bold").fontSize(10)
        .text(issuer?.name || "Business", left + fullW / 2 + 30, y + 32);
    if (issuer?.address) {
        doc.fillColor("#666666").font("Helvetica").fontSize(8)
            .text(issuer.address, left + fullW / 2 + 30, y + 50, { width: boxWidth - 30 });
    }
    
    y += 110;
    const colDesc = left + 35;
    const colAmount = left + fullW * 0.55;
    const colTax = left + fullW * 0.72;
    const colTotal = left + fullW * 0.88;
    
    doc.fillColor("#b8860b").font("Helvetica-Bold").fontSize(9);
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
    doc.fillColor("#4a3728").font("Helvetica-Bold").fontSize(12);
    doc.text("GRAND TOTAL:", totalsX + labelOffset, ty);
    doc.text(formatCurrency(invoice.grand_total), totalsX + valueOffset, ty, { align: "right" });
}

// Template 3: Premium Corporate Purchase
export function renderPurchasePremiumCorporate(doc, t, {
    title,
    billToLabel = "Supplier",
    invoice,
    transactionRow,
    items,
    partyName,
    issuer,
}) {
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const fullW = right - left;
    
    const sidebarWidth = 85;
    doc.rect(left, 20, sidebarWidth, doc.page.height - 80).fill("#1a237e");
    
    doc.save();
    doc.translate(left + 22, 250);
    doc.rotate(-90);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(13)
        .text("PURCHASE", 0, 0);
    doc.restore();
    
    const mainLeft = left + sidebarWidth + 25;
    const mainW = fullW - sidebarWidth - 25;
    
    doc.fillColor("#1a237e").font("Helvetica-Bold").fontSize(22)
        .text("PURCHASE ORDER", mainLeft, 35);
    doc.moveTo(mainLeft, 65).lineTo(mainLeft + mainW, 65).lineWidth(2).stroke("#283593");
    
    const metaY = 85;
    const metaWidth = mainW / 3;
    const metaData = [
        { label: "PO NO", value: invoice.invoice_no || "-" },
        { label: "DATE", value: invoice.create_date ? new Date(invoice.create_date).toLocaleDateString("en-IN") : "-" },
        { label: "DUE DATE", value: transactionRow?.transaction_date ? new Date(transactionRow.transaction_date).toLocaleDateString("en-IN") : "-" }
    ];
    
    for (let i = 0; i < metaData.length; i++) {
        const x = mainLeft + (i * metaWidth);
        doc.fillColor("#666666").font("Helvetica-Bold").fontSize(8)
            .text(metaData[i].label, x, metaY);
        doc.fillColor("#000000").font("Helvetica-Bold").fontSize(10)
            .text(metaData[i].value, x, metaY + 16);
    }
    
    let y = 145;
    doc.fillColor("#666666").font("Helvetica-Bold").fontSize(9)
        .text("SUPPLIER", mainLeft, y);
    doc.fillColor("#000000").font("Helvetica-Bold").fontSize(10);
    y += 14;
    doc.text(partyName || "-", mainLeft, y);
    
    doc.fillColor("#666666").font("Helvetica-Bold").fontSize(9)
        .text("SHIP TO", mainLeft + mainW / 2 + 10, 145);
    doc.fillColor("#000000").font("Helvetica").fontSize(9);
    doc.text(issuer?.name || "Business", mainLeft + mainW / 2 + 10, 159);
    if (issuer?.address) {
        doc.text(issuer.address, mainLeft + mainW / 2 + 10, 173, { width: mainW / 2 });
    }
    
    y = 220;
    const colDesc = mainLeft;
    const colAmount = mainLeft + mainW * 0.55;
    const colTax = mainLeft + mainW * 0.72;
    const colTotal = mainLeft + mainW * 0.88;
    
    doc.rect(mainLeft, y, mainW, 30).fill("#283593");
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8);
    doc.text("Item", colDesc + 8, y + 11);
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
    doc.moveTo(totalsX + 15, ty).lineTo(totalsX + totalsWidth - 15, ty).lineWidth(1).stroke("#283593");
    
    ty += 20;
    doc.fillColor("#1a237e").font("Helvetica-Bold").fontSize(12);
    doc.text("TOTAL:", leftLabel, ty);
    doc.text(formatCurrency(invoice.grand_total), rightValue, ty, { align: "right" });
}

// Template 4: Premium Creative Purchase
export function renderPurchasePremiumCreative(doc, t, {
    title,
    billToLabel = "Supplier",
    invoice,
    transactionRow,
    items,
    partyName,
    issuer,
}) {
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const fullW = right - left;
    const accentColor = "#ff6f00";
    
    doc.rect(left, 20, fullW, 85).fill(accentColor);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(26)
        .text("PURCHASE ORDER", left + 25, 45, { width: fullW - 50 });
    
    const metaY = 120;
    const cardWidth = (fullW - 60) / 3;
    const metaData = [
        { label: "PO NUMBER", value: invoice.invoice_no || "-" },
        { label: "ORDER DATE", value: invoice.create_date ? new Date(invoice.create_date).toLocaleDateString("en-IN") : "-" },
        { label: "DELIVERY", value: transactionRow?.transaction_date ? new Date(transactionRow.transaction_date).toLocaleDateString("en-IN") : "-" }
    ];
    
    for (let i = 0; i < metaData.length; i++) {
        const x = left + 15 + (i * (cardWidth + 15));
        doc.roundedRect(x, metaY, cardWidth, 55, 10).fill("#ffffff");
        doc.fillColor("#6c757d").font("Helvetica-Bold").fontSize(8)
            .text(metaData[i].label, x + 15, metaY + 12);
        doc.fillColor(accentColor).font("Helvetica-Bold").fontSize(12)
            .text(metaData[i].value, x + 15, metaY + 32);
    }
    
    let y = metaY + 75;
    doc.roundedRect(left + 15, y, fullW - 30, 80, 10).fill(t.soft);
    
    doc.fillColor(accentColor).font("Helvetica-Bold").fontSize(10)
        .text("SUPPLIER", left + 30, y + 12);
    doc.fillColor("#333333").font("Helvetica-Bold").fontSize(10)
        .text(partyName || "-", left + 30, y + 32);
    
    doc.fillColor(accentColor).font("Helvetica-Bold").fontSize(10)
        .text("SHIP TO", left + fullW / 2 + 15, y + 12);
    doc.fillColor("#333333").font("Helvetica-Bold").fontSize(10)
        .text(issuer?.name || "Business", left + fullW / 2 + 15, y + 32);
    
    y += 100;
    const colDesc = left + 20;
    const colAmount = left + fullW * 0.55;
    const colTax = left + fullW * 0.72;
    const colTotal = left + fullW * 0.88;
    
    doc.roundedRect(left + 15, y, fullW - 30, 35, 8).fill(accentColor);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9);
    doc.text("Item", colDesc + 8, y + 13);
    doc.text("Amount", colAmount, y + 13, { width: 80, align: "right" });
    doc.text("Tax", colTax, y + 13, { width: 70, align: "right" });
    doc.text("Total", colTotal, y + 13, { width: 80, align: "right" });
    
    y += 35;
    
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const bgColor = i % 2 === 0 ? "#ffffff" : "#fff8e1";
        doc.rect(left + 15, y, fullW - 30, 28).fill(bgColor);
        
        doc.fillColor("#333333").font("Helvetica").fontSize(9);
        doc.text(it.service_name || "Item", colDesc + 8, y + 9);
        doc.text(formatCurrency(it.fees), colAmount, y + 9, { width: 80, align: "right" });
        doc.text(formatCurrency(it.tax_value), colTax, y + 9, { width: 70, align: "right" });
        doc.text(formatCurrency(it.total), colTotal, y + 9, { width: 80, align: "right" });
        y += 28;
    }
    
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
    doc.text("TOTAL:", totalsX + labelOffset, ty);
    doc.text(formatCurrency(invoice.grand_total), totalsX + valueOffset, ty, { align: "right" });
}

// Template 5: Premium Luxury Purchase
export function renderPurchasePremiumLuxury(doc, t, {
    title,
    billToLabel = "Supplier",
    invoice,
    transactionRow,
    items,
    partyName,
    issuer,
}) {
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const fullW = right - left;
    
    doc.rect(left, 20, fullW, 95).fill("#1a1a1a");
    doc.rect(left, 20, fullW, 4).fill("#c9a96e");
    
    doc.fillColor("#c9a96e").font("Helvetica-Bold").fontSize(28)
        .text("PURCHASE ORDER", left + 30, 50, { width: fullW - 60 });
    doc.fillColor("#888888").font("Helvetica").fontSize(9)
        .text("Corporate Purchase Document", left + 30, 85);
    
    const metaY = 130;
    const cardWidth = (fullW - 70) / 3;
    const metaData = [
        { label: "PO NUMBER", value: invoice.invoice_no || "-" },
        { label: "ORDER DATE", value: invoice.create_date ? new Date(invoice.create_date).toLocaleDateString("en-IN") : "-" },
        { label: "DUE DATE", value: transactionRow?.transaction_date ? new Date(transactionRow.transaction_date).toLocaleDateString("en-IN") : "-" }
    ];
    
    for (let i = 0; i < metaData.length; i++) {
        const x = left + 20 + (i * (cardWidth + 15));
        doc.roundedRect(x, metaY, cardWidth, 60, 4).fill(t.soft);
        doc.rect(x, metaY, cardWidth, 4).fill("#c9a96e");
        doc.fillColor("#666666").font("Helvetica-Bold").fontSize(8)
            .text(metaData[i].label, x + 15, metaY + 15);
        doc.fillColor("#1a1a1a").font("Helvetica-Bold").fontSize(11)
            .text(metaData[i].value, x + 15, metaY + 38);
    }
    
    let y = metaY + 85;
    const boxWidth = (fullW - 70) / 2;
    
    doc.roundedRect(left + 20, y, boxWidth, 95, 4).stroke("#c9a96e");
    doc.fillColor("#c9a96e").font("Helvetica-Bold").fontSize(9)
        .text("SUPPLIER", left + 35, y + 15);
    doc.fillColor("#333333").font("Helvetica-Bold").fontSize(10)
        .text(partyName || "-", left + 35, y + 35);
    
    doc.roundedRect(left + fullW / 2 + 15, y, boxWidth, 95, 4).stroke("#c9a96e");
    doc.fillColor("#c9a96e").font("Helvetica-Bold").fontSize(9)
        .text("SHIP TO", left + fullW / 2 + 30, y + 15);
    doc.fillColor("#333333").font("Helvetica-Bold").fontSize(10)
        .text(issuer?.name || "Business", left + fullW / 2 + 30, y + 35);
    if (issuer?.address) {
        doc.fillColor("#666666").font("Helvetica").fontSize(8)
            .text(issuer.address, left + fullW / 2 + 30, y + 53, { width: boxWidth - 30 });
    }
    
    y += 120;
    const colDesc = left + 25;
    const colAmount = left + fullW * 0.55;
    const colTax = left + fullW * 0.72;
    const colTotal = left + fullW * 0.88;
    
    doc.rect(left + 20, y, fullW - 40, 32).fill("#1a1a1a");
    doc.fillColor("#c9a96e").font("Helvetica-Bold").fontSize(9);
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
    
    y += 25;
    const totalsWidth = 300;
    const totalsX = right - totalsWidth - 25;
    
    doc.roundedRect(totalsX, y, totalsWidth, 145, 4).fill(t.soft);
    doc.rect(totalsX, y, totalsWidth, 5).fill("#c9a96e");
    
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
    doc.moveTo(totalsX + 20, ty).lineTo(totalsX + totalsWidth - 20, ty).lineWidth(1).stroke("#c9a96e");
    
    ty += 22;
    doc.fillColor("#c9a96e").font("Helvetica-Bold").fontSize(13);
    doc.text("GRAND TOTAL:", labelLeft, ty);
    doc.text(formatCurrency(invoice.grand_total), valueRight, ty, { align: "right" });
}

export const purchasePremiumRenderers = {
    premium_modern: renderPurchasePremiumModern,
    premium_elegant: renderPurchasePremiumElegant,
    premium_corporate: renderPurchasePremiumCorporate,
    premium_creative: renderPurchasePremiumCreative,
    premium_luxury: renderPurchasePremiumLuxury
};