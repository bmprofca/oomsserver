// /www/wwwroot/ooms-api/routes/backup.js

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
import multer from "multer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();
const EXPORT_DIR = path.join(__dirname, "../exports");

// Ensure export directory exists
if (!fs.existsSync(EXPORT_DIR)) {
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
}

// Configure multer for memory storage and size limits
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
}).single('file');

// Helpers
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

async function getEmailConfig(branch_id) {
    const [config] = await pool.query(
        `SELECT * FROM email_configs 
         WHERE branch_id = ? AND status = 'active' AND is_default = 1 
         LIMIT 1`,
        [branch_id]
    );
    return config[0] || null;
}

async function tableHasColumn(tableName, columnName) {
    try {
        const [columns] = await pool.query(`SHOW COLUMNS FROM \`${tableName}\``);
        return columns.some(col => col.Field === columnName);
    } catch {
        return false;
    }
}

// Helper to set worksheet style
function styleWorksheet(worksheet, data, columns, sheetName) {
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

    worksheet.columns = columns.map(col => ({
        header: col.header,
        key: col.key,
        width: col.width || 20
    }));

    const headerRow = worksheet.getRow(1);
    headerRow.height = 25;
    headerRow.eachCell((cell) => {
        cell.style = headerStyle;
    });

    const dataStyle = {
        alignment: { vertical: 'middle' },
        border: {
            top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
        }
    };

    data.forEach((row, idx) => {
        const rowData = {};
        columns.forEach(col => {
            rowData[col.key] = row[col.key] !== undefined && row[col.key] !== null ? row[col.key] : '';
        });
        const addedRow = worksheet.addRow(rowData);

        const isEven = idx % 2 === 0;
        addedRow.eachCell((cell) => {
            cell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: isEven ? 'FFF8FAFC' : 'FFFFFFFF' }
            };
            cell.style = dataStyle;
        });
        addedRow.height = 20;
    });

    worksheet.views = [{ state: 'frozen', ySplit: 1 }];
    worksheet.autoFilter = {
        from: 'A1',
        to: { column: columns.length, row: data.length + 1 }
    };
}

async function sendBackupEmail(branch_id, recipientEmail, filePath, fileName) {
    try {
        const emailConfig = await getEmailConfig(branch_id);

        if (!emailConfig) {
            console.error(`No default SMTP config found for branch ${branch_id}`);
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
        else if (fileExtension === '.json') mimeType = 'application/json';

        const mailOptions = {
            from,
            to: recipientEmail,
            subject: `OOMS Branch Backup - ${new Date().toLocaleDateString('en-GB')}`,
            html: `
                <h2>Database Backup Export Completed</h2>
                <p>Please find the attached database backup for your branch.</p>
                <p><strong>Backup File:</strong> ${fileName}</p>
                <p><strong>Generated on:</strong> ${new Date().toLocaleString()}</p>
                <hr>
                <p style="font-size: 11px; color: #666;">Generated securely by OOMS Backup System.</p>
            `,
            attachments: [{
                filename: fileName,
                path: filePath,
                contentType: mimeType
            }]
        };

        await transporter.sendMail(mailOptions);
        return true;
    } catch (error) {
        console.error("Failed to send backup email:", error);
        return false;
    }
}

// Generate CSV formatted contents concatenated
function generateBackupCSV(allDataSets) {
    let csvContent = "";
    for (const [sectionName, data] of Object.entries(allDataSets)) {
        if (!data || !data.length) continue;

        csvContent += `\n# =========================================================\n`;
        csvContent += `# SECTION: ${sectionName.toUpperCase()}\n`;
        csvContent += `# =========================================================\n`;

        const keys = Object.keys(data[0]);
        csvContent += keys.join(",") + "\n";

        for (const row of data) {
            const line = keys.map(key => {
                let val = row[key] !== undefined && row[key] !== null ? String(row[key]) : "";
                if (val.includes(",") || val.includes('"') || val.includes("\n") || val.includes("\r")) {
                    val = `"${val.replace(/"/g, '""').replace(/\n/g, ' ').replace(/\r/g, '')}"`;
                }
                return val;
            }).join(",");
            csvContent += line + "\n";
        }
    }
    return Buffer.from(csvContent, "utf8");
}

// Generate PDF Document
async function generateBackupPDF(allDataSets, branch_id) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const doc = new PDFDocument({
            margin: 40,
            size: "A4",
            layout: "landscape"
        });

        doc.on("data", chunk => chunks.push(chunk));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

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

        const tableLeft = 40;
        const tableWidth = doc.page.width - 80;

        const drawLine = (y, color = colors.border, lineWidth = 0.5) => {
            doc.strokeColor(color).lineWidth(lineWidth).moveTo(40, y).lineTo(doc.page.width - 40, y).stroke();
        };

        const drawHeader = (titleText) => {
            doc.rect(40, 30, doc.page.width - 80, 85).fill(colors.primary);
            doc.fillColor(colors.headerText)
                .fontSize(22)
                .font('Helvetica-Bold')
                .text(titleText, 55, 48, { align: 'left' });

            doc.fontSize(10)
                .font('Helvetica')
                .text(`Branch ID: ${branch_id} | Backup Date: ${new Date().toLocaleDateString('en-GB')}`, 55, 78, { align: 'left' });

            doc.fontSize(9)
                .font('Helvetica-Oblique')
                .text('OOMS Database Backup Report', doc.page.width - 200, 55, { align: 'right' });

            return 130;
        };

        // 1. Summary Cover Page
        let currentY = drawHeader("DATABASE BACKUP REPORT");

        doc.fillColor(colors.summaryBg)
            .rect(40, currentY, tableWidth, 90)
            .fill();

        doc.fillColor(colors.accent)
            .font('Helvetica-Bold')
            .fontSize(12)
            .text("BACKUP CONTENT SUMMARY", 55, currentY + 12);

        drawLine(currentY + 32, "#bbf7d0", 0.5);

        let summaryX = 55;
        let summaryY = currentY + 42;
        doc.fontSize(9).font("Helvetica").fillColor(colors.text);

        let totalRecordsCount = 0;
        Object.entries(allDataSets).forEach(([name, data]) => {
            totalRecordsCount += (data?.length || 0);
        });

        doc.text(`Total Tables Exported: ${Object.keys(allDataSets).length}`, summaryX, summaryY);
        doc.text(`Total Records Combined: ${totalRecordsCount}`, summaryX, summaryY + 16);

        summaryX = doc.page.width / 2;
        let countTemp = 0;
        Object.entries(allDataSets).forEach(([name, data]) => {
            doc.text(`• ${name}: ${data?.length || 0} rows`, summaryX, summaryY + (countTemp * 14));
            countTemp++;
        });

        const addFooter = (pageNum) => {
            const footerY = doc.page.height - 35;
            drawLine(footerY - 10, colors.border, 0.5);
            doc.fillColor(colors.textLight)
                .fontSize(7)
                .font('Helvetica-Oblique')
                .text(
                    `Generated by OOMS System • Page ${pageNum} • ${new Date().toLocaleString()}`,
                    40,
                    footerY,
                    { align: 'center', width: doc.page.width - 80 }
                );
        };

        addFooter(doc.page.number);

        // 2. Data Tables Sections
        Object.entries(allDataSets).forEach(([sectionName, data]) => {
            if (!data || !data.length) return;

            doc.addPage();
            let y = drawHeader(`${sectionName.toUpperCase()} DATA`);

            let columnsToDraw = [];
            if (sectionName === "Tasks") {
                columnsToDraw = [
                    { header: "Task ID", key: "task_id", width: 90 },
                    { header: "Service Name", key: "service_name", width: 150 },
                    { header: "Firm Name", key: "firm_name", width: 130 },
                    { header: "Client Name", key: "client_name", width: 130 },
                    { header: "Fees", key: "fees", width: 80 },
                    { header: "Total Amount", key: "total_amount", width: 90 },
                    { header: "Status", key: "status", width: 80 },
                    { header: "Due Date", key: "due_date", width: 90 },
                    { header: "Invoice No", key: "invoice_no", width: 100 }
                ];
            } else if (sectionName === "Clients") {
                columnsToDraw = [
                    { header: "Client Name", key: "client_name", width: 150 },
                    { header: "Email", key: "email", width: 160 },
                    { header: "Mobile", key: "mobile", width: 100 },
                    { header: "PAN", key: "pan_number", width: 100 },
                    { header: "Status", key: "status", width: 80 }
                ];
            } else if (sectionName === "Firms") {
                columnsToDraw = [
                    { header: "Firm Name", key: "firm_name", width: 160 },
                    { header: "Type", key: "firm_type", width: 90 },
                    { header: "GSTIN", key: "gst_no", width: 130 },
                    { header: "PAN", key: "pan_no", width: 100 },
                    { header: "Owner", key: "owner_name", width: 130 },
                    { header: "Status", key: "status", width: 70 }
                ];
            } else if (sectionName === "Transactions") {
                columnsToDraw = [
                    { header: "Date", key: "transaction_date", width: 90 },
                    { header: "From Party", key: "party_from", width: 130 },
                    { header: "To Party", key: "party_to", width: 130 },
                    { header: "Type", key: "transaction_type", width: 80 },
                    { header: "Amount", key: "amount", width: 90 },
                    { header: "Invoice No", key: "invoice_no", width: 100 },
                    { header: "Remark", key: "remark", width: 120 }
                ];
            } else if (sectionName === "Compliance Assignments") {
                columnsToDraw = [
                    { header: "Firm Name", key: "firm_name", width: 130 },
                    { header: "Service Name", key: "service_name", width: 140 },
                    { header: "Assigned Staff", key: "assigned_staff", width: 110 },
                    { header: "Quarters", key: "quarters", width: 90 },
                    { header: "Amount", key: "custom_amount", width: 80 },
                    { header: "Ack No", key: "ack_no", width: 90 },
                    { header: "Status", key: "status", width: 70 }
                ];
            } else if (sectionName === "Compliance Schedules") {
                columnsToDraw = [
                    { header: "Firm Name", key: "firm_name", width: 130 },
                    { header: "Service Name", key: "service_name", width: 140 },
                    { header: "FY", key: "financial_year", width: 70 },
                    { header: "Period", key: "period_name", width: 90 },
                    { header: "Amount", key: "amount", width: 80 },
                    { header: "Due Date", key: "due_date", width: 80 },
                    { header: "Invoice No", key: "invoice_no", width: 100 },
                    { header: "Status", key: "status", width: 90 }
                ];
            } else if (sectionName === "Invoices") {
                columnsToDraw = [
                    { header: "Invoice No", key: "invoice_no", width: 100 },
                    { header: "Date", key: "invoice_date", width: 90 },
                    { header: "Billing Type", key: "billing_type", width: 100 },
                    { header: "Subtotal", key: "subtotal", width: 90 },
                    { header: "Discount", key: "discount_value", width: 80 },
                    { header: "Tax Amt", key: "tax_value", width: 80 },
                    { header: "Total", key: "total", width: 90 },
                    { header: "Grand Total", key: "grand_total", width: 90 }
                ];
            } else if (sectionName === "Staff") {
                columnsToDraw = [
                    { header: "Staff Name", key: "staff_name", width: 160 },
                    { header: "Designation", key: "designation", width: 110 },
                    { header: "Email", key: "email", width: 160 },
                    { header: "Mobile", key: "mobile", width: 100 },
                    { header: "Status", key: "status", width: 70 }
                ];
            } else if (sectionName === "Attendance") {
                columnsToDraw = [
                    { header: "Date", key: "attendance_date", width: 90 },
                    { header: "Employee", key: "employee_name", width: 140 },
                    { header: "Check In", key: "check_in_time", width: 90 },
                    { header: "Check Out", key: "check_out_time", width: 90 },
                    { header: "Status", key: "status", width: 80 },
                    { header: "Salary", key: "salary_amount", width: 90 }
                ];
            } else {
                const firstRow = data[0];
                columnsToDraw = Object.keys(firstRow).slice(0, 6).map(key => ({
                    header: key.toUpperCase().replace(/_/g, ' '),
                    key: key,
                    width: 100
                }));
            }

            const totalWidth = columnsToDraw.reduce((sum, c) => sum + c.width, 0);
            if (totalWidth > tableWidth) {
                const ratio = tableWidth / totalWidth;
                columnsToDraw.forEach(c => c.width = Math.floor(c.width * ratio));
            }

            const drawTHeader = (curY) => {
                doc.fillColor(colors.headerBg)
                    .rect(tableLeft, curY, tableWidth, 25)
                    .fill();
                drawLine(curY, colors.headerBg, 1);

                doc.fillColor(colors.headerText)
                    .font('Helvetica-Bold')
                    .fontSize(8);

                let curX = tableLeft;
                columnsToDraw.forEach(col => {
                    doc.text(col.header, curX + 5, curY + 8, {
                        width: col.width - 10,
                        align: 'left'
                    });
                    curX += col.width;
                });

                drawLine(curY + 25, colors.borderDark, 0.8);
                return curY + 25;
            };

            y = drawTHeader(y);

            data.forEach((row, idx) => {
                if (y + 20 > doc.page.height - 50) {
                    addFooter(doc.page.number);
                    doc.addPage();
                    y = drawHeader(`${sectionName.toUpperCase()} DATA (CONTINUED)`);
                    y = drawTHeader(y);
                }

                const isEven = idx % 2 === 0;
                doc.fillColor(isEven ? colors.rowEven : colors.rowOdd)
                    .rect(tableLeft, y, tableWidth, 20)
                    .fill();

                drawLine(y + 20, colors.border, 0.3);

                doc.fillColor(colors.text)
                    .font('Helvetica')
                    .fontSize(7);

                let curX = tableLeft;
                columnsToDraw.forEach(col => {
                    let val = row[col.key] !== undefined && row[col.key] !== null ? String(row[col.key]) : "-";
                    const maxChars = Math.floor((col.width - 10) / 4.5);
                    if (val.length > maxChars && maxChars > 10) {
                        val = val.substring(0, maxChars - 3) + "...";
                    }
                    doc.text(val, curX + 5, y + 6, {
                        width: col.width - 10,
                        align: 'left'
                    });
                    curX += col.width;
                });

                y += 20;
            });

            drawLine(y, colors.borderDark, 0.8);
            addFooter(doc.page.number);
        });

        doc.end();
    });
}

// ==================== BACKUP ENDPOINTS ====================

// 1. GET /api/v1/backup/summary - counts list for branch
router.get("/summary", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;

        // Dynamic column validation to prevent query failures
        const hasTasksDeleted = await tableHasColumn("tasks", "is_deleted");
        const hasTxDeleted = await tableHasColumn("transactions", "is_deleted");
        const hasInvDeleted = await tableHasColumn("invoice", "is_deleted");
        const hasAttDeleted = await tableHasColumn("attendance", "is_deleted");

        // Tasks Count
        let tasksQuery = "SELECT COUNT(*) AS total FROM tasks WHERE branch_id = ?";
        if (hasTasksDeleted) tasksQuery += " AND is_deleted = '0'";
        const [[tasksCount]] = await pool.query(tasksQuery, [branch_id]);

        // Clients & Firms Count
        const [[clientsCount]] = await pool.query("SELECT COUNT(*) AS total FROM clients WHERE branch_id = ? AND is_deleted = '0'", [branch_id]);
        const [[firmsCount]] = await pool.query("SELECT COUNT(*) AS total FROM firms WHERE branch_id = ? AND is_deleted = '0'", [branch_id]);
        const clientsTotal = (clientsCount?.total || 0) + (firmsCount?.total || 0);

        // Finance Transactions Count
        let txQuery = "SELECT COUNT(*) AS total FROM transactions WHERE branch_id = ?";
        if (hasTxDeleted) txQuery += " AND is_deleted = '0'";
        const [[financeCount]] = await pool.query(txQuery, [branch_id]);

        // Recurring Tasks (Assignments & Schedules) Count
        const [[assignmentsCount]] = await pool.query(
            `SELECT COUNT(*) AS total 
             FROM compliance_assignments ca 
             INNER JOIN firms f ON ca.firm_id = f.firm_id AND f.branch_id = ? AND f.is_deleted = '0'`,
            [branch_id]
        );
        const [[schedulesCount]] = await pool.query(
            `SELECT COUNT(*) AS total 
             FROM compliance_schedules cs 
             INNER JOIN compliance_assignments ca ON cs.assignment_id = ca.assignment_id 
             INNER JOIN firms f ON ca.firm_id = f.firm_id AND f.branch_id = ? AND f.is_deleted = '0'`,
            [branch_id]
        );
        const recurringTotal = (assignmentsCount?.total || 0) + (schedulesCount?.total || 0);

        // Billing Invoices Count
        let billingQuery = "SELECT COUNT(*) AS total FROM invoice WHERE branch_id = ?";
        if (hasInvDeleted) billingQuery += " AND is_deleted = '0'";
        const [[billingCount]] = await pool.query(billingQuery, [branch_id]);

        // Staff & Attendance Count
        const [[staffCount]] = await pool.query(
            `SELECT COUNT(*) AS total 
             FROM branch_mapping bm 
             INNER JOIN profile p ON bm.username = p.username 
             WHERE bm.branch_id = ? AND bm.is_deleted = '0'`,
            [branch_id]
        );
        let attendanceQuery = "SELECT COUNT(*) AS total FROM attendance WHERE branch_id = ?";
        if (hasAttDeleted) attendanceQuery += " AND is_deleted = '0'";
        const [[attendanceCount]] = await pool.query(attendanceQuery, [branch_id]);
        const staffTotal = (staffCount?.total || 0) + (attendanceCount?.total || 0);

        return res.json({
            success: true,
            message: "Backup summary retrieved successfully",
            data: {
                tasks: { title: "Tasks", count: tasksCount?.total || 0, description: "Branch tasks, descriptions, and statuses" },
                clients: { title: "Clients & Firms", count: clientsTotal, description: "Branch clients, profiles, and associated firms" },
                finance: { title: "Finance Transactions", count: financeCount?.total || 0, description: "Financial ledger transactions" },
                recurring_tasks: { title: "Recurring Tasks & Schedules", count: recurringTotal, description: "Compliance assignments and recurring calendar schedules" },
                billing: { title: "Billing Invoices", count: billingCount?.total || 0, description: "Generated billing invoices" },
                staff_management: { title: "Staff & Attendance", count: staffTotal, description: "Active staff mapping list and daily attendance logs" }
            }
        });
    } catch (error) {
        console.error("Backup summary retrieval error:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// 2. POST /api/v1/backup/run - execute backup and export
router.post("/run", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { sections, export_type, delivery_method, recipient_email } = req.body;

        // Validation
        if (!export_type || !['excel', 'csv', 'pdf', 'json'].includes(export_type)) {
            return res.status(400).json({ success: false, message: "export_type must be 'excel', 'csv', 'pdf', or 'json'" });
        }
        if (!delivery_method || !['download', 'email'].includes(delivery_method)) {
            return res.status(400).json({ success: false, message: "delivery_method must be 'download' or 'email'" });
        }
        if (delivery_method === 'email') {
            if (!recipient_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient_email)) {
                return res.status(400).json({ success: false, message: "Valid recipient_email is required for email delivery" });
            }
            const emailConfig = await getEmailConfig(branch_id);
            if (!emailConfig) {
                return res.status(400).json({ success: false, message: "No active default SMTP configuration found for this branch. Please set it up or choose the local download option." });
            }
        }

        const validSections = ["tasks", "clients", "finance", "recurring_tasks", "billing", "staff_management"];
        let sectionsToBackup = [];

        if (sections === "all" || (Array.isArray(sections) && sections.includes("all"))) {
            sectionsToBackup = validSections;
        } else if (Array.isArray(sections)) {
            sectionsToBackup = sections.filter(s => validSections.includes(s));
        }

        if (sectionsToBackup.length === 0) {
            return res.status(400).json({ success: false, message: "At least one valid backup section must be selected" });
        }

        // Check columns to apply correct queries
        const hasTasksDeleted = await tableHasColumn("tasks", "is_deleted");
        const hasTxDeleted = await tableHasColumn("transactions", "is_deleted");
        const hasInvDeleted = await tableHasColumn("invoice", "is_deleted");
        const hasAttDeleted = await tableHasColumn("attendance", "is_deleted");

        const allDataSets = {};

        // Query data for selected sections
        if (sectionsToBackup.includes("tasks")) {
            let tasksQuery = `
                SELECT 
                    t.task_id, 
                    s.name AS service_name, 
                    f.firm_name, 
                    p.name AS client_name, 
                    t.fees, 
                    t.total AS total_amount, 
                    t.status, 
                    t.due_date, 
                    t.invoice_no
                FROM tasks t
                LEFT JOIN services s ON t.service_id = s.service_id
                LEFT JOIN firms f ON t.firm_id = f.firm_id
                LEFT JOIN profile p ON t.username = p.username
                WHERE t.branch_id = ?`;
            if (hasTasksDeleted) tasksQuery += " AND t.is_deleted = '0'";
            const [tasks] = await pool.query(tasksQuery, [branch_id]);
            allDataSets["Tasks"] = tasks;
        }

        if (sectionsToBackup.includes("clients")) {
            const [clients] = await pool.query(
                `SELECT p.name AS client_name, p.email, p.mobile, p.pan_number, 
                        CASE WHEN c.status = '1' THEN 'Active' ELSE 'Inactive' END AS status, 
                        c.create_date AS registered_date
                 FROM clients c 
                 LEFT JOIN profile p ON c.username = p.username 
                 WHERE c.branch_id = ? AND c.is_deleted = '0'`,
                [branch_id]
            );
            const [firms] = await pool.query(
                `SELECT f.firm_name, f.firm_type, f.gst_no, f.pan_no, p.name AS owner_name, 
                        CASE WHEN f.status = '1' THEN 'Active' ELSE 'Inactive' END AS status
                 FROM firms f
                 LEFT JOIN profile p ON f.username = p.username
                 WHERE f.branch_id = ? AND f.is_deleted = '0'`,
                [branch_id]
            );
            allDataSets["Clients"] = clients;
            allDataSets["Firms"] = firms;
        }

        if (sectionsToBackup.includes("finance")) {
            let txQuery = `
                SELECT 
                    t.transaction_date, 
                    t.amount, 
                    t.transaction_type, 
                    t.invoice_no, 
                    CASE 
                        WHEN t.party1_type = 'firm' THEN (SELECT firm_name FROM firms WHERE firm_id = t.party1_id LIMIT 1)
                        WHEN t.party1_type = 'client' THEN (SELECT name FROM profile WHERE username = t.party1_id LIMIT 1)
                        ELSE t.party1_id 
                    END AS party_from,
                    CASE 
                        WHEN t.party2_type = 'firm' THEN (SELECT firm_name FROM firms WHERE firm_id = t.party2_id LIMIT 1)
                        WHEN t.party2_type = 'client' THEN (SELECT name FROM profile WHERE username = t.party2_id LIMIT 1)
                        ELSE t.party2_id 
                    END AS party_to,
                    t.remark
                FROM transactions t
                WHERE t.branch_id = ?`;
            if (hasTxDeleted) txQuery += " AND t.is_deleted = '0'";
            const [transactions] = await pool.query(txQuery, [branch_id]);
            allDataSets["Transactions"] = transactions;
        }

        if (sectionsToBackup.includes("recurring_tasks")) {
            const [assignments] = await pool.query(
                `SELECT f.firm_name, s.name AS service_name, ca.employee_username AS assigned_staff, 
                        ca.quarters, ca.custom_amount, ca.ack_no, 
                        CASE WHEN ca.status = 'active' THEN 'Active' ELSE 'Inactive' END AS status
                 FROM compliance_assignments ca 
                 INNER JOIN firms f ON ca.firm_id = f.firm_id AND f.branch_id = ? AND f.is_deleted = '0' 
                 INNER JOIN services s ON ca.service_id = s.service_id`,
                [branch_id]
            );
            const [schedules] = await pool.query(
                `SELECT f.firm_name, s.name AS service_name, cs.financial_year, cs.period_name, 
                        cs.amount, cs.due_date, cs.invoice_no, cs.status
                 FROM compliance_schedules cs 
                 INNER JOIN compliance_assignments ca ON cs.assignment_id = ca.assignment_id 
                 INNER JOIN firms f ON ca.firm_id = f.firm_id AND f.branch_id = ? AND f.is_deleted = '0' 
                 INNER JOIN services s ON ca.service_id = s.service_id`,
                [branch_id]
            );
            allDataSets["Compliance Assignments"] = assignments;
            allDataSets["Compliance Schedules"] = schedules;
        }

        if (sectionsToBackup.includes("billing")) {
            let billingQuery = `
                SELECT 
                    invoice_no, 
                    create_date AS invoice_date, 
                    type AS billing_type, 
                    subtotal, 
                    discount_value, 
                    tax_value, 
                    total, 
                    grand_total
                FROM invoice 
                WHERE branch_id = ?`;
            if (hasInvDeleted) billingQuery += " AND is_deleted = '0'";
            const [invoices] = await pool.query(billingQuery, [branch_id]);
            allDataSets["Invoices"] = invoices;
        }

        if (sectionsToBackup.includes("staff_management")) {
            const [staff] = await pool.query(
                `SELECT p.name AS staff_name, bm.designation, p.email, p.mobile, 
                        CASE WHEN bm.status = '1' THEN 'Active' ELSE 'Inactive' END AS status
                 FROM branch_mapping bm 
                 INNER JOIN profile p ON bm.username = p.username 
                 WHERE bm.branch_id = ? AND bm.is_deleted = '0'`,
                [branch_id]
            );
            let attendanceQuery = `
                SELECT p.name AS employee_name, DATE(a.punch_in_time) AS attendance_date, 
                       TIME(a.punch_in_time) AS check_in_time, TIME(a.punch_out_time) AS check_out_time, 
                       a.attendance_status AS status, a.final_calculated_amount AS salary_amount
                FROM attendance a 
                LEFT JOIN profile p ON a.username = p.username 
                WHERE a.branch_id = ?`;
            if (hasAttDeleted) attendanceQuery += " AND a.is_deleted = '0'";
            const [attendance] = await pool.query(attendanceQuery, [branch_id]);
            allDataSets["Staff"] = staff;
            allDataSets["Attendance"] = attendance;
        }

        // Generate file based on export_type
        let fileBuffer;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const ext = export_type === 'excel' ? 'xlsx' : export_type;
        const fileName = `backup_${branch_id}_${timestamp}.${ext}`;
        const filePath = path.join(EXPORT_DIR, fileName);

        if (export_type === 'excel') {
            const workbook = new ExcelJS.Workbook();
            Object.entries(allDataSets).forEach(([sheetName, data]) => {
                if (!data || !data.length) return;
                const worksheet = workbook.addWorksheet(sheetName);
                const columns = Object.keys(data[0]).map(key => ({
                    header: key.toUpperCase().replace(/_/g, ' '),
                    key: key,
                    width: 20
                }));
                styleWorksheet(worksheet, data, columns, sheetName);
            });
            fileBuffer = await workbook.xlsx.writeBuffer();
        } else if (export_type === 'csv') {
            fileBuffer = generateBackupCSV(allDataSets);
        } else if (export_type === 'pdf') {
            fileBuffer = await generateBackupPDF(allDataSets, branch_id);
        } else if (export_type === 'json') {
            fileBuffer = Buffer.from(JSON.stringify(allDataSets, null, 4), "utf8");
        }

        // Save file to export directory
        fs.writeFileSync(filePath, fileBuffer);

        if (delivery_method === 'email') {
            // Send via SMTP
            const sent = await sendBackupEmail(branch_id, recipient_email, filePath, fileName);
            if (!sent) {
                return res.status(500).json({ success: false, message: "Backup file generated but failed to send email. Check SMTP settings." });
            }
            return res.json({
                success: true,
                message: "Backup completed and exported via email successfully."
            });
        } else {
            // Local download URL
            const downloadUrl = `/api/v1/backup/download/${fileName}`;
            return res.json({
                success: true,
                message: "Backup completed successfully.",
                data: {
                    download_url: downloadUrl,
                    file_name: fileName
                }
            });
        }

    } catch (error) {
        console.error("Backup execution error:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// 3. GET /api/v1/backup/download/:fileName - secure local file download
router.get("/download/:fileName", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const safeFileName = path.basename(req.params.fileName);

        // Access Control Check: Ensure file name matches current branch pattern
        if (!safeFileName.startsWith(`backup_${branch_id}_`)) {
            return res.status(403).json({ success: false, message: "Access denied: Unauthorized access to this backup file." });
        }

        const filePath = path.join(EXPORT_DIR, safeFileName);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, message: "Backup file not found or expired." });
        }

        return res.download(filePath, safeFileName);
    } catch (error) {
        console.error("Backup download error:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// 4. POST /api/v1/backup/import - import JSON backup data
router.post("/import", auth, validateBranch, (req, res) => {
    upload(req, res, async (err) => {
        if (err) {
            return res.status(400).json({ success: false, message: err.message });
        }

        let importData;
        try {
            if (req.file) {
                importData = JSON.parse(req.file.buffer.toString("utf8"));
            } else if (req.body && typeof req.body === "object") {
                importData = req.body;
            }

            if (!importData || Object.keys(importData).length === 0) {
                return res.status(400).json({ success: false, message: "No data found for import" });
            }
        } catch (parseError) {
            return res.status(400).json({ success: false, message: "Invalid JSON format in backup file" });
        }

        const branch_id = req.branch_id;
        const connection = await pool.getConnection();

        try {
            await connection.beginTransaction();

            const helperNewId = (prefix) => {
                return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
            };

            // Helper: get or create profile
            const getOrCreateProfile = async (name, email, mobile, userType, panNumber = null) => {
                if (!name) return null;
                const [existing] = await connection.query(
                    "SELECT username FROM profile WHERE email = ? OR mobile = ? OR name = ? LIMIT 1",
                    [email || "", mobile || "", name]
                );
                if (existing && existing.length > 0) {
                    return existing[0].username;
                }
                const newUsername = `${userType}_${crypto.randomBytes(6).toString("hex")}`;
                const profileId = helperNewId("profile");
                await connection.query(
                    `INSERT INTO profile (profile_id, username, name, email, mobile, user_type, pan_number, status) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, '1')`,
                    [profileId, newUsername, name, email || "", mobile || "", userType, panNumber]
                );
                return newUsername;
            };

            // 1. Staff Import
            if (importData.Staff && Array.isArray(importData.Staff)) {
                for (const staff of importData.Staff) {
                    const { staff_name, designation, email, mobile, status } = staff;
                    if (!staff_name) continue;
                    const username = await getOrCreateProfile(staff_name, email, mobile, 'staff');
                    const isStaffActive = status === 'Active' ? '1' : '0';

                    const [existingMap] = await connection.query(
                        "SELECT id FROM branch_mapping WHERE branch_id = ? AND username = ? LIMIT 1",
                        [branch_id, username]
                    );

                    if (existingMap && existingMap.length > 0) {
                        await connection.query(
                            "UPDATE branch_mapping SET designation = ?, status = ?, is_deleted = '0' WHERE branch_id = ? AND username = ?",
                            [designation || "", isStaffActive, branch_id, username]
                        );
                    } else {
                        const mapId = helperNewId("bm");
                        await connection.query(
                            `INSERT INTO branch_mapping (branch_id, map_id, username, designation, type, status, is_deleted) 
                             VALUES (?, ?, ?, ?, 'staff', ?, '0')`,
                            [branch_id, mapId, username, designation || "", isStaffActive]
                        );
                    }
                }
            }

            // 2. Clients Import
            if (importData.Clients && Array.isArray(importData.Clients)) {
                for (const client of importData.Clients) {
                    const { client_name, email, mobile, pan_number, status } = client;
                    if (!client_name) continue;
                    const username = await getOrCreateProfile(client_name, email, mobile, 'client', pan_number);
                    const isClientActive = status === 'Active' ? '1' : '0';

                    const [existingClient] = await connection.query(
                        "SELECT id FROM clients WHERE branch_id = ? AND username = ? LIMIT 1",
                        [branch_id, username]
                    );

                    if (existingClient && existingClient.length > 0) {
                        await connection.query(
                            "UPDATE clients SET status = ?, is_deleted = '0' WHERE branch_id = ? AND username = ?",
                            [isClientActive, branch_id, username]
                        );
                    } else {
                        await connection.query(
                            "INSERT INTO clients (branch_id, username, status, is_deleted) VALUES (?, ?, ?, '0')",
                            [branch_id, username, isClientActive]
                        );
                    }
                }
            }

            // 3. Firms Import
            if (importData.Firms && Array.isArray(importData.Firms)) {
                for (const firm of importData.Firms) {
                    const { firm_name, firm_type, gst_no, pan_no, owner_name, status } = firm;
                    if (!firm_name) continue;
                    const username = await getOrCreateProfile(owner_name || "Client Name Placeholder", "", "", 'client');
                    const isFirmActive = status === 'Active' ? '1' : '0';

                    const [existingFirm] = await connection.query(
                        "SELECT firm_id FROM firms WHERE branch_id = ? AND (firm_name = ? OR (gst_no != '' AND gst_no = ?) OR (pan_no != '' AND pan_no = ?)) LIMIT 1",
                        [branch_id, firm_name, gst_no || "", pan_no || ""]
                    );

                    if (existingFirm && existingFirm.length > 0) {
                        const firmId = existingFirm[0].firm_id;
                        await connection.query(
                            `UPDATE firms 
                             SET firm_type = ?, gst_no = ?, pan_no = ?, username = ?, status = ?, is_deleted = '0' 
                             WHERE firm_id = ? AND branch_id = ?`,
                            [firm_type || "", gst_no || "", pan_no || "", username, isFirmActive, firmId, branch_id]
                        );
                    } else {
                        const firmId = helperNewId("firm");
                        await connection.query(
                            `INSERT INTO firms (branch_id, firm_id, username, firm_name, firm_type, gst_no, pan_no, status, is_deleted) 
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, '0')`,
                            [branch_id, firmId, username, firm_name, firm_type || "", gst_no || "", pan_no || "", isFirmActive]
                        );
                    }
                }
            }

            // Helper to find firm_id by firm_name
            const getFirmIdByName = async (firmName) => {
                if (!firmName) return null;
                const [rows] = await connection.query(
                    "SELECT firm_id FROM firms WHERE branch_id = ? AND firm_name = ? LIMIT 1",
                    [branch_id, firmName]
                );
                return rows && rows.length > 0 ? rows[0].firm_id : null;
            };

            // Helper to get service_id or create one if not found
            const getOrCreateService = async (serviceName) => {
                if (!serviceName) return null;
                const [rows] = await connection.query(
                    "SELECT service_id FROM services WHERE name = ? LIMIT 1",
                    [serviceName]
                );
                if (rows && rows.length > 0) {
                    return rows[0].service_id;
                }
                const serviceId = helperNewId("srv");
                await connection.query(
                    "INSERT INTO services (service_id, name) VALUES (?, ?)",
                    [serviceId, serviceName]
                );
                return serviceId;
            };

            // Helper to get username by profile name
            const getUsernameByProfileName = async (name) => {
                if (!name) return null;
                const [rows] = await connection.query(
                    "SELECT username FROM profile WHERE name = ? LIMIT 1",
                    [name]
                );
                return rows && rows.length > 0 ? rows[0].username : null;
            };

            // 4. Tasks Import
            if (importData.Tasks && Array.isArray(importData.Tasks)) {
                for (const task of importData.Tasks) {
                    const { task_id, service_name, firm_name, client_name, fees, total_amount, status, due_date, invoice_no } = task;
                    if (!task_id) continue;

                    const serviceId = await getOrCreateService(service_name);
                    const firmId = await getFirmIdByName(firm_name);
                    const username = await getUsernameByProfileName(client_name);

                    const [existingTask] = await connection.query(
                        "SELECT id FROM tasks WHERE branch_id = ? AND task_id = ? LIMIT 1",
                        [branch_id, task_id]
                    );

                    if (existingTask && existingTask.length > 0) {
                        await connection.query(
                            `UPDATE tasks 
                             SET service_id = ?, firm_id = ?, username = ?, fees = ?, total = ?, status = ?, due_date = ?, invoice_no = ? 
                             WHERE branch_id = ? AND task_id = ?`,
                            [serviceId, firmId, username, fees || 0, total_amount || 0, status || 'in process', due_date || null, invoice_no || null, branch_id, task_id]
                        );
                    } else {
                        await connection.query(
                            `INSERT INTO tasks (branch_id, task_id, service_id, firm_id, username, fees, total, status, due_date, invoice_no) 
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [branch_id, task_id, serviceId, firmId, username, fees || 0, total_amount || 0, status || 'in process', due_date || null, invoice_no || null]
                        );
                    }
                }
            }

            // 5. Transactions Import
            if (importData.Transactions && Array.isArray(importData.Transactions)) {
                for (const tx of importData.Transactions) {
                    const { transaction_date, amount, transaction_type, invoice_no, party_from, party_to, remark } = tx;

                    // Resolve party 1 (from)
                    let party1_id = party_from;
                    let party1_type = 'other';
                    const firmFromId = await getFirmIdByName(party_from);
                    if (firmFromId) {
                        party1_id = firmFromId;
                        party1_type = 'firm';
                    } else {
                        const userFrom = await getUsernameByProfileName(party_from);
                        if (userFrom) {
                            party1_id = userFrom;
                            party1_type = 'client';
                        }
                    }

                    // Resolve party 2 (to)
                    let party2_id = party_to;
                    let party2_type = 'other';
                    const firmToId = await getFirmIdByName(party_to);
                    if (firmToId) {
                        party2_id = firmToId;
                        party2_type = 'firm';
                    } else {
                        const userTo = await getUsernameByProfileName(party_to);
                        if (userTo) {
                            party2_id = userTo;
                            party2_type = 'client';
                        }
                    }

                    const txId = helperNewId("tx");
                    await connection.query(
                        `INSERT INTO transactions (branch_id, transaction_id, transaction_date, amount, transaction_type, invoice_no, party1_id, party1_type, party2_id, party2_type, remark) 
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [branch_id, txId, transaction_date || null, amount || 0, transaction_type || "", invoice_no || null, party1_id, party1_type, party2_id, party2_type, remark || ""]
                    );
                }
            }

            // 6. Compliance Assignments Import
            if (importData["Compliance Assignments"] && Array.isArray(importData["Compliance Assignments"])) {
                for (const assignment of importData["Compliance Assignments"]) {
                    const { firm_name, service_name, assigned_staff, quarters, custom_amount, ack_no, status } = assignment;
                    const firmId = await getFirmIdByName(firm_name);
                    const serviceId = await getOrCreateService(service_name);
                    if (!firmId || !serviceId) continue;

                    const staffUsername = await getUsernameByProfileName(assigned_staff);
                    const isAssignmentActive = status === 'Active' ? 'active' : 'inactive';

                    const [existingAssign] = await connection.query(
                        "SELECT assignment_id FROM compliance_assignments WHERE firm_id = ? AND service_id = ? LIMIT 1",
                        [firmId, serviceId]
                    );

                    if (existingAssign && existingAssign.length > 0) {
                        await connection.query(
                            `UPDATE compliance_assignments 
                             SET employee_username = ?, quarters = ?, custom_amount = ?, ack_no = ?, status = ? 
                             WHERE assignment_id = ?`,
                            [staffUsername, quarters || "", custom_amount || 0, ack_no || "", isAssignmentActive, existingAssign[0].assignment_id]
                        );
                    } else {
                        const assignId = helperNewId("assign");
                        await connection.query(
                            `INSERT INTO compliance_assignments (assignment_id, firm_id, service_id, employee_username, quarters, custom_amount, ack_no, status, create_date) 
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
                            [assignId, firmId, serviceId, staffUsername, quarters || "", custom_amount || 0, ack_no || "", isAssignmentActive]
                        );
                    }
                }
            }

            // Helper to look up assignment_id
            const getAssignmentId = async (firmName, serviceName) => {
                const firmId = await getFirmIdByName(firmName);
                const serviceId = await getOrCreateService(serviceName);
                if (!firmId || !serviceId) return null;
                const [rows] = await connection.query(
                    "SELECT assignment_id FROM compliance_assignments WHERE firm_id = ? AND service_id = ? LIMIT 1",
                    [firmId, serviceId]
                );
                return rows && rows.length > 0 ? rows[0].assignment_id : null;
            };

            // 7. Compliance Schedules Import
            if (importData["Compliance Schedules"] && Array.isArray(importData["Compliance Schedules"])) {
                for (const sched of importData["Compliance Schedules"]) {
                    const { firm_name, service_name, financial_year, period_name, amount, due_date, invoice_no, status } = sched;
                    const assignmentId = await getAssignmentId(firm_name, service_name);
                    if (!assignmentId) continue;

                    const [existingSched] = await connection.query(
                        "SELECT schedule_id FROM compliance_schedules WHERE assignment_id = ? AND financial_year = ? AND period_name = ? LIMIT 1",
                        [assignmentId, financial_year, period_name]
                    );

                    if (existingSched && existingSched.length > 0) {
                        await connection.query(
                            `UPDATE compliance_schedules 
                             SET amount = ?, due_date = ?, invoice_no = ?, status = ? 
                             WHERE schedule_id = ?`,
                            [amount || 0, due_date || null, invoice_no || null, status || 'Pending From The Department', existingSched[0].schedule_id]
                        );
                    } else {
                        const scheduleId = helperNewId("sched");
                        await connection.query(
                            `INSERT INTO compliance_schedules (schedule_id, assignment_id, financial_year, period_name, amount, due_date, invoice_no, status) 
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                            [scheduleId, assignmentId, financial_year, period_name, amount || 0, due_date || null, invoice_no || null, status || 'Pending From The Department']
                        );
                    }
                }
            }

            // 8. Invoices Import
            if (importData.Invoices && Array.isArray(importData.Invoices)) {
                for (const inv of importData.Invoices) {
                    const { invoice_no, invoice_date, billing_type, subtotal, discount_value, tax_value, total, grand_total } = inv;
                    if (!invoice_no) continue;

                    const [existingInv] = await connection.query(
                        "SELECT invoice_id FROM invoice WHERE branch_id = ? AND invoice_no = ? LIMIT 1",
                        [branch_id, invoice_no]
                    );

                    if (existingInv && existingInv.length > 0) {
                        await connection.query(
                            `UPDATE invoice 
                             SET create_date = ?, type = ?, subtotal = ?, discount_value = ?, tax_value = ?, total = ?, grand_total = ? 
                             WHERE branch_id = ? AND invoice_no = ?`,
                            [invoice_date || null, billing_type || "", subtotal || 0, discount_value || 0, tax_value || 0, total || 0, grand_total || 0, branch_id, invoice_no]
                        );
                    } else {
                        const invoiceId = helperNewId("inv");
                        await connection.query(
                            `INSERT INTO invoice (branch_id, invoice_id, invoice_no, create_date, type, subtotal, discount_value, tax_value, total, grand_total) 
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [branch_id, invoiceId, invoice_no, invoice_date || null, billing_type || "", subtotal || 0, discount_value || 0, tax_value || 0, total || 0, grand_total || 0]
                        );
                    }
                }
            }

            // 9. Attendance Import
            if (importData.Attendance && Array.isArray(importData.Attendance)) {
                for (const att of importData.Attendance) {
                    const { attendance_date, employee_name, check_in_time, check_out_time, status, salary_amount } = att;
                    const username = await getUsernameByProfileName(employee_name);
                    if (!username || !attendance_date) continue;

                    const [existingAtt] = await connection.query(
                        "SELECT attendance_id FROM attendance WHERE branch_id = ? AND username = ? AND DATE(punch_in_time) = ? LIMIT 1",
                        [branch_id, username, attendance_date]
                    );

                    const punchInStr = check_in_time ? `${attendance_date} ${check_in_time}` : `${attendance_date} 00:00:00`;
                    const punchOutStr = check_out_time ? `${attendance_date} ${check_out_time}` : null;

                    if (existingAtt && existingAtt.length > 0) {
                        await connection.query(
                            `UPDATE attendance 
                             SET punch_in_time = ?, punch_out_time = ?, attendance_status = ?, final_calculated_amount = ?, is_deleted = '0' 
                             WHERE attendance_id = ?`,
                            [punchInStr, punchOutStr, status || 'pending', salary_amount || 0, existingAtt[0].attendance_id]
                        );
                    } else {
                        const attId = helperNewId("att");
                        await connection.query(
                            `INSERT INTO attendance (branch_id, attendance_id, username, punch_in_time, punch_out_time, attendance_status, final_calculated_amount, is_deleted) 
                             VALUES (?, ?, ?, ?, ?, ?, ?, '0')`,
                            [branch_id, attId, username, punchInStr, punchOutStr, status || 'pending', salary_amount || 0]
                        );
                    }
                }
            }

            await connection.commit();
            return res.json({ success: true, message: "Backup data imported and restored successfully" });

        } catch (txError) {
            await connection.rollback();
            console.error("Backup import transaction error:", txError);
            return res.status(500).json({ success: false, message: `Import transaction failed: ${txError.message}` });
        } finally {
            connection.release();
        }
    });
});

export default router;
