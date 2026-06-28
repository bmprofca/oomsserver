/**
 * Writes sample PDFs under `media/format/<column>/` for every `invoice_formats` column
 * (sale, purchase, payment, receive, journal, contra, expense) × classic, compact, minimal.
 * Run: node scripts/generate-invoice-format-samples.js
 */
import { writeAllFormatSamplePdfsToDisk } from "../helpers/invoiceFormatSamplePdfs.js";

await writeAllFormatSamplePdfsToDisk();
console.log("Invoice format sample PDFs written under media/format/<column>/ for all invoice kinds.");
