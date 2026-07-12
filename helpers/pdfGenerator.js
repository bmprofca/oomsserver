import PDFDocument from 'pdfkit';

/**
 * Builds a modern, clean PDF for any invoice type.
 */
export async function buildUnifiedInvoicePdfBuffer({
    title,
    pdfSubject,
    invoice,
    transactionRow,
    items = [],
    partyName,
    issuer,
    lines = [] // simple lines if not items
}) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({
                size: 'A4',
                margin: 50,
                info: {
                    Title: title,
                    Subject: pdfSubject,
                }
            });

            const buffers = [];
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => resolve(Buffer.concat(buffers)));
            doc.on('error', reject);

            generateHeader(doc, issuer, title);
            generateCustomerInformation(doc, invoice, partyName, lines);
            
            if (items && items.length > 0) {
                generateInvoiceTable(doc, items, invoice);
            } else {
                generateSimpleLines(doc, lines, invoice);
            }

            generateFooter(doc);
            doc.end();
        } catch (error) {
            reject(error);
        }
    });
}

function generateHeader(doc, issuer, title) {
    doc.fillColor('#444444')
       .fontSize(20)
       .text(issuer.name || "Company", 50, 57)
       .fontSize(10)
       .text(issuer.address || "", 50, 80, { width: 200 })
       .text(`Phone: ${issuer.phone || ""}`, 50, 105)
       .text(`Email: ${issuer.email || ""}`, 50, 120)
       .fontSize(26)
       .fillColor('#2c3e50')
       .text(title, 350, 50, { align: 'right' })
       .moveDown();
       
    doc.strokeColor('#aaaaaa')
       .lineWidth(1)
       .moveTo(50, 140)
       .lineTo(550, 140)
       .stroke();
}

function generateCustomerInformation(doc, invoice, partyName, lines) {
    doc.fillColor('#333333')
       .fontSize(12)
       .text('Invoice Details', 50, 160, { underline: true });

    const invoiceDate = invoice.created_at ? new Date(invoice.created_at).toLocaleDateString() : 'N/A';
    
    doc.fontSize(10)
       .text(`Invoice Number:`, 50, 180)
       .font('Helvetica-Bold')
       .text(invoice.invoice_no || invoice.invoice_id || '-', 150, 180)
       .font('Helvetica')
       .text(`Invoice Date:`, 50, 195)
       .text(invoiceDate, 150, 195)
       .text(`Amount:`, 50, 210)
       .text(`$${Number(invoice.amount || 0).toFixed(2)}`, 150, 210);

    if (partyName || lines.length > 0) {
        doc.fontSize(12)
           .text('Billed To', 300, 160, { underline: true });
           
        let currentY = 180;
        if (partyName) {
            doc.font('Helvetica-Bold').fontSize(11).text(partyName, 300, currentY);
            currentY += 15;
        }
        
        doc.font('Helvetica').fontSize(10);
        lines.forEach(line => {
            if (line.label && line.value) {
                doc.text(`${line.label}: ${line.value}`, 300, currentY);
                currentY += 15;
            }
        });
    }

    doc.strokeColor('#aaaaaa')
       .lineWidth(1)
       .moveTo(50, 240)
       .lineTo(550, 240)
       .stroke();
}

function generateInvoiceTable(doc, items, invoice) {
    let i;
    const invoiceTableTop = 270;
    
    doc.font('Helvetica-Bold');
    generateTableRow(
        doc,
        invoiceTableTop,
        "Item",
        "Description",
        "Unit Cost",
        "Quantity",
        "Line Total"
    );
    generateHr(doc, invoiceTableTop + 20);
    doc.font('Helvetica');

    let position = invoiceTableTop + 30;
    
    for (i = 0; i < items.length; i++) {
        const item = items[i];
        const name = item.service_name || "Item";
        const desc = item.description || "";
        const rate = Number(item.rate || 0);
        const qty = Number(item.quantity || 1);
        const amount = rate * qty;
        
        generateTableRow(
            doc,
            position,
            name,
            desc,
            `$${rate.toFixed(2)}`,
            qty,
            `$${amount.toFixed(2)}`
        );

        generateHr(doc, position + 20);
        position += 30;
    }

    const subtotalPosition = position + 10;
    doc.font('Helvetica-Bold');
    generateTableRow(doc, subtotalPosition, "", "", "", "Total:", `$${Number(invoice.amount || 0).toFixed(2)}`);
    doc.font('Helvetica');
}

function generateSimpleLines(doc, lines, invoice) {
    const startY = 270;
    doc.font('Helvetica-Bold').fontSize(12).text('Description', 50, startY);
    generateHr(doc, startY + 15);
    
    doc.font('Helvetica').fontSize(11)
       .text(`Invoice Amount: $${Number(invoice.amount || 0).toFixed(2)}`, 50, startY + 30);
       
    if (invoice.remark) {
        doc.text(`Remarks: ${invoice.remark}`, 50, startY + 50);
    }
}

function generateFooter(doc) {
    doc.fontSize(10)
       .fillColor('#aaaaaa')
       .text(
           'Payment is due within 15 days. Thank you for your business.',
           50,
           750,
           { align: 'center', width: 500 }
       );
}

function generateTableRow(doc, y, item, description, unitCost, quantity, lineTotal) {
    doc.fontSize(10)
       .text(item, 50, y, { width: 90 })
       .text(description, 150, y, { width: 190 })
       .text(unitCost, 350, y, { width: 70, align: 'right' })
       .text(quantity, 420, y, { width: 50, align: 'right' })
       .text(lineTotal, 480, y, { width: 70, align: 'right' });
}

function generateHr(doc, y) {
    doc.strokeColor('#dddddd')
       .lineWidth(1)
       .moveTo(50, y)
       .lineTo(550, y)
       .stroke();
}
