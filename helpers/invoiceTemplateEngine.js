import fs from "fs/promises";
import path from "path";
import Handlebars from "handlebars";
import PDFDocument from "pdfkit";

// Register helper for money formatting
Handlebars.registerHelper("money", function (num) {
    const x = Number(num);
    if (isNaN(x)) return "Rs. 0.00";
    return `Rs. ${x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
});

Handlebars.registerHelper("eq", function (a, b) {
    return a === b;
});

/**
 * Loads an HTML template from disk, compiles it with Handlebars, and injects data.
 */
export async function renderHtmlTemplate(type, templateName, data) {
    const templatePath = path.join(process.cwd(), "templates", "format", type, `${templateName}.html`);
    try {
        const htmlContent = await fs.readFile(templatePath, "utf-8");
        const template = Handlebars.compile(htmlContent);
        return template(data);
    } catch (error) {
        console.error(`Error loading/rendering template ${templateName} for type ${type}:`, error);
        throw new Error(`Template not found or failed to render: ${templatePath}`);
    }
}

function stripHtmlToText(html) {
    return String(html || "")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|tr|h[1-6]|li|section)>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
}

/**
 * Converts HTML into a PDF Buffer using PDFKit (no browser / Puppeteer).
 * Styles from HTML templates are not preserved — content is flattened to text.
 * Prefer buildUnifiedInvoicePdfBuffer for structured invoice downloads.
 */
export async function htmlToPdfBuffer(html) {
    const text = stripHtmlToText(html);
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: "A4", margin: 48 });
            const buffers = [];
            doc.on("data", (chunk) => buffers.push(chunk));
            doc.on("end", () => resolve(Buffer.concat(buffers)));
            doc.on("error", reject);

            doc.font("Helvetica").fontSize(10).fillColor("#0f172a")
                .text(text || "Invoice", { width: doc.page.width - 96, align: "left" });
            doc.end();
        } catch (error) {
            reject(error);
        }
    });
}

/**
 * Batch-render multiple HTML strings into PDF buffers (single PDFKit pass per page).
 */
export async function htmlToPdfBufferBatch(htmlArray) {
    const buffers = [];
    for (let i = 0; i < htmlArray.length; i++) {
        buffers.push(await htmlToPdfBuffer(htmlArray[i]));
    }
    return buffers;
}
