import fs from "fs/promises";
import path from "path";
import { BASE_DOMAIN } from "./Config.js";
import { buildUnifiedInvoicePdfBuffer } from "./pdfGenerator.js";
import { getAvailableFormatsForType } from "./invoiceFormatMapping.js";

const INVOICE_FORMAT_COLUMNS = ["sale", "purchase", "payment", "receive", "journal", "expense"];

const SAMPLE_INVOICE = {
    invoice_id: "format-sample",
    invoice_no: "SAMPLE-001",
    created_at: new Date("2026-01-15T12:00:00.000Z"),
    amount: 12050,
    grand_total: 12050,
    subtotal: 10000,
    total: 11800,
    discount_value: 0,
    additional_charge: 0,
    tax_amount: 1800,
    remark: "This is a sample document for previewing invoice layout only.",
};

const SAMPLE_TRANSACTION = {
    transaction_date: new Date("2026-01-15T12:00:00.000Z"),
    payment_method: "Bank Transfer",
    reference_no: "TXN-884729104",
    remark: "This is a sample document for previewing invoice layout only.",
};

const SAMPLE_ITEMS = [
    {
        service_name: "Professional services (sample)",
        fees: 6000,
        total: 7080,
        description: "Quarterly software development support",
    },
    {
        service_name: "Consulting — quarterly (sample)",
        fees: 4000,
        total: 4720,
        description: "IT architecture consultation",
    },
];

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
    expense: [
        { label: "Paid to", value: "Sample Expense Vendor" },
        { label: "Book", value: "Office expenses (sample)" },
    ],
};

const SAMPLE_ISSUER = {
    name: "Sample Corporation Ltd.",
    phone: "+91 99999 88888",
    email: "info@samplecorp.com",
    address: "101, Business Tower, Tech Park, Sector 62, Noida, UP, 201301",
};

const TYPE_TITLES = {
    sale: "TAX INVOICE",
    purchase: "PURCHASE INVOICE",
    payment: "PAYMENT VOUCHER",
    receive: "RECEIPT",
    journal: "JOURNAL VOUCHER",
    expense: "EXPENSE VOUCHER",
};

async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function buildOneSamplePdf(columnKey) {
    const isSale = columnKey === "sale";
    const isPurchase = columnKey === "purchase";

    let partyName = "Sample Client Pvt. Ltd.";
    if (isPurchase) partyName = "Sample Supplier & Co.";
    else if (columnKey === "payment") partyName = "Sample Vendor";
    else if (columnKey === "receive") partyName = "Sample Client";
    else if (columnKey === "expense") partyName = "Office Expenses";

    const lines = SAMPLE_LINES_BY_FORMAT_COLUMN[columnKey] || [];

    return buildUnifiedInvoicePdfBuffer({
        title: TYPE_TITLES[columnKey] || "INVOICE",
        pdfSubject: `Sample ${columnKey}`,
        invoice: SAMPLE_INVOICE,
        transactionRow: SAMPLE_TRANSACTION,
        items: isSale || isPurchase ? SAMPLE_ITEMS : [],
        partyName,
        issuer: SAMPLE_ISSUER,
        lines,
    });
}

/**
 * Checks if the PDFs for a specific type already exist.
 * Missing files are generated with PDFKit (no Puppeteer).
 */
async function ensureTypeFormatSamples(columnKey) {
    const formats = getAvailableFormatsForType(columnKey);
    const dir = path.join(process.cwd(), "media", "format", columnKey);
    await fs.mkdir(dir, { recursive: true });

    let allExist = true;
    for (const formatKey of formats) {
        if (!(await fileExists(path.join(dir, `${formatKey}.pdf`)))) {
            allExist = false;
            break;
        }
    }
    if (allExist) return;

    try {
        // One PDFKit layout for all format keys (HTML theme variants need a browser).
        const buffer = await buildOneSamplePdf(columnKey);
        for (const formatKey of formats) {
            await fs.writeFile(path.join(dir, `${formatKey}.pdf`), buffer);
        }
    } catch (err) {
        console.error(`[InvoiceFormats] PDFKit sample render failed for '${columnKey}':`, err.message);
    }
}

export async function getFormatSamplePdfsBase64(invoiceTypeInput) {
    const map = {
        sale: "sale",
        purchase: "purchase",
        payment: "payment",
        receive: "receive",
        "payment receive": "receive",
        journal: "journal",
        expense: "expense",
    };
    const dirKey = map[String(invoiceTypeInput).trim().toLowerCase()];
    if (!dirKey || !INVOICE_FORMAT_COLUMNS.includes(dirKey)) {
        throw new Error("Invalid type for format samples");
    }

    await ensureTypeFormatSamples(dirKey);

    const formats = getAvailableFormatsForType(dirKey);
    const base = String(BASE_DOMAIN || "").replace(/\/$/, "");
    const out = [];
    for (let i = 0; i < formats.length; i++) {
        const formatKey = formats[i];
        out.push({
            format_id: formatKey,
            url: `${base}/media/format/${dirKey}/${formatKey}.pdf`,
        });
    }
    return out;
}
