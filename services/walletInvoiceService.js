import pool from "../db.js";
import { buildSimpleInvoicePdfBuffer } from "../helpers/SimpleInvoicePdf.js";
import { uploadBufferToOneSaas } from "./onesaasUploadService.js";

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

    const pdfBuffer = await buildSimpleInvoicePdfBuffer({
        formatKey: "compact",
        title: "Wallet Transaction Receipt",
        pdfSubject: "Wallet Transaction Receipt",
        invoice: {
            invoice_no: tx.transaction_id,
            grand_total: tx.amount,
            create_date: tx.create_date,
        },
        transactionRow: {
            transaction_date: tx.create_date,
            remark: tx.details || "",
        },
        lines: [
            { label: "Transaction ID", value: tx.transaction_id },
            { label: "Type", value: typeLabel },
            { label: "Purpose", value: tx.purpose || "-" },
            { label: "Branch ID", value: branchId },
            { label: "Details", value: tx.details || "-" },
        ],
        issuer,
    });

    const uploaded = await uploadBufferToOneSaas({
        buffer: pdfBuffer,
        filename,
        mimeType: "application/pdf",
    });

    return {
        url: uploaded.url,
        filename,
        transaction_id: tx.transaction_id,
    };
}
