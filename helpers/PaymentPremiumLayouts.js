// PaymentPremiumLayouts.js

import PDFDocument from "pdfkit";

function money(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "Rs. 0.00";
    return `Rs. ${x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

function formatCurrency(value) {
    return money(value);
}

// Premium Modern Payment Template
export function renderPaymentPremiumModern(doc, t, {
    title,
    invoice,
    transactionRow,
    lines = [],
    issuer,
}) {
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const fullW = right - left;
    
    // Header
    doc.rect(left, 20, fullW, 85).fill("#2e7d32");
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(28)
        .text("PAYMENT VOUCHER", left + 25, 45, { width: fullW - 50 });
    doc.font("Helvetica").fontSize(10).fillColor("#e0e0e0")
        .text("Payment Confirmation Slip", left + 25, 80);
    
    // Metadata Cards
    const metaY = 120;
    const cardWidth = (fullW - 60) / 2;
    
    doc.roundedRect(left + 15, metaY, cardWidth, 55, 8).fill("#f8f9fa");
    doc.fillColor("#6c757d").font("Helvetica-Bold").fontSize(8)
        .text("VOUCHER NUMBER", left + 27, metaY + 12);
    doc.fillColor("#2e7d32").font("Helvetica-Bold").fontSize(12)
        .text(String(invoice.invoice_no || "-"), left + 27, metaY + 32);
    
    doc.roundedRect(left + cardWidth + 25, metaY, cardWidth, 55, 8).fill("#f8f9fa");
    doc.fillColor("#6c757d").font("Helvetica-Bold").fontSize(8)
        .text("PAYMENT DATE", left + cardWidth + 37, metaY + 12);
    doc.fillColor("#2e7d32").font("Helvetica-Bold").fontSize(12)
        .text(invoice.create_date ? new Date(invoice.create_date).toLocaleDateString("en-IN") : "-", left + cardWidth + 37, metaY + 32);
    
    // Party Information
    let y = metaY + 75;
    doc.roundedRect(left + 15, y, fullW - 30, 100, 8).fill(t.soft);
    
    let lineY = y + 15;
    for (let i = 0; i < lines.length; i++) {
        const row = lines[i];
        if (!row?.label) continue;
        doc.fillColor("#555555").font("Helvetica-Bold").fontSize(10)
            .text(`${row.label}:`, left + 30, lineY);
        doc.fillColor("#333333").font("Helvetica").fontSize(10)
            .text(row.value || "-", left + 150, lineY);
        lineY += 25;
    }
    
    // Payment Amount Section
    y += 120;
    const totalsWidth = 350;
    const totalsX = right - totalsWidth - 15;
    
    doc.roundedRect(totalsX, y, totalsWidth, 80, 8).fill("#e8f5e9");
    doc.rect(totalsX, y, totalsWidth, 4).fill("#2e7d32");
    
    doc.fillColor("#2e7d32").font("Helvetica-Bold").fontSize(13)
        .text("PAYMENT AMOUNT:", totalsX + 20, y + 25);
    doc.fillColor("#2e7d32").font("Helvetica-Bold").fontSize(18)
        .text(formatCurrency(invoice.grand_total), totalsX + totalsWidth - 25, y + 25, { align: "right" });
    
    // Remarks
    if (transactionRow?.remark) {
        y += 105;
        doc.roundedRect(left + 15, y, fullW - 30, 45, 6).fill("#fff8e1");
        doc.fillColor("#e65100").font("Helvetica-Bold").fontSize(8)
            .text("REMARKS", left + 30, y + 12);
        doc.fillColor("#555555").font("Helvetica").fontSize(9)
            .text(String(transactionRow.remark), left + 30, y + 28, { width: fullW - 70 });
    }
}

export const paymentPremiumRenderers = {
    premium_modern: renderPaymentPremiumModern,
};