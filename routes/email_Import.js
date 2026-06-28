// /www/wwwroot/ooms-api/routes/email_Import.js

import express from "express";
import multer from "multer";
import xlsx from "xlsx";
import crypto from "crypto";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";

// Create router FIRST
const router = express.Router();

// Helper functions
function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function newId(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function ok(res, message, data = {}, pagination) {
    return res.json({ success: true, message, data, ...(pagination ? { pagination } : {}) });
}

function fail(res, message, code = 400) {
    return res.status(code).json({ success: false, message });
}

// Configure multer
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.includes('csv') || 
            file.mimetype.includes('spreadsheet') ||
            file.originalname.match(/\.(csv|xls|xlsx)$/)) {
            cb(null, true);
        } else {
            cb(new Error('Only CSV and Excel files allowed'));
        }
    }
}).single('file');

// Parse CSV line
function parseCSVLine(line) {
    const result = [];
    let inQuote = false;
    let currentValue = '';
    
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            inQuote = !inQuote;
        } else if (char === ',' && !inQuote) {
            result.push(currentValue.trim().replace(/^"|"$/g, ''));
            currentValue = '';
        } else {
            currentValue += char;
        }
    }
    result.push(currentValue.trim().replace(/^"|"$/g, ''));
    return result;
}

// Detect column mappings
function detectColumnMappings(headers) {
    const mappings = { email: null, name: null, variables: {} };
    const emailPatterns = ['email', 'e-mail', 'mail', 'email address', 'e_mail', 'emailid', 'email_id'];
    const namePatterns = ['name', 'full name', 'fullname', 'client name', 'customer name', 'person name', 'first_name', 'last_name', 'recipient_name'];
    
    for (const header of headers) {
        const lowerHeader = String(header || '').toLowerCase().trim();
        if (!mappings.email && emailPatterns.some(p => lowerHeader === p || lowerHeader.includes(p))) {
            mappings.email = header;
        } else if (!mappings.name && namePatterns.some(p => lowerHeader === p || lowerHeader.includes(p))) {
            mappings.name = header;
        } else if (header && header !== mappings.email && header !== mappings.name) {
            mappings.variables[header] = header;
        }
    }
    return mappings;
}

// Upload endpoint
router.post("/upload-recipients", auth, validateBranch, (req, res) => {
    upload(req, res, async (err) => {
        if (err) return fail(res, err.message);
        if (!req.file) return fail(res, "Please upload a file");
        
        try {
            const branch_id = req.branch_id;
            const isPreview = req.query.preview === 'true';
            const fileBuffer = req.file.buffer;
            const originalName = req.file.originalname;
            const isCSV = originalName.toLowerCase().endsWith('.csv');
            
            let headers = [];
            let rows = [];
            
            if (isCSV) {
                const content = fileBuffer.toString('utf-8');
                const lines = content.split(/\r?\n/);
                if (lines.length === 0) return fail(res, "Empty file");
                headers = parseCSVLine(lines[0]);
                for (let i = 1; i < lines.length; i++) {
                    if (!lines[i].trim()) continue;
                    const values = parseCSVLine(lines[i]);
                    const row = {};
                    headers.forEach((h, idx) => { row[h] = values[idx] || ''; });
                    rows.push(row);
                }
            } else {
                const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                const data = xlsx.utils.sheet_to_json(sheet);
                rows = data;
                if (rows.length > 0) headers = Object.keys(rows[0]);
            }
            
            const detectedMappings = detectColumnMappings(headers);
            if (!detectedMappings.email) {
                return fail(res, "Could not detect email column. Please ensure your file has columns like: email, e-mail, mail, etc.");
            }
            
            const recipients = [];
            const errors = [];
            
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const email = row[detectedMappings.email]?.toString().trim();
                if (!email || !isValidEmail(email)) {
                    errors.push({ row: i + 2, email: email || 'MISSING', error: 'Invalid email' });
                    continue;
                }
                const recipient = {
                    recipient_email: email,
                    recipient_name: detectedMappings.name ? (row[detectedMappings.name]?.toString().trim() || null) : null,
                    variable_values_json: {}
                };
                for (const varCol of Object.keys(detectedMappings.variables)) {
                    const value = row[varCol];
                    if (value !== undefined && value !== null && value !== '') {
                        recipient.variable_values_json[varCol] = value.toString();
                    }
                }
                recipients.push(recipient);
            }
            
            if (isPreview) {
                return ok(res, "File preview", {
                    headers: headers,
                    detected_mappings: {
                        email_column: detectedMappings.email,
                        name_column: detectedMappings.name,
                        variable_columns: Object.keys(detectedMappings.variables)
                    },
                    summary: {
                        total_rows: rows.length,
                        valid_recipients: recipients.length,
                        invalid_entries: errors.length
                    },
                    preview: recipients.slice(0, 10),
                    errors: errors.slice(0, 20)
                });
            }
            
            // Store in global
            if (!global.uploadedRecipients) global.uploadedRecipients = new Map();
            global.uploadedRecipients.set(branch_id, {
                recipients,
                detectedMappings,
                total_rows: rows.length,
                uploaded_at: Date.now()
            });
            
            return ok(res, "File uploaded successfully", {
                detected_mappings: {
                    email_column: detectedMappings.email,
                    name_column: detectedMappings.name,
                    variable_columns: Object.keys(detectedMappings.variables)
                },
                summary: {
                    total_rows: rows.length,
                    valid_recipients: recipients.length,
                    invalid_entries: errors.length
                },
                sample_recipients: recipients.slice(0, 5),
                has_errors: errors.length > 0
            });
        } catch (error) {
            console.error("File upload error:", error);
            return fail(res, error.message);
        }
    });
});

// Create broadcast from upload
router.post("/broadcast/create-from-upload", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.headers.username || req.headers.Username || null;
        const { 
            config_id, 
            fallback_config_id,
            template_id, 
            broadcast_name, 
            schedule_type = "now", 
            scheduled_at = null, 
            timezone = "Asia/Kolkata", 
            global_variables_json = {},
            daily_limit = 1000
        } = req.body || {};
        
        if (!config_id || !template_id || !broadcast_name) {
            return fail(res, "config_id, template_id and broadcast_name are required");
        }
        
        // Get uploaded recipients
        let recipients = [];
        if (global.uploadedRecipients && global.uploadedRecipients.has(branch_id)) {
            recipients = global.uploadedRecipients.get(branch_id).recipients;
            // Clear after use
            global.uploadedRecipients.delete(branch_id);
        } else if (req.body.recipients && Array.isArray(req.body.recipients)) {
            recipients = req.body.recipients;
        }
        
        if (!recipients.length) {
            return fail(res, "No recipients found. Please upload a file first.");
        }
        
        // Validate config exists
        const [cfg] = await pool.query(
            "SELECT config_id, daily_limit FROM email_configs WHERE branch_id=? AND config_id=? AND status='active' LIMIT 1", 
            [branch_id, config_id]
        );
        if (!cfg.length) {
            return fail(res, "Active SMTP config not found");
        }
        
        // Validate template exists
        const [tpl] = await pool.query(
            "SELECT * FROM email_templates WHERE branch_id=? AND template_id=? AND status='active' LIMIT 1", 
            [branch_id, template_id]
        );
        if (!tpl.length) {
            return fail(res, "Active template not found");
        }
        
        const broadcast_id = newId("brd");
        const template = tpl[0];
        const finalDailyLimit = daily_limit || cfg[0].daily_limit || 1000;
        
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            
            await conn.query(
                `INSERT INTO email_broadcasts
                 (broadcast_id, branch_id, config_id, fallback_config_id, template_id, broadcast_name, 
                  subject_snapshot, html_body_snapshot, text_body_snapshot, template_variables_json,
                  global_variables_json, schedule_type, scheduled_at, timezone, status, 
                  total_recipients, total_pending, total_sent, total_failed, total_skipped, daily_limit,
                  create_by, modify_by, create_date, modify_date)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', 
                         ?, ?, 0, 0, 0, ?, ?, ?, NOW(), NOW())`,
                [
                    broadcast_id, branch_id, config_id, fallback_config_id || null, template_id, broadcast_name, 
                    template.subject, template.html_body, template.text_body,
                    template.variables_json, JSON.stringify(global_variables_json || {}), schedule_type,
                    schedule_type === "scheduled" ? scheduled_at : null, timezone, 
                    recipients.length, recipients.length, finalDailyLimit,
                    username || 'system', username || 'system'
                ]
            );
            
            // Insert recipients in batches
            const batchSize = 100;
            for (let i = 0; i < recipients.length; i += batchSize) {
                const batch = recipients.slice(i, i + batchSize);
                const values = [];
                
                for (const recipient of batch) {
                    values.push([
                        newId("rcp"), broadcast_id, branch_id, 
                        recipient.recipient_name || null, 
                        recipient.recipient_email, 
                        JSON.stringify(recipient.variable_values_json || {}),
                        'pending', 0
                    ]);
                }
                
                if (values.length) {
                    await conn.query(
                        `INSERT INTO email_broadcast_recipients
                         (recipient_id, broadcast_id, branch_id, recipient_name, recipient_email, 
                          variable_values_json, status, attempt_count, create_date, modify_date)
                         VALUES ?`,
                        [values.map(v => [...v, 'NOW()', 'NOW()'])]
                    );
                }
            }
            
            await conn.commit();
        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }
        
        return ok(res, "Broadcast created successfully from uploaded file", { 
            broadcast_id,
            recipients_count: recipients.length
        });
        
    } catch (error) {
        console.error("Broadcast creation from upload error:", error);
        return fail(res, error.message);
    }
});

// Get uploaded recipients info
router.get("/uploaded-recipients-info", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        
        if (!global.uploadedRecipients || !global.uploadedRecipients.has(branch_id)) {
            return ok(res, "No uploaded recipients found", { has_upload: false });
        }
        
        const uploaded = global.uploadedRecipients.get(branch_id);
        return ok(res, "Uploaded recipients info", {
            has_upload: true,
            total_recipients: uploaded.recipients.length,
            variable_columns: Object.keys(uploaded.detectedMappings.variables),
            email_column: uploaded.detectedMappings.email,
            name_column: uploaded.detectedMappings.name,
            uploaded_at: new Date(uploaded.uploaded_at).toISOString()
        });
        
    } catch (error) {
        return fail(res, error.message);
    }
});

// Clear uploaded recipients
router.post("/clear-uploaded-recipients", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        if (global.uploadedRecipients && global.uploadedRecipients.has(branch_id)) {
            global.uploadedRecipients.delete(branch_id);
        }
        return ok(res, "Uploaded recipients cleared successfully");
    } catch (error) {
        return fail(res, error.message);
    }
});

// ⚠️ IMPORTANT: Export the router at the end
export default router;