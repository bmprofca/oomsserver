import { fmtDate } from "./pdfHelpers.js";

function getCompanyInitials(name) {
    if (!name) return "C";
    return name
        .split(" ")
        .map((w) => w[0])
        .join("")
        .toUpperCase()
        .slice(0, 3);
}

export function buildTemplateData({ type, invoice, transactionRow, items, partyName, issuer, lines }) {
    const invoiceType = String(type).trim().toLowerCase();
    
    // Determine labels
    let billToLabel = "Bill To";
    let party2Label = "";
    let showParties = false;
    let isSimple = false;
    let hasItems = false;
    
    if (invoiceType === "sale") {
        billToLabel = "Bill To";
        showParties = true;
        hasItems = true;
    } else if (invoiceType === "purchase") {
        billToLabel = "Supplier";
        showParties = true;
        hasItems = true;
    } else if (invoiceType === "payment") {
        billToLabel = "Paid To";
        showParties = true;
        isSimple = true;
    } else if (invoiceType === "receive") {
        billToLabel = "Received From";
        showParties = true;
        isSimple = true;
    } else if (invoiceType === "journal") {
        billToLabel = "Debit Party";
        party2Label = "Credit Party";
        showParties = true;
        isSimple = true;
    } else if (invoiceType === "contra") {
        billToLabel = "From Account";
        party2Label = "To Account";
        showParties = true;
        isSimple = true;
    } else if (invoiceType === "expense") {
        billToLabel = "Paid To";
        showParties = true;
        isSimple = true;
    }

    const typeLabels = {
        sale: "TAX INVOICE",
        purchase: "PURCHASE INVOICE",
        payment: "PAYMENT VOUCHER",
        receive: "RECEIPT",
        journal: "JOURNAL VOUCHER",
        contra: "CONTRA VOUCHER",
        expense: "EXPENSE VOUCHER",
    };

    const typeLabel = typeLabels[invoiceType] || "INVOICE";

    // Build item rows HTML if applicable
    let items_rows = "";
    let subtotal = 0;
    if (hasItems && items && items.length > 0) {
        items.forEach((item, index) => {
            const rate = Number(item.fees || item.rate || 0);
            const qty = Number(item.quantity || 1);
            const amt = rate * qty;
            subtotal += amt;
            items_rows += `
              <tr>
                <td>${index + 1}</td>
                <td>
                  <div class="item-name">${item.service_name || "Item / Service"}</div>
                </td>
                <td><div class="item-desc">${item.description || "-"}</div></td>
                <td>Rs. ${rate.toFixed(2)}</td>
                <td>${qty}</td>
                <td>Rs. ${amt.toFixed(2)}</td>
              </tr>
            `;
        });
    }

    const amountNum = Number(invoice.amount || 0);
    const taxNum = Number(invoice.tax_amount || 0);
    const finalSubtotal = subtotal || (amountNum - taxNum);

    // Format amounts
    const formatMoney = (val) => {
        const x = Number(val);
        if (isNaN(x)) return "Rs. 0.00";
        return `Rs. ${x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
    };

    // Parties detail
    let partyDetail = "";
    if (transactionRow) {
        const pDetails = [];
        if (transactionRow.payment_method) pDetails.push(`Method: ${transactionRow.payment_method}`);
        if (transactionRow.reference_no) pDetails.push(`Ref: ${transactionRow.reference_no}`);
        partyDetail = pDetails.join(" | ");
    }

    // Party 2 (if journal/contra)
    let party2Name = "";
    let party2Detail = "";
    if (lines && lines.length > 1) {
        const p1 = lines[0];
        const p2 = lines[1];
        billToLabel = p1.label || billToLabel;
        partyName = p1.value || partyName;
        
        party2Label = p2.label || party2Label;
        party2Name = p2.value;
    } else if (lines && lines.length === 1) {
        const p1 = lines[0];
        billToLabel = p1.label || billToLabel;
        partyName = p1.value || partyName;
    }

    return {
        type_label: typeLabel,
        company_name: issuer.name || "Business",
        company_address: issuer.address || "",
        company_phone: issuer.phone || "",
        company_email: issuer.email || "",
        company_initials: getCompanyInitials(issuer.name),
        invoice_no: invoice.invoice_no || invoice.invoice_id || "-",
        invoice_date: fmtDate(invoice.created_at || invoice.date),
        due_date: invoice.due_date ? fmtDate(invoice.due_date) : null,
        amount: formatMoney(amountNum),
        tax_amount: taxNum ? formatMoney(taxNum) : null,
        subtotal: formatMoney(finalSubtotal),
        show_parties: showParties,
        bill_to_label: billToLabel,
        party_name: partyName || "-",
        party_detail: partyDetail,
        party2_label: party2Label,
        party2_name: party2Name,
        party2_detail: party2Detail,
        has_items: hasItems,
        items_rows: items_rows,
        is_simple: isSimple,
        remark: invoice.remark || invoice.remarks || transactionRow?.remark || null,
        generated_date: fmtDate(new Date()),
    };
}
