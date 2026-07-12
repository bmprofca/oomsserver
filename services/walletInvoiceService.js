import fs from "fs/promises";
import path from "path";
import pool from "../db.js";
import { renderHtmlTemplate, htmlToPdfBuffer } from "../helpers/invoiceTemplateEngine.js";
import { buildTemplateData } from "../helpers/invoiceDataBuilder.js";
import { BASE_DOMAIN } from "../helpers/Config.js";

async function getBranchIssuer(branchId) {
    const [rows] = await pool.query(
        `SELECT name, mobile_1, email_1, address_line_1, address_line_2, city, state, pincode
         FROM branch_list
         WHERE branch_id = ?
         LIMIT 1`,
        [branchId]
    );

    const branch = rows[0];
    if (!branch) {
        return {
            name: "OOMS CRM",
            phone: "",
            email: "",
            address: "",
        };
    }

    const address = [
        branch.address_line_1,
        branch.address_line_2,
        branch.city,
        branch.state,
        branch.pincode,
    ]
        .filter(Boolean)
        .join(", ");

    return {
        name: branch.name || "OOMS CRM",
        phone: branch.mobile_1 || "",
        email: branch.email_1 || "",
        address,
    };
}

export async function generateWalletTransactionInvoice({ branchId, transactionId }) {
    const [rows] = await pool.query(
        `SELECT transaction_id, branch_id, amount, type, purpose, details, create_date
         FROM wallet_transactions
         WHERE transaction_id = ? AND branch_id = ?
         LIMIT 1`,
        [transactionId, branchId]
    );

    const tx = rows[0];
    if (!tx) {
        const error = new Error("Wallet transaction not found");
        error.statusCode = 404;
        throw error;
    }

    const issuer = await getBranchIssuer(branchId);
    const typeLabel = tx.type === "credit" ? "Credit" : "Debit";
    const safeId = String(tx.transaction_id).replace(/[^\w.-]+/g, "_");
    const filename = `wallet-invoice-${safeId}.pdf`;

    // Prepare standard invoice fields for templateData
    const invoiceData = {
        invoice_id: tx.transaction_id,
        invoice_no: tx.transaction_id,
        created_at: tx.create_date,
        amount: tx.amount,
        tax_amount: 0,
        remark: tx.details || ""
    };

    const txRow = {
        payment_method: null,
        reference_no: null
    };

    const lines = [
        { label: "Transaction ID", value: tx.transaction_id },
        { label: "Type", value: typeLabel },
        { label: "Purpose", value: tx.purpose || "-" },
        { label: "Branch ID", value: branchId },
        { label: "Details", value: tx.details || "-" },
    ];

    const templateData = buildTemplateData({
        type: "payment", // Map to payment layout (voucher layout)
        invoice: invoiceData,
        transactionRow: txRow,
        items: [],
        partyName: typeLabel === "Credit" ? "Wallet Credit" : "Wallet Debit",
        issuer,
        lines,
    });

    // Customise labels
    templateData.type_label = "WALLET TRANSACTION RECEIPT";

    const html = await renderHtmlTemplate("payment", "classic", templateData);
    const pdfBuffer = await htmlToPdfBuffer(html);

    // Save to media/wallet/
    const walletFolder = path.join(process.cwd(), "media", "wallet");
    await fs.mkdir(walletFolder, { recursive: true });
    const filePath = path.join(walletFolder, filename);
    await fs.writeFile(filePath, pdfBuffer);

    const localUrl = `${BASE_DOMAIN}/media/wallet/${filename}`;

    return {
        url: localUrl,
        filename,
        transaction_id: tx.transaction_id,
    };
}
