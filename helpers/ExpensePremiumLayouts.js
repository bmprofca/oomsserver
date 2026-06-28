// ExpensePremiumLayouts.js

import PDFDocument from "pdfkit";

function money(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "Rs. 0.00";
    return `Rs. ${x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

function formatCurrency(value) {
    return money(value);
}

// Premium Modern Expense Template
export function renderExpensePremiumModern(doc, t, {
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
    doc.rect(left, 20, fullW, 85).fill("#c62828");
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(28)
        .text("EXPENSE VOUCHER", left + 25, 45, { width: fullW - 50 });
    doc.font("Helvetica").fontSize(10).fillColor("#e0e0e0")
        .text("Expense Claim", left + 25, 80);
    
    // Metadata Cards (3 columns)
    const metaY = 120;
    const cardWidth = (fullW - 60) / 3;
    
    const metaData = [
        { label: "EXPENSE NUMBER", value: invoice.invoice_no || "-" },
        { label: "EXPENSE DATE", value: invoice.create_date ? new Date(invoice.create_date).toLocaleDateString("en-IN") : "-" },
        { label: "PAYMENT DATE", value: transactionRow?.transaction_date ? new Date(transactionRow.transaction_date).toLocaleDateString("en-IN") : "-" }
    ];
    
    for (let i = 0; i < metaData.length; i++) {
        const x = left + 15 + (i * (cardWidth + 15));
        doc.roundedRect(x, metaY, cardWidth, 55, 8).fill("#f8f9fa");
        doc.fillColor("#6c757d").font("Helvetica-Bold").fontSize(8)
            .text(metaData[i].label, x + 12, metaY + 12);
        doc.fillColor("#c62828").font("Helvetica-Bold").fontSize(12)
            .text(metaData[i].value, x + 12, metaY + 32);
    }
    
    // Expense Details
    let y = metaY + 75;
    doc.roundedRect(left + 15, y, fullW - 30, 100, 8).fill(t.soft);
    
    let lineY = y + 15;
    for (let i = 0; i < lines.length; i++) {
        const row = lines[i];
        if (!row?.label) continue;
        doc.fillColor("#555555").font("Helvetica-Bold").fontSize(10)
            .text(row.label + ":", left + 30, lineY);
        doc.fillColor("#333333").font("Helvetica").fontSize(10)
            .text(row.value || "-", left + 150, lineY);
        lineY += 25;
    }
    
    // Expense Amount Section
    y += 120;
    const totalsWidth = 350;
    const totalsX = right - totalsWidth - 15;
    
    doc.roundedRect(totalsX, y, totalsWidth, 80, 8).fill("#ffebee");
    doc.rect(totalsX, y, totalsWidth, 4).fill("#c62828");
    
    doc.fillColor("#c62828").font("Helvetica-Bold").fontSize(13)
        .text("EXPENSE AMOUNT:", totalsX + 20, y + 25);
    doc.fillColor("#c62828").font("Helvetica-Bold").fontSize(18)
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

export const expensePremiumRenderers = {
    premium_modern: renderExpensePremiumModern,
};