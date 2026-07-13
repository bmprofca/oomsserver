import puppeteer from "puppeteer";
import fs from "fs/promises";
import path from "path";
import Handlebars from "handlebars";

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

/**
 * Converts a raw HTML string into a PDF Buffer using headless Puppeteer.
 * Opens a new page in a temporary browser, renders, and closes.
 */
export async function htmlToPdfBuffer(html) {
    const browser = await puppeteer.launch({
        headless: "shell",
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--hide-scrollbars",
            "--mute-audio"
        ]
    });
    try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: "domcontentloaded" });
        // Small delay to let CSS paint
        await new Promise((r) => setTimeout(r, 300));
        const pdfBuffer = await page.pdf({
            format: "A4",
            printBackground: true,
            margin: { top: "0px", bottom: "0px", left: "0px", right: "0px" }
        });
        return pdfBuffer;
    } finally {
        await browser.close();
    }
}

/**
 * Batch-render multiple HTML strings into PDF buffers using a SINGLE browser instance.
 * Much faster than calling htmlToPdfBuffer() in a loop (avoids 56 browser launches).
 *
 * @param {string[]} htmlArray - Array of compiled HTML strings
 * @returns {Promise<Buffer[]>} - Array of PDF buffers in same order
 */
export async function htmlToPdfBufferBatch(htmlArray) {
    const browser = await puppeteer.launch({
        headless: "shell",
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--hide-scrollbars",
            "--mute-audio"
        ]
    });
    try {
        const buffers = [];
        for (let i = 0; i < htmlArray.length; i++) {
            const page = await browser.newPage();
            await page.setContent(htmlArray[i], { waitUntil: "domcontentloaded" });
            await new Promise((r) => setTimeout(r, 200));
            const pdfBuffer = await page.pdf({
                format: "A4",
                printBackground: true,
                margin: { top: "0px", bottom: "0px", left: "0px", right: "0px" }
            });
            buffers.push(pdfBuffer);
            await page.close();
        }
        return buffers;
    } finally {
        await browser.close();
    }
}
