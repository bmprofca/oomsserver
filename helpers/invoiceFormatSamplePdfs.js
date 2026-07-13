import fs from "fs/promises";
import path from "path";
import { BASE_DOMAIN } from "./Config.js";
import { renderHtmlTemplate, htmlToPdfBufferBatch } from "./invoiceTemplateEngine.js";
import { buildTemplateData } from "./invoiceDataBuilder.js";

import { getAvailableFormatsForType } from "./invoiceFormatMapping.js";

const INVOICE_FORMAT_COLUMNS = ["sale", "purchase", "payment", "receive", "journal", "contra", "expense"];

const SAMPLE_INVOICE = {
    invoice_id: "format-sample",
    invoice_no: "SAMPLE-001",
    created_at: new Date("2026-01-15T12:00:00.000Z"),
    amount: 12050,
    tax_amount: 1800,
    remark: "This is a sample document for previewing invoice layout only.",
};

const SAMPLE_TRANSACTION = {
    payment_method: "Bank Transfer",
    reference_no: "TXN-884729104",
    remark: "This is a sample document for previewing invoice layout only.",
};

const SAMPLE_ITEMS = [
    {
        service_name: "Professional services (sample)",
        fees: 6000,
        rate: 6000,
        quantity: 1,
        description: "Quarterly software development support",
    },
    {
        service_name: "Consulting — quarterly (sample)",
        fees: 4000,
        rate: 4000,
        quantity: 1,
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
    contra: [
        { label: "From", value: "Sample Bank A" },
        { label: "To", value: "Sample Bank B" },
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

function mapFormatKeyToTemplateName(key) {
    return String(key || "classic").trim().toLowerCase();
}

/**
 * Build the compiled HTML string for one sample (no PDF yet).
 */
async function buildOneSampleHtml(columnKey, formatKey) {
    const activeTemplate = mapFormatKeyToTemplateName(formatKey);
    const isSale = columnKey === "sale";
    const isPurchase = columnKey === "purchase";
    
    let partyName = "Sample Client Pvt. Ltd.";
    if (isPurchase) partyName = "Sample Supplier & Co.";
    else if (columnKey === "payment") partyName = "Sample Vendor";
    else if (columnKey === "receive") partyName = "Sample Client";
    else if (columnKey === "expense") partyName = "Office Expenses";

    const lines = SAMPLE_LINES_BY_FORMAT_COLUMN[columnKey] || [];

    const templateData = buildTemplateData({
        type: columnKey,
        invoice: SAMPLE_INVOICE,
        transactionRow: SAMPLE_TRANSACTION,
        items: (isSale || isPurchase) ? SAMPLE_ITEMS : [],
        partyName,
        issuer: SAMPLE_ISSUER,
        lines,
    });

    return renderHtmlTemplate(columnKey, activeTemplate, templateData);
}

async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Checks if the PDFs for a specific type (e.g. "sale") already exist.
 * If any are missing, it batch-generates all in ~2 seconds.
 */
async function ensureTypeFormatSamples(columnKey) {
    const formats = getAvailableFormatsForType(columnKey);
    const dir = path.join(process.cwd(), "media", "format", columnKey);
    await fs.mkdir(dir, { recursive: true });

    // Check if ALL variants already exist
    let allExist = true;
    for (const formatKey of formats) {
        if (!(await fileExists(path.join(dir, `${formatKey}.pdf`)))) {
            allExist = false;
            break;
        }
    }

    if (allExist) {
        return; // Already generated, instantly return
    }

    const startTime = Date.now();
    // console.log(`[InvoiceFormats] Missing PDFs for '${columnKey}'. Generating now...`);

    const jobs = [];
    for (const formatKey of formats) {
        try {
            const html = await buildOneSampleHtml(columnKey, formatKey);
            jobs.push({ formatKey, html });
        } catch (err) {
            console.error(`[InvoiceFormats] Template error ${columnKey}/${formatKey}:`, err.message);
        }
    }

    if (jobs.length === 0) return;

    try {
        const buffers = await htmlToPdfBufferBatch(jobs.map(j => j.html));
        for (let i = 0; i < jobs.length; i++) {
            const buf = buffers[i];
            if (buf && buf.length > 0) {
                await fs.writeFile(path.join(dir, `${jobs[i].formatKey}.pdf`), buf);
            }
        }
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        // console.log(`[InvoiceFormats] Done — ${jobs.length} PDFs generated for '${columnKey}' in ${elapsed}s`);
    } catch (err) {
        console.error(`[InvoiceFormats] Batch PDF render failed for '${columnKey}':`, err.message);
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
        contra: "contra",
        expense: "expense",
    };
    const dirKey = map[String(invoiceTypeInput).trim().toLowerCase()];
    if (!dirKey || !INVOICE_FORMAT_COLUMNS.includes(dirKey)) {
        throw new Error("Invalid type for format samples");
    }

    // Lazy load: ensure the PDFs for THIS SPECIFIC TYPE exist before returning URLs
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
