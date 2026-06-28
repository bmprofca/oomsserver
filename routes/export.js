// /www/wwwroot/ooms-api/routes/export.js

import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import nodemailer from "nodemailer";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();
const EXPORT_DIR = path.join(__dirname, "../exports");

// Ensure export directory exists
if (!fs.existsSync(EXPORT_DIR)) {
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
}

// Helper functions
function newId(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function ok(res, message, data = {}, pagination) {
    return res.json({ success: true, message, data, ...(pagination ? { pagination } : {}) });
}

function fail(res, message, code = 400) {
    return res.status(code).json({ success: false, message });
}

function getEncKey() {
    const base = process.env.SMTP_ENCRYPTION_KEY || "ooms-default-smtp-encryption-key-change-me";
    return crypto.createHash("sha256").update(base).digest();
}

function decrypt(payload) {
    if (!payload) return "";
    try {
        const buf = Buffer.from(String(payload), "base64");
        const iv = buf.subarray(0, 12);
        const tag = buf.subarray(12, 28);
        const enc = buf.subarray(28);
        const decipher = crypto.createDecipheriv("aes-256-gcm", getEncKey(), iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
    } catch {
        return "";
    }
}

// Get default SMTP config for branch
async function getEmailConfig(branch_id) {
    const [config] = await pool.query(
        `SELECT * FROM email_configs 
         WHERE branch_id = ? AND status = 'active' AND is_default = 1 
         LIMIT 1`,
        [branch_id]
    );
    return config[0] || null;
}

// Generate Excel file from data
// Generate Excel file from data - Professional Format
async function generateExcel(data, columns, sheetName = 'Export') {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(sheetName);
    
    // Style for header row
    const headerStyle = {
        font: { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } },
        alignment: { horizontal: 'center', vertical: 'middle' },
        border: {
            top: { style: 'thin', color: { argb: 'FF2563EB' } },
            bottom: { style: 'thin', color: { argb: 'FF2563EB' } },
            left: { style: 'thin', color: { argb: 'FF2563EB' } },
            right: { style: 'thin', color: { argb: 'FF2563EB' } }
        }
    };
    
    // Add headers
    worksheet.columns = columns.map(col => ({
        header: col.header,
        key: col.key,
        width: col.width || 20
    }));
    
    // Apply header style
    const headerRow = worksheet.getRow(1);
    headerRow.height = 25;
    headerRow.eachCell((cell) => {
        cell.style = headerStyle;
    });
    
    // Style for data rows
    const dataStyle = {
        alignment: { vertical: 'middle' },
        border: {
            top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
        }
    };
    
    // Add data rows with alternating colors
    data.forEach((row, idx) => {
        const rowData = {};
        columns.forEach(col => {
            rowData[col.key] = row[col.key] !== undefined ? row[col.key] : '';
        });
        const addedRow = worksheet.addRow(rowData);
        
        // Alternate row colors
        if (idx % 2 === 0) {
            addedRow.eachCell((cell) => {
                cell.fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FFF8FAFC' }
                };
                cell.style = dataStyle;
            });
        } else {
            addedRow.eachCell((cell) => {
                cell.fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FFFFFFFF' }
                };
                cell.style = dataStyle;
            });
        }
        
        addedRow.height = 20;
    });
    
    // Freeze header row
    worksheet.views = [{ state: 'frozen', ySplit: 1 }];
    
    // Auto-filter
    worksheet.autoFilter = {
        from: 'A1',
        to: { column: columns.length, row: data.length + 1 }
    };
    
    const buffer = await workbook.xlsx.writeBuffer();
    return buffer;
}

// Generate CSV file from data
async function generateCSV(data, columns) {
    const headers = columns.map(col => col.header).join(',');
    const rows = data.map(row => {
        return columns.map(col => {
            let value = row[col.key] !== undefined ? String(row[col.key]) : '';
            if (value.includes(',') || value.includes('"') || value.includes('\n')) {
                value = `"${value.replace(/"/g, '""')}"`;
            }
            return value;
        }).join(',');
    });
    
    return Buffer.from([headers, ...rows].join('\n'), 'utf-8');
}

// Generate PDF file from data - Professional Table Format (No Icons)
async function generatePDF(data, columns, title, subtitle = '') {
    return new Promise((resolve, reject) => {
        const chunks = [];
        // Use landscape layout for better table display
        const doc = new PDFDocument({ 
            margin: 40,
            size: 'A4',
            layout: 'landscape'
        });
        
        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        
        // Color scheme
        const colors = {
            primary: '#1e3a5f',
            secondary: '#2563eb',
            headerBg: '#1e40af',
            headerText: '#ffffff',
            rowEven: '#f8fafc',
            rowOdd: '#ffffff',
            border: '#cbd5e1',
            borderDark: '#94a3b8',
            text: '#1e293b',
            textLight: '#64748b',
            accent: '#059669',
            summaryBg: '#f0fdf4'
        };
        
        let currentY = 0;
        
        // Helper function to draw a line
        const drawLine = (y, color = colors.border, lineWidth = 0.5) => {
            doc.strokeColor(color).lineWidth(lineWidth).moveTo(40, y).lineTo(doc.page.width - 40, y).stroke();
        };
        
        // ============ HEADER SECTION ============
        const drawHeader = () => {
            // Header background
            doc.rect(40, 30, doc.page.width - 80, 85).fill(colors.primary);
            
            // Title
            doc.fillColor(colors.headerText)
                .fontSize(22)
                .font('Helvetica-Bold')
                .text(title, 55, 48, { align: 'left' });
            
            // Subtitle
            if (subtitle) {
                doc.fontSize(10)
                    .font('Helvetica')
                    .text(subtitle, 55, 78, { align: 'left' });
            }
            
            // Company/Report label on right side
            doc.fontSize(9)
                .font('Helvetica-Oblique')
                .text('Professional Report', doc.page.width - 80, 55, { align: 'right' });
            
            return 130;
        };
        
        // ============ INFO BOX ============
        const drawInfoBox = (startY) => {
            const boxHeight = 48;
            doc.fillColor('#f1f5f9')
                .rect(40, startY, doc.page.width - 80, boxHeight)
                .fill();
            
            doc.fillColor(colors.text);
            
            // Left column - Export Information
            doc.fontSize(8).font('Helvetica-Bold')
                .text('EXPORT INFORMATION', 55, startY + 8);
            
            doc.fontSize(8).font('Helvetica')
                .text(`Export Date: ${new Date().toLocaleDateString('en-GB', { 
                    day: '2-digit', 
                    month: 'long', 
                    year: 'numeric' 
                })}`, 55, startY + 22);
            
            doc.text(`Export Time: ${new Date().toLocaleTimeString('en-US', { 
                hour: '2-digit', 
                minute: '2-digit', 
                second: '2-digit' 
            })}`, 55, startY + 34);
            
            // Right column - Statistics
            doc.font('Helvetica-Bold')
                .text('STATISTICS', doc.page.width - 200, startY + 8, { align: 'right' });
            
            doc.font('Helvetica')
                .text(`Total Records: ${data.length.toLocaleString()}`, doc.page.width - 200, startY + 22, { align: 'right' })
                .text(`Total Columns: ${columns.length}`, doc.page.width - 200, startY + 34, { align: 'right' });
            
            return startY + boxHeight + 15;
        };
        
        // ============ TABLE SECTION ============
        const tableLeft = 40;
        const tableRight = doc.page.width - 40;
        const tableWidth = tableRight - tableLeft;
        
        // Calculate dynamic column widths based on content
        const calculateColumnWidths = () => {
            const widths = columns.map((col, idx) => {
                // Get max content length for this column
                let maxContentLength = col.header.length;
                data.slice(0, 100).forEach(row => {
                    const value = row[col.key] !== undefined && row[col.key] !== null ? String(row[col.key]) : '-';
                    maxContentLength = Math.max(maxContentLength, value.length);
                });
                // Limit width between 60 and 200 pixels
                return Math.min(Math.max(65, maxContentLength * 5.5), 200);
            });
            
            // Adjust widths to fit available space
            let totalWidth = widths.reduce((sum, w) => sum + w, 0);
            if (totalWidth > tableWidth) {
                const ratio = tableWidth / totalWidth;
                widths.forEach((w, i) => widths[i] = w * ratio);
            }
            return widths;
        };
        
        const columnWidths = calculateColumnWidths();
        
        // Function to draw table header
        const drawTableHeader = (y) => {
            let currentX = tableLeft;
            
            // Header background
            doc.fillColor(colors.headerBg)
                .rect(tableLeft, y, tableWidth, 38)
                .fill();
            
            // Header top border
            drawLine(y, colors.headerBg, 1);
            
            // Header text
            doc.fillColor(colors.headerText)
                .font('Helvetica-Bold')
                .fontSize(9);
            
            columns.forEach((col, idx) => {
                doc.text(col.header, currentX + 10, y + 13, { 
                    width: columnWidths[idx] - 20,
                    align: 'left'
                });
                currentX += columnWidths[idx];
            });
            
            // Header bottom border
            drawLine(y + 38, colors.borderDark, 0.8);
            
            return y + 38;
        };
        
        // Function to draw table row
        const drawTableRow = (row, y, rowIndex) => {
            let currentX = tableLeft;
            const isEven = rowIndex % 2 === 0;
            
            // Row background
            if (isEven) {
                doc.fillColor(colors.rowEven).rect(tableLeft, y, tableWidth, 30).fill();
            } else {
                doc.fillColor(colors.rowOdd).rect(tableLeft, y, tableWidth, 30).fill();
            }
            
            // Row bottom border
            drawLine(y + 30, colors.border, 0.3);
            
            // Row data
            doc.fillColor(colors.text)
                .font('Helvetica')
                .fontSize(8);
            
            columns.forEach((col, idx) => {
                let value = row[col.key] !== undefined && row[col.key] !== null ? String(row[col.key]) : '-';
                
                // Truncate long values
                const maxChars = Math.floor((columnWidths[idx] - 20) / 5.5);
                if (value.length > maxChars && maxChars > 15) {
                    value = value.substring(0, maxChars - 3) + '...';
                }
                
                doc.text(value, currentX + 10, y + 10, { 
                    width: columnWidths[idx] - 20,
                    align: 'left'
                });
                currentX += columnWidths[idx];
            });
            
            return y + 30;
        };
        
        // Draw header and info box
        let currentRowY = drawHeader();
        currentRowY = drawInfoBox(currentRowY);
        
        // Draw table header
        currentRowY = drawTableHeader(currentRowY);
        
        // Calculate rows per page
        const rowsPerPage = Math.floor((doc.page.height - currentRowY - 100) / 30);
        let rowCount = 0;
        
        // Draw data rows
        for (let i = 0; i < data.length; i++) {
            // Check if we need a new page
            if (rowCount >= rowsPerPage && rowsPerPage > 5) {
                doc.addPage();
                
                // Redraw elements on new page
                currentRowY = drawHeader();
                currentRowY = drawInfoBox(currentRowY);
                currentRowY = drawTableHeader(currentRowY);
                rowCount = 0;
            }
            
            currentRowY = drawTableRow(data[i], currentRowY, i);
            rowCount++;
        }
        
        // Draw bottom border of table
        drawLine(currentRowY, colors.borderDark, 0.8);
        
        // ============ SUMMARY SECTION ============
        const summaryY = currentRowY + 20;
        
        // Only add summary if there's space on the page
        if (summaryY + 80 < doc.page.height - 40) {
            // Summary box background
            doc.fillColor(colors.summaryBg)
                .rect(tableLeft, summaryY, tableWidth, 70)
                .fill();
            
            // Summary title
            doc.fillColor(colors.accent)
                .font('Helvetica-Bold')
                .fontSize(10)
                .text('SUMMARY REPORT', tableLeft + 15, summaryY + 10);
            
            // Divider line
            drawLine(summaryY + 28, '#bbf7d0', 0.5);
            
            // Collect summary data
            const summaryItems = [];
            
            // Add total records
            summaryItems.push({ 
                label: 'Total Records', 
                value: data.length.toLocaleString(),
                type: 'count'
            });
            
            // Find numeric columns for summary
            columns.forEach((col) => {
                let hasNumeric = false;
                let total = 0;
                let count = 0;
                
                // Check first 20 rows if column contains numbers
                data.slice(0, 20).forEach(row => {
                    const val = parseFloat(row[col.key]);
                    if (!isNaN(val) && isFinite(val) && row[col.key] !== null && row[col.key] !== '') {
                        hasNumeric = true;
                    }
                });
                
                if (hasNumeric) {
                    data.forEach(row => {
                        const val = parseFloat(row[col.key]);
                        if (!isNaN(val) && isFinite(val)) {
                            total += val;
                            count++;
                        }
                    });
                    if (count > 0) {
                        summaryItems.push({
                            label: col.header,
                            value: '₹ ' + total.toLocaleString('en-IN', { 
                                minimumFractionDigits: 2, 
                                maximumFractionDigits: 2 
                            }),
                            type: 'currency'
                        });
                    }
                }
            });
            
            // Display summary items in a grid
            const itemsPerRow = 4;
            const itemWidth = (tableWidth - 30) / itemsPerRow;
            let summaryX = tableLeft + 15;
            
            summaryItems.slice(0, 8).forEach((item, idx) => {
                const colIdx = idx % itemsPerRow;
                if (colIdx === 0 && idx > 0) {
                    summaryX = tableLeft + 15;
                }
                
                // Label
                doc.fillColor('#065f46')
                    .font('Helvetica-Bold')
                    .fontSize(8)
                    .text(item.label, summaryX, summaryY + 40);
                
                // Value
                doc.fillColor(colors.accent)
                    .font('Helvetica')
                    .fontSize(10)
                    .text(item.value, summaryX, summaryY + 55);
                
                summaryX += itemWidth;
            });
        }
        
        // ============ FOOTER ============
        const footerY = doc.page.height - 35;
        
        // Footer line
        drawLine(footerY - 10, colors.border, 0.5);
        
        // Footer text
        doc.fillColor(colors.textLight)
            .fontSize(7)
            .font('Helvetica-Oblique')
            .text(
                `Generated by OOMS System • Page ${doc.page.number} • ${new Date().toLocaleString()}`, 
                40, 
                footerY, 
                { align: 'center', width: doc.page.width - 80 }
            );
        
        doc.end();
    });
}

// Send email with attachment
async function sendExportEmail(branch_id, recipientEmail, filePath, fileName, jobId, customSubject = null, customMessage = null) {
    try {
        const emailConfig = await getEmailConfig(branch_id);
        
        if (!emailConfig) {
            console.error(`No email config found for branch ${branch_id}`);
            return false;
        }
        
        const transporter = nodemailer.createTransport({
            host: emailConfig.host,
            port: Number(emailConfig.port),
            secure: Number(emailConfig.secure) === 1 || Number(emailConfig.port) === 465,
            auth: {
                user: emailConfig.username,
                pass: decrypt(emailConfig.password_encrypted)
            }
        });
        
        const from = emailConfig.from_name ? 
            `${emailConfig.from_name} <${emailConfig.from_email}>` : 
            emailConfig.from_email;
        
        const fileExtension = path.extname(fileName).toLowerCase();
        let mimeType = 'application/octet-stream';
        
        if (fileExtension === '.xlsx') mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        else if (fileExtension === '.csv') mimeType = 'text/csv';
        else if (fileExtension === '.pdf') mimeType = 'application/pdf';
        
        const defaultSubject = customSubject || `Export Job Completed - ${jobId}`;
        const defaultMessage = customMessage || `
            <h2>Export Completed Successfully</h2>
            <p>Your export request has been processed.</p>
            <p><strong>Job ID:</strong> ${jobId}</p>
            <p><strong>File Name:</strong> ${fileName}</p>
            <p><strong>Generated on:</strong> ${new Date().toLocaleString()}</p>
            <p>Please find the attached file.</p>
            <hr>
            <p style="font-size: 12px; color: #666;">This is an automated message. Please do not reply.</p>
        `;
        
        const mailOptions = {
            from,
            to: recipientEmail,
            subject: defaultSubject,
            html: defaultMessage,
            attachments: [{
                filename: fileName,
                path: filePath,
                contentType: mimeType
            }]
        };
        
        await transporter.sendMail(mailOptions);
        console.log(`Export email sent for job ${jobId} to ${recipientEmail}`);
        return true;
    } catch (error) {
        console.error(`Failed to send export email for job ${jobId}:`, error);
        return false;
    }
}

// Process export job in background
async function processExportJob(jobId) {
    const [jobRows] = await pool.query(
        "SELECT * FROM export_jobs WHERE job_id = ?",
        [jobId]
    );
    
    if (!jobRows.length) return;
    
    const job = jobRows[0];
    
    // Update status to processing
    await pool.query(
        "UPDATE export_jobs SET status = 'processing', started_at = NOW() WHERE job_id = ?",
        [jobId]
    );
    
    try {
        // Parse data and columns
        let data = [];
        let columns = [];
        
        if (job.data_snapshot) {
            const snapshot = JSON.parse(job.data_snapshot);
            data = snapshot.data || [];
            columns = snapshot.columns || [];
        }
        
        if (!data.length) {
            throw new Error("No data to export");
        }
        
        // Generate file based on type
        let fileBuffer;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `${job.job_type}_${timestamp}.${job.file_type === 'excel' ? 'xlsx' : job.file_type}`;
        const filePath = path.join(EXPORT_DIR, fileName);
        
        switch (job.file_type) {
            case 'excel':
                fileBuffer = await generateExcel(data, columns, job.job_type);
                break;
            case 'csv':
                fileBuffer = await generateCSV(data, columns);
                break;
            case 'pdf':
                fileBuffer = await generatePDF(data, columns, job.job_type, `Total Records: ${data.length}`);
                break;
            default:
                throw new Error(`Unsupported file type: ${job.file_type}`);
        }
        
        // Save file
        fs.writeFileSync(filePath, fileBuffer);
        const fileSize = fs.statSync(filePath).size;
        
        // Update job with file info
        await pool.query(
            `UPDATE export_jobs 
             SET status = 'completed', 
                 file_path = ?, 
                 file_name = ?, 
                 file_size = ?,
                 total_records = ?,
                 completed_at = NOW() 
             WHERE job_id = ?`,
            [filePath, fileName, fileSize, data.length, jobId]
        );
        
        // Send email with attachment
        await sendExportEmail(
            job.branch_id,
            job.recipient_email,
            filePath,
            fileName,
            jobId,
            job.email_subject,
            job.email_message
        );
        
        console.log(`Export job ${jobId} completed successfully`);
        
        // Optional: Delete file after 24 hours (cleanup job)
        setTimeout(() => {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`Deleted export file: ${filePath}`);
            }
        }, 24 * 60 * 60 * 1000);
        
    } catch (error) {
        console.error(`Export job ${jobId} failed:`, error);
        await pool.query(
            `UPDATE export_jobs 
             SET status = 'failed', 
                 error_message = ?,
                 completed_at = NOW() 
             WHERE job_id = ?`,
            [error.message, jobId]
        );
    }
}

// ==================== EXPORT APIs ====================

// Request export (creates background job)
router.post("/request", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.headers.username || req.headers.Username || null;
        const { 
            job_type,
            file_type,
            recipient_email,
            email_subject,
            email_message,
            data,
            columns,
            filters = {}
        } = req.body || {};
        
        // Validation
        if (!job_type) {
            return fail(res, "job_type is required (e.g., task_report, client_list, finance_summary)");
        }
        
        if (!file_type || !['excel', 'csv', 'pdf'].includes(file_type)) {
            return fail(res, "file_type must be 'excel', 'csv', or 'pdf'");
        }
        
        if (!recipient_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient_email)) {
            return fail(res, "Valid recipient_email is required");
        }
        
        if (!data || !Array.isArray(data) || !data.length) {
            return fail(res, "data must be a non-empty array");
        }
        
        if (!columns || !Array.isArray(columns) || !columns.length) {
            return fail(res, "columns must be a non-empty array with {header, key}");
        }
        
        // Validate columns format
        for (const col of columns) {
            if (!col.header || !col.key) {
                return fail(res, "Each column must have 'header' and 'key' properties");
            }
        }
        
        // Check for existing pending/processing export job for same branch and type
        const [existing] = await pool.query(
            `SELECT job_id, status FROM export_jobs 
             WHERE branch_id = ? AND job_type = ? AND status IN ('pending', 'processing')
             LIMIT 1`,
            [branch_id, job_type]
        );
        
        if (existing.length) {
            return fail(res, `An export for "${job_type}" is already in progress. Please wait for it to complete.`, 409);
        }
        
        // Create export job
        const job_id = newId("exp");
        
        // Store data snapshot
        const dataSnapshot = JSON.stringify({
            data: data,
            columns: columns,
            total_records: data.length
        });
        
        await pool.query(
            `INSERT INTO export_jobs 
             (job_id, branch_id, job_type, file_type, recipient_email, 
              email_subject, email_message, data_snapshot, columns_config, 
              filters, total_records, requested_by, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW())`,
            [
                job_id, branch_id, job_type, file_type, recipient_email,
                email_subject || null, email_message || null,
                dataSnapshot, JSON.stringify(columns),
                JSON.stringify(filters), data.length,
                username || 'system'
            ]
        );
        
        // Process job in background (don't await)
        processExportJob(job_id).catch(err => {
            console.error(`Background job ${job_id} error:`, err);
        });
        
        return ok(res, "Export request submitted successfully. You will receive the file via email once completed.", {
            job_id: job_id,
            status: 'pending',
            estimated_records: data.length,
            message: "The export is being processed in the background. You'll receive an email when ready."
        });
        
    } catch (error) {
        console.error("Export request error:", error);
        return fail(res, error.message);
    }
});

// Get export job status
router.get("/status/:job_id", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const job_id = req.params.job_id;
        
        const [rows] = await pool.query(
            `SELECT job_id, job_type, file_type, status, total_records, 
                    file_name, file_size, error_message, 
                    created_at, started_at, completed_at
             FROM export_jobs 
             WHERE branch_id = ? AND job_id = ?`,
            [branch_id, job_id]
        );
        
        if (!rows.length) {
            return fail(res, "Export job not found", 404);
        }
        
        const job = rows[0];
        
        return ok(res, "Export job status retrieved", {
            job_id: job.job_id,
            job_type: job.job_type,
            file_type: job.file_type,
            status: job.status,
            total_records: job.total_records,
            file_name: job.file_name,
            file_size: job.file_size,
            error_message: job.error_message,
            created_at: job.created_at,
            started_at: job.started_at,
            completed_at: job.completed_at
        });
        
    } catch (error) {
        return fail(res, error.message);
    }
});

// Get all export jobs for branch
router.get("/list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const page_no = Math.max(Number(req.query.page_no || 1), 1);
        const limit = Math.min(Number(req.query.limit || 20), 100);
        const offset = (page_no - 1) * limit;
        const status_filter = req.query.status;
        
        let query = `SELECT job_id, job_type, file_type, status, total_records, 
                            file_name, file_size, created_at, completed_at
                     FROM export_jobs 
                     WHERE branch_id = ?`;
        const params = [branch_id];
        
        if (status_filter && ['pending', 'processing', 'completed', 'failed', 'cancelled'].includes(status_filter)) {
            query += ` AND status = ?`;
            params.push(status_filter);
        }
        
        query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);
        
        const [rows] = await pool.query(query, params);
        
        const [countRows] = await pool.query(
            `SELECT COUNT(*) as total FROM export_jobs WHERE branch_id = ?`,
            [branch_id]
        );
        
        const total = countRows[0]?.total || 0;
        
        return ok(res, "Export jobs retrieved", rows, {
            page_no,
            limit,
            total,
            total_pages: Math.ceil(total / limit)
        });
        
    } catch (error) {
        return fail(res, error.message);
    }
});

// Cancel pending export job
router.post("/cancel/:job_id", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const job_id = req.params.job_id;
        
        const [result] = await pool.query(
            `UPDATE export_jobs 
             SET status = 'cancelled', 
                 error_message = 'Cancelled by user',
                 completed_at = NOW()
             WHERE branch_id = ? AND job_id = ? AND status IN ('pending')`,
            [branch_id, job_id]
        );
        
        if (!result.affectedRows) {
            return fail(res, "Job not found or cannot be cancelled (already processing/completed)");
        }
        
        return ok(res, "Export job cancelled successfully");
        
    } catch (error) {
        return fail(res, error.message);
    }
});

export default router;