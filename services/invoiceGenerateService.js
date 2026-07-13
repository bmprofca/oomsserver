import fs from "fs/promises";
import path from "path";
import pool from "../db.js";
import { renderHtmlTemplate, htmlToPdfBuffer } from "../helpers/invoiceTemplateEngine.js";
import { buildTemplateData } from "../helpers/invoiceDataBuilder.js";
import { BASE_DOMAIN } from "../helpers/Config.js";

const ALLOWED_GENERATE_TYPES = new Set([
    "sale",
    "purchase",
    "payment",
    "receive",
    "journal",
    "contra",
    "expense",
]);

function normInvoiceType(value) {
    const v = String(value ?? "").trim().toLowerCase();
    // DB sometimes stores "payment receive" — canonicalize to "receive"
    if (v === "payment receive") return "receive";
    return v;
}

function isAllowedGenerateType(value) {
    return ALLOWED_GENERATE_TYPES.has(normInvoiceType(value));
}

function getSimpleDocTitleForInvoiceType(type) {
    const map = {
        sale: "TAX INVOICE",
        purchase: "PURCHASE INVOICE",
        payment: "PAYMENT VOUCHER",
        receive: "RECEIPT",
        journal: "JOURNAL VOUCHER",
        contra: "CONTRA VOUCHER",
        expense: "EXPENSE VOUCHER",
    };
    return map[normInvoiceType(type)] || "VOUCHER";
}

function downloadFilenameForInvoice(invoice) {
    const safeNo = String(invoice.invoice_no || invoice.invoice_id || "inv").replace(/[^\w.-]+/g, "_");
    return `invoice_${safeNo}.pdf`;
}

async function isBranchStaffOrAdmin(username, branch_id) {
    try {
        const [rows] = await pool.query(
            `SELECT id FROM branch_mapping WHERE username = ? AND branch_id = ? AND type IN ('admin','staff') AND is_accepted = '1' AND status = '1' AND (is_deleted = '0' OR is_deleted = 0) LIMIT 1`,
            [username, branch_id]
        );
        return rows.length > 0;
    } catch {
        const [rows] = await pool.query(
            `SELECT id FROM branch_mapping WHERE username = ? AND branch_id = ? AND type IN ('admin','staff') LIMIT 1`,
            [username, branch_id]
        );
        return rows.length > 0;
    }
}

async function profileDisplayName(username) {
    if (!username) return null;
    const [rows] = await pool.query(
        `SELECT name, username FROM profile WHERE username = ? LIMIT 1`,
        [username]
    );
    if (!rows.length) return username;
    return rows[0].name || rows[0].username || username;
}

async function formatPartyLine(partyType, partyId) {
    if (!partyId || String(partyId).trim() === "") return null;
    const pid = String(partyId).trim();
    const pt = partyType != null ? String(partyType).trim() : "";
    if (pt === "client" || pt === "ca" || pt === "agent") {
        const name = await profileDisplayName(pid);
        return { label: pt.charAt(0).toUpperCase() + pt.slice(1), value: name || pid };
    }
    return { label: pt || "Party", value: pid };
}

function viewerMayAccessInvoice({ caller, staff, invoiceType, tx }) {
    if (staff) return true;
    const p1 = tx.party1_id != null ? String(tx.party1_id).trim() : "";
    const p2 = tx.party2_id != null ? String(tx.party2_id).trim() : "";
    if (invoiceType === "sale") return caller === p2;
    if (invoiceType === "purchase") return caller === p1;
    if (invoiceType === "expense") return caller === p1;
    return caller === p1 || caller === p2;
}

async function getBranchInvoiceProfile(branch_id) {
    const [rows] = await pool.query(
        `SELECT
            bl.name AS branch_name,
            bl.invoice_address,
            bl.mobile_1,
            bl.mobile_2,
            bl.email_1,
            bl.email_2,
            bl.address_line_1,
            bl.address_line_2,
            bl.city,
            bl.state,
            bl.country,
            bl.pincode
         FROM branch_list bl
         WHERE bl.branch_id = ?
         ORDER BY bl.id ASC
         LIMIT 1`,
        [branch_id]
    );
    const row = rows[0] || {};
    const compactAddress = [
        row.address_line_1,
        row.address_line_2,
        row.city,
        row.state,
        row.country,
        row.pincode,
    ]
        .filter((x) => x != null && String(x).trim() !== "")
        .join(", ");

    return {
        name: row.branch_name || "Business",
        phone: [row.mobile_1, row.mobile_2].filter((x) => x != null && String(x).trim() !== "").join(" / "),
        email: [row.email_1, row.email_2].filter((x) => x != null && String(x).trim() !== "").join(" / "),
        address: row.invoice_address || compactAddress || "",
    };
}

function mapFormatKeyToTemplateName(key) {
    return String(key || "classic").trim().toLowerCase();
}

async function getActiveFormatKeyForInvoiceType(branch_id, invoiceType) {
    const map = {
        sale: "sale",
        purchase: "purchase",
        payment: "payment",
        receive: "receive",
        "payment receive": "receive",
        journal: "journal",
        contra: "contra",
        expense: "expense",
    };
    const col = map[String(invoiceType).trim().toLowerCase()];
    if (!col) return "classic";
    try {
        const [rows] = await pool.query(
            `SELECT \`${col}\` FROM \`invoice_formats\` WHERE \`branch_id\` = ? LIMIT 1`,
            [branch_id]
        );
        if (rows.length > 0 && rows[0][col]) {
            return rows[0][col];
        }
    } catch {}
    return "classic";
}

async function buildInvoicePdfBuffer(branch_id, caller, invoice_id, requestedType) {
    const invId = String(invoice_id).trim();

    const [invRows] = await pool.query(
        `SELECT * FROM invoice WHERE invoice_id = ? AND branch_id = ? LIMIT 1`,
        [invId, branch_id]
    );
    if (!invRows.length) {
        return { error: { status: 404, message: "Invoice not found in this branch" } };
    }
    const invoice = invRows[0];
    const invoiceType = normInvoiceType(invoice.type);
    const reqType = normInvoiceType(requestedType);

    if (invoiceType !== reqType) {
        return {
            error: {
                status: 400,
                message: "type does not match this invoice (check invoice_id and type)",
            },
        };
    }

    const [txRows] = await pool.query(
        `SELECT * FROM transactions WHERE transaction_id = ? AND branch_id = ? LIMIT 1`,
        [invoice.transaction_id, branch_id]
    );
    if (!txRows.length) {
        return { error: { status: 404, message: "Linked transaction not found" } };
    }
    const tx = txRows[0];

    const staff = await isBranchStaffOrAdmin(caller, branch_id);
    if (!viewerMayAccessInvoice({ caller, staff, invoiceType, tx })) {
        return { error: { status: 403, message: "You do not have access to this invoice" } };
    }

    const issuer = await getBranchInvoiceProfile(branch_id);
    const filename = downloadFilenameForInvoice(invoice);

    let items = [];
    let partyName = "-";
    let lines = [];

    if (invoiceType === "sale" || invoiceType === "purchase") {
        const [itemRows] = await pool.query(
            `SELECT si.*, s.name AS service_name
             FROM sale_items si
             LEFT JOIN services s ON s.service_id = si.service_id
             WHERE si.invoice_id = ?
             ORDER BY si.id ASC`,
            [invId]
        );
        items = itemRows;

        const counterpartyId = invoiceType === "sale" ? tx.party2_id : tx.party1_id;
        if (counterpartyId) {
            partyName = (await profileDisplayName(String(counterpartyId))) || String(counterpartyId);
        }
    } else {
        const a = await formatPartyLine(tx.party1_type, tx.party1_id);
        const b = await formatPartyLine(tx.party2_type, tx.party2_id);
        if (a) lines.push(a);
        if (b) lines.push(b);
    }

    const rawFormatKey = await getActiveFormatKeyForInvoiceType(branch_id, invoiceType);
    const activeTemplate = mapFormatKeyToTemplateName(rawFormatKey);

    const templateData = buildTemplateData({
        type: invoiceType,
        invoice,
        transactionRow: tx,
        items,
        partyName,
        issuer,
        lines,
    });

    const html = await renderHtmlTemplate(invoiceType, activeTemplate, templateData);
    const buffer = await htmlToPdfBuffer(html);

    // Save the file on the server in media/format/<invoice_type>/<filename>.pdf
    const typeFolder = path.join(process.cwd(), "media", "format", invoiceType);
    await fs.mkdir(typeFolder, { recursive: true });
    
    const safeNo = String(invoice.invoice_no || invoice.invoice_id || "inv").replace(/[^\w.-]+/g, "_");
    const saveFilename = `${safeNo}.pdf`;
    const filePath = path.join(typeFolder, saveFilename);
    await fs.writeFile(filePath, buffer);

    const localUrl = `${BASE_DOMAIN}/media/format/${invoiceType}/${saveFilename}`;

    return { 
        buffer, 
        filename: saveFilename, 
        formatKey: rawFormatKey, 
        type: invoiceType, 
        invoice_id: invId,
        url: localUrl
    };
}

async function saveInvoicePdfLink(built) {
    return {
        url: built.url,
        filename: built.filename,
        suggested_filename: built.filename,
    };
}

export {
    ALLOWED_GENERATE_TYPES,
    buildInvoicePdfBuffer,
    isAllowedGenerateType,
    isBranchStaffOrAdmin,
    normInvoiceType,
    saveInvoicePdfLink,
};
