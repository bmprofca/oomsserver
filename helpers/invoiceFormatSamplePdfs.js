import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
    FORMAT_VARIANT_IDS,
    INVOICE_FORMAT_COLUMNS,
    getFormatSampleDirKeyFromApiType,
} from "./invoiceFormats.js";
import { buildSaleInvoicePdfBuffer } from "./SaleInvoicePdf.js";
import { buildSimpleInvoicePdfBuffer } from "./SimpleInvoicePdf.js";
import { SIMPLE_SAMPLE_TITLE_BY_FORMAT_COLUMN } from "./invoiceSimpleDocTitles.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_FORMAT_ROOT = path.join(__dirname, "..", "media", "format");

/** Sale/purchase demo rows (line-item PDFs). */
const SAMPLE_INVOICE = {
    invoice_id: "format-sample",
    invoice_no: "SAMPLE-001",
    create_date: new Date("2026-01-15T12:00:00.000Z"),
    subtotal: 10000,
    tax_rate: 18,
    tax_value: 1800,
    additional_charge: 250,
    grand_total: 12050,
};

const SAMPLE_TRANSACTION = {
    transaction_date: new Date("2026-01-15T12:00:00.000Z"),
    remark: "This is a sample document for previewing invoice layout only.",
};

const SAMPLE_ITEMS = [
    {
        service_name: "Professional services (sample)",
        fees: 6000,
        tax_value: 1080,
        total: 7080,
    },
    {
        service_name: "Consulting — quarterly (sample)",
        fees: 4000,
        tax_value: 720,
        total: 4720,
    },
];

const SAMPLE_SIMPLE_INVOICE = {
    invoice_id: "format-sample",
    invoice_no: "SAMPLE-DOC-001",
    create_date: new Date("2026-01-15T12:00:00.000Z"),
    grand_total: 25750.5,
};

/** Demo party lines for simple vouchers (no DB). */
const SAMPLE_LINES_BY_FORMAT_COLUMN = {
    payment: [
        { label: "From", value: "Sample Bank (A/c ···4521)" },
        { label: "To", value: "Sample Vendor Pvt. Ltd." },
    ],
    receive: [
        { label: "From", value: "Sample Client Ltd." },
        { label: "To", value: "Sample Bank / Capital (receiver)" },
    ],
    journal: [
        { label: "Debit (party)", value: "Sample Ledger A" },
        { label: "Credit (party)", value: "Sample Ledger B" },
    ],
    contra: [
        { label: "From", value: "Sample Bank A" },
        { label: "To", value: "Sample Bank B" },
    ],
    expense: [
        { label: "Paid to", value: "Sample Expense Vendor" },
        { label: "Book", value: "Office expenses (sample)" },
    ],
};

function dirForColumnKey(columnKey) {
    return path.join(MEDIA_FORMAT_ROOT, columnKey);
}

function filePathFor(columnKey, formatKey) {
    return path.join(dirForColumnKey(columnKey), `${formatKey}.pdf`);
}

async function writeSalePurchaseVariant(columnKey, formatKey) {
    const isSale = columnKey === "sale";
    const buf = await buildSaleInvoicePdfBuffer({
        formatKey,
        title: isSale ? "TAX INVOICE" : "PURCHASE INVOICE",
        pdfSubject: isSale ? "Sale invoice (sample)" : "Purchase invoice (sample)",
        billToLabel: isSale ? "Bill to" : "Supplier",
        invoice: SAMPLE_INVOICE,
        transactionRow: SAMPLE_TRANSACTION,
        items: SAMPLE_ITEMS,
        partyName: isSale ? "Sample Client Pvt. Ltd." : "Sample Supplier & Co.",
    });
    await fs.mkdir(dirForColumnKey(columnKey), { recursive: true });
    await fs.writeFile(filePathFor(columnKey, formatKey), buf);
}

async function writeSimpleVariant(columnKey, formatKey) {
    const title = SIMPLE_SAMPLE_TITLE_BY_FORMAT_COLUMN[columnKey];
    const lines = SAMPLE_LINES_BY_FORMAT_COLUMN[columnKey] || [];
    const buf = await buildSimpleInvoicePdfBuffer({
        formatKey,
        title,
        pdfSubject: `${title} (sample)`,
        invoice: SAMPLE_SIMPLE_INVOICE,
        transactionRow: SAMPLE_TRANSACTION,
        lines,
    });
    await fs.mkdir(dirForColumnKey(columnKey), { recursive: true });
    await fs.writeFile(filePathFor(columnKey, formatKey), buf);
}

async function writeOneCell(columnKey, formatKey) {
    if (columnKey === "sale" || columnKey === "purchase") {
        await writeSalePurchaseVariant(columnKey, formatKey);
    } else {
        await writeSimpleVariant(columnKey, formatKey);
    }
}

/**
 * Writes classic / compact / minimal PDFs under `media/format/<column>/` for every `invoice_formats` column.
 */
export async function writeAllFormatSamplePdfsToDisk() {
    for (let ci = 0; ci < INVOICE_FORMAT_COLUMNS.length; ci++) {
        const columnKey = INVOICE_FORMAT_COLUMNS[ci];
        for (let vi = 0; vi < FORMAT_VARIANT_IDS.length; vi++) {
            const formatKey = FORMAT_VARIANT_IDS[vi];
            await writeOneCell(columnKey, formatKey);
        }
    }
}

async function fileExists(p) {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}

async function ensureFormatSamplesExist() {
    for (let ci = 0; ci < INVOICE_FORMAT_COLUMNS.length; ci++) {
        for (let vi = 0; vi < FORMAT_VARIANT_IDS.length; vi++) {
            const p = filePathFor(INVOICE_FORMAT_COLUMNS[ci], FORMAT_VARIANT_IDS[vi]);
            if (!(await fileExists(p))) {
                await writeAllFormatSamplePdfsToDisk();
                return;
            }
        }
    }
}

/**
 * Returns `[{ format_id, data: base64 }, ...]` for the given API `type`
 * (e.g. sale, purchase, receive, payment receive, expense).
 */
export async function getFormatSamplePdfsBase64(invoiceTypeInput) {
    const dirKey = getFormatSampleDirKeyFromApiType(invoiceTypeInput);
    if (!dirKey || !INVOICE_FORMAT_COLUMNS.includes(dirKey)) {
        throw new Error(
            "Invalid type for format samples. Use: sale, purchase, payment, receive, contra, journal, expense (or payment receive)"
        );
    }
    await ensureFormatSamplesExist();

    const out = [];
    for (let i = 0; i < FORMAT_VARIANT_IDS.length; i++) {
        const formatKey = FORMAT_VARIANT_IDS[i];
        const buf = await fs.readFile(filePathFor(dirKey, formatKey));
        out.push({
            format_id: formatKey,
            data: buf.toString("base64"),
        });
    }
    return out;
}
