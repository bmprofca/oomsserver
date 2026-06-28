// JournalPremiumLayouts.js

import PDFDocument from "pdfkit";

function money(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "Rs. 0.00";
    return `Rs. ${x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

function formatCurrency(value) {
    return money(value);
}

// Premium Modern Journal Template
export function renderJournalPremiumModern(doc, t, {
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
    doc.rect(left, 20, fullW, 85).fill("#6a1b9a");
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(28)
        .text("JOURNAL VOUCHER", left + 25, 45, { width: fullW - 50 });
    doc.font("Helvetica").fontSize(10).fillColor("#e0e0e0")
        .text("Journal Entry", left + 25, 80);
    
    // Metadata Cards (3 columns)
    const metaY = 120;
    const cardWidth = (fullW - 60) / 3;
    
    const metaData = [
        { label: "JOURNAL NUMBER", value: invoice.invoice_no || "-" },
        { label: "ENTRY DATE", value: invoice.create_date ? new Date(invoice.create_date).toLocaleDateString("en-IN") : "-" },
        { label: "POSTING DATE", value: transactionRow?.transaction_date ? new Date(transactionRow.transaction_date).toLocaleDateString("en-IN") : "-" }
    ];
    
    for (let i = 0; i < metaData.length; i++) {
        const x = left + 15 + (i * (cardWidth + 15));
        doc.roundedRect(x, metaY, cardWidth, 55, 8).fill("#f8f9fa");
        doc.fillColor("#6c757d").font("Helvetica-Bold").fontSize(8)
            .text(metaData[i].label, x + 12, metaY + 12);
        doc.fillColor("#6a1b9a").font("Helvetica-Bold").fontSize(12)
            .text(metaData[i].value, x + 12, metaY + 32);
    }
    
    // Journal Entries Table
    let y = metaY + 75;
    doc.roundedRect(left + 15, y, fullW - 30, 120, 8).fill(t.soft);
    
    doc.fillColor("#6a1b9a").font("Helvetica-Bold").fontSize(10)
        .text("ACCOUNT NAME", left + 30, y + 15);
    doc.fillColor("#6a1b9a").font("Helvetica-Bold").fontSize(10)
        .text("DEBIT (Rs.)", left + fullW * 0.55, y + 15, { width: 100, align: "right" });
    doc.fillColor("#6a1b9a").font("Helvetica-Bold").fontSize(10)
        .text("CREDIT (Rs.)", left + fullW * 0.75, y + 15, { width: 100, align: "right" });
    
    y += 8;
    doc.moveTo(left + 25, y).lineTo(right - 25, y).lineWidth(0.5).stroke();
    y += 15;
    
    let lineY = y;
    const debitAmount = invoice.grand_total;
    const creditAmount = invoice.grand_total;
    
    for (let i = 0; i < lines.length; i++) {
        const row = lines[i];
        if (!row?.label) continue;
        
        if (i % 2 === 0) {
            doc.rect(left + 15, lineY - 5, fullW - 30, 28).fill("#f3e5f5");
        }
        
        doc.fillColor("#333333").font("Helvetica").fontSize(9)
            .text(row.label, left + 30, lineY);
        
        // Alternate debit and credit
        if (i === 0) {
            doc.text(formatCurrency(debitAmount), left + fullW * 0.55, lineY, { width: 100, align: "right" });
        } else if (i === 1) {
            doc.text(formatCurrency(creditAmount), left + fullW * 0.75, lineY, { width: 100, align: "right" });
        }
        
        lineY += 28;
    }
    
    // Total Section
    y = lineY + 20;
    const totalsWidth = 350;
    const totalsX = right - totalsWidth - 15;
    
    doc.roundedRect(totalsX, y, totalsWidth, 80, 8).fill("#f3e5f5");
    doc.rect(totalsX, y, totalsWidth, 4).fill("#6a1b9a");
    
    doc.fillColor("#6a1b9a").font("Helvetica-Bold").fontSize(13)
        .text("JOURNAL AMOUNT:", totalsX + 20, y + 25);
    doc.fillColor("#6a1b9a").font("Helvetica-Bold").fontSize(18)
        .text(formatCurrency(invoice.grand_total), totalsX + totalsWidth - 25, y + 25, { align: "right" });
    
    // Narration
    if (transactionRow?.remark) {
        y += 105;
        doc.roundedRect(left + 15, y, fullW - 30, 45, 6).fill("#fff8e1");
        doc.fillColor("#e65100").font("Helvetica-Bold").fontSize(8)
            .text("NARRATION", left + 30, y + 12);
        doc.fillColor("#555555").font("Helvetica").fontSize(9)
            .text(String(transactionRow.remark), left + 30, y + 28, { width: fullW - 70 });
    }
}

export const journalPremiumRenderers = {
    premium_modern: renderJournalPremiumModern,
};