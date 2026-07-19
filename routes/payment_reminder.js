import express from "express";
import crypto from "crypto";
import nodemailer from "nodemailer";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { GET_BALANCE } from "../helpers/function.js";

const router = express.Router();

const VARIABLE_REGEX = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;

function ok(res, message, data = {}, pagination) {
    return res.json({ success: true, message, data, ...(pagination ? { pagination } : {}) });
}

function fail(res, message, code = 400) {
    return res.status(code).json({ success: false, message });
}

function userFromReq(req) {
    return req.headers.username || req.headers.Username || null;
}

function newId(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function parseJSON(value, fallback) {
    if (!value) return fallback;
    try { return JSON.parse(value); } catch { return fallback; }
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function getEncKey() {
    const base = process.env.SMTP_ENCRYPTION_KEY || "ooms-default-smtp-encryption-key-change-me";
    return crypto.createHash("sha256").update(base).digest();
}

function encrypt(text) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", getEncKey(), iv);
    const encrypted = Buffer.concat([cipher.update(String(text || ""), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decrypt(payload) {
    if (!payload) return "";
    const buf = Buffer.from(String(payload), "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", getEncKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

function parseVariables(...parts) {
    const set = new Set();
    for (const part of parts) {
        const content = String(part || "");
        let match = VARIABLE_REGEX.exec(content);
        while (match) {
            if (match[1]) set.add(match[1]);
            match = VARIABLE_REGEX.exec(content);
        }
        VARIABLE_REGEX.lastIndex = 0;
    }
    return Array.from(set);
}

function renderTemplate(text, variables) {
    return String(text || "").replace(VARIABLE_REGEX, (_, key) => String(variables?.[key] ?? ""));
}

// FIX 1: getUserByUsername - use status = 1
async function getUserByUsername(branch_id, username) {
    const [rows] = await pool.query(
        `SELECT 
            id, profile_id, username, create_by, user_type, name, care_of,
            guardian_name, date_of_birth, gender, mobile, country_code, email,
            pan_number, country, state, city, district, village_town,
            address_line_1, address_line_2, pincode, image, status, create_date
         FROM profile 
         WHERE username = ? AND status = 1`,
        [username]
    );

    if (!rows.length) {
        // Check if user exists but inactive
        const [checkUser] = await pool.query(
            `SELECT status FROM profile WHERE username = ?`,
            [username]
        );

        if (checkUser.length) {
            throw new Error(`User exists but status is ${checkUser[0].status} (inactive). Please activate first.`);
        }
        throw new Error(`User not found with username: ${username}`);
    }

    return rows[0];
}

// FIX 2: In stats endpoint - fix status check
router.get("/payment-reminder/stats", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;

        const [reminderStats] = await pool.query(
            `SELECT 
                COUNT(*) as total_reminders,
                SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as total_sent,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as total_failed,
                DATE_FORMAT(sent_at, '%Y-%m') as month
             FROM payment_reminder_logs
             WHERE branch_id = ?
             GROUP BY DATE_FORMAT(sent_at, '%Y-%m')
             ORDER BY month DESC
             LIMIT 6`,
            [branch_id]
        );

        const [todayReminders] = await pool.query(
            `SELECT COUNT(*) as total, 
                    SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
                    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
             FROM payment_reminder_logs
             WHERE branch_id = ? AND DATE(sent_at) = CURDATE()`,
            [branch_id]
        );

        // FIX: status = 1 for active users
        const [topDebitUsers] = await pool.query(
            `SELECT username, name, email, mobile
             FROM profile
             WHERE status = 1
             LIMIT 10`,
            []
        );

        const usersWithBalance = [];
        for (const user of topDebitUsers) {
            const balanceData = await getUserBalance(branch_id, user.username);
            if (balanceData.debit > 0) {
                usersWithBalance.push({
                    ...user,
                    debit: balanceData.debit,
                    balance: balanceData.balance
                });
            }
        }
        usersWithBalance.sort((a, b) => b.debit - a.debit);

        return ok(res, "Payment reminder statistics", {
            overview: {
                total_reminders_sent: reminderStats.reduce((sum, r) => sum + r.total_sent, 0),
                total_reminders_failed: reminderStats.reduce((sum, r) => sum + r.total_failed, 0),
                today_sent: todayReminders[0]?.sent || 0,
                today_failed: todayReminders[0]?.failed || 0
            },
            monthly_stats: reminderStats,
            top_debit_users: usersWithBalance.slice(0, 10)
        });

    } catch (error) {
        console.error("Get stats error:", error);
        return fail(res, error.message);
    }
});
/**
 * Get user's balance using the GET_BALANCE function
 */
async function getUserBalance(branch_id, username) {
    try {
        const balanceData = await GET_BALANCE({
            branch_id: branch_id,
            party_id: username,
            party_type: "client"
        });

        return balanceData;
    } catch (error) {
        console.error("Error getting balance:", error);
        return { balance: 0, debit: 0, credit: 0 };
    }
}

/**
 * Get active payment reminder template by type
 */
async function getActivePaymentTemplate(branch_id, template_type = "payment_reminder") {
    const [rows] = await pool.query(
        `SELECT 
            template_id, template_type, template_name, subject, 
            html_body, text_body, variables_json, status, is_default
         FROM email_static_templates 
         WHERE branch_id = ? AND template_type = ? AND status = 'active'
         ORDER BY is_default DESC, create_date DESC
         LIMIT 1`,
        [branch_id, template_type]
    );

    if (!rows.length) {
        throw new Error(`No active ${template_type} template found`);
    }

    return {
        ...rows[0],
        variables_json: parseJSON(rows[0].variables_json, [])
    };
}

/**
 * Get active SMTP config
 */
async function getActiveSmtpConfig(branch_id, config_id = null) {
    let query = `SELECT * FROM email_configs WHERE branch_id = ? AND status = 'active'`;
    let params = [branch_id];

    if (config_id) {
        query += ` AND config_id = ?`;
        params.push(config_id);
    } else {
        query += ` ORDER BY is_default DESC LIMIT 1`;
    }

    const [rows] = await pool.query(query, params);

    if (!rows.length) {
        throw new Error("No active SMTP config found");
    }

    const config = rows[0];
    config.password = decrypt(config.password_encrypted);

    return config;
}

/**
 * Send email using SMTP config
 */
async function sendEmail(smtpConfig, to, subject, html, text = null) {
    const transporter = nodemailer.createTransport({
        host: smtpConfig.host,
        port: Number(smtpConfig.port),
        secure: Number(smtpConfig.secure) === 1 || Number(smtpConfig.port) === 465,
        auth: {
            user: smtpConfig.username,
            pass: smtpConfig.password
        }
    });

    const from = smtpConfig.from_name
        ? `${smtpConfig.from_name} <${smtpConfig.from_email}>`
        : smtpConfig.from_email;

    const mailOptions = {
        from,
        to,
        subject,
        html,
        ...(text && { text })
    };

    const result = await transporter.sendMail(mailOptions);
    return result;
}

/**
 * Prepare variables for payment reminder template
 * Fixed: No firm_id join - simpler approach
 */
async function preparePaymentReminderVariables(branch_id, username, user, balanceData) {
    // Get firm details
    const [firm] = await pool.query(
        `SELECT firm_name, firm_type, gst_no, pan_no 
         FROM firms 
         WHERE username = ? AND branch_id = ? AND status = '1' AND (is_deleted = '0' OR is_deleted = 0)
         LIMIT 1`,
        [username, branch_id]
    );

    // First, check what columns exist in invoice table
    const [columns] = await pool.query(`SHOW COLUMNS FROM invoice`);
    const columnNames = columns.map(col => col.Field);

    // Build SELECT query dynamically based on available columns
    let selectFields = ['invoice_id', 'invoice_no', 'create_date as invoice_date', 'grand_total as amount'];

    // Check for common column names that might link to user
    let whereClause = '';
    let queryParams = [branch_id];

    // Try different possible column names for user association
    if (columnNames.includes('username')) {
        whereClause = ` username = ?`;
        queryParams.push(username);
    } else if (columnNames.includes('user_id')) {
        whereClause = ` user_id = ?`;
        queryParams.push(username);
    } else if (columnNames.includes('client_id')) {
        whereClause = ` client_id = ?`;
        queryParams.push(username);
    } else {
        // If no direct user link, don't filter by user
        whereClause = ` 1=1`;
    }

    // Check if due_date column exists
    if (columnNames.includes('due_date')) {
        selectFields.push('due_date');
    } else {
        selectFields.push('NULL as due_date');
    }

    // Check if payment_status column exists
    if (columnNames.includes('payment_status')) {
        selectFields.push('payment_status');
    }

    // Check if status column exists
    if (columnNames.includes('status')) {
        selectFields.push('status');
    }

    const selectQuery = selectFields.join(', ');

    // Get pending invoices
    let invoiceQuery = `
        SELECT ${selectQuery}
        FROM invoice
        WHERE branch_id = ?
    `;

    if (whereClause !== ' 1=1') {
        invoiceQuery += ` AND ${whereClause}`;
    }

    // Add payment_status filter if column exists
    if (columnNames.includes('payment_status')) {
        invoiceQuery += ` AND payment_status = 'pending'`;
    }

    // Add status filter if column exists
    if (columnNames.includes('status')) {
        invoiceQuery += ` AND status = 'active'`;
    }

    invoiceQuery += ` ORDER BY create_date ASC LIMIT 5`;

    const [pendingInvoices] = await pool.query(invoiceQuery, queryParams);

    // Calculate days overdue for each invoice
    const today = new Date();
    const invoicesWithOverdue = pendingInvoices.map(inv => {
        let daysOverdue = 0;

        // Only calculate overdue if due_date exists and has value
        if (inv.due_date && inv.due_date !== '0000-00-00' && inv.due_date !== null) {
            const dueDate = new Date(inv.due_date);
            if (!isNaN(dueDate.getTime())) {
                daysOverdue = Math.max(0, Math.floor((today - dueDate) / (1000 * 60 * 60 * 24)));
            }
        }

        return {
            invoice_id: inv.invoice_id,
            invoice_no: inv.invoice_no,
            invoice_date: inv.invoice_date,
            due_date: inv.due_date || 'Not specified',
            days_overdue: daysOverdue,
            amount: inv.amount,
            formatted_amount: `₹${Number(inv.amount).toLocaleString('en-IN')}`
        };
    });

    // Prepare invoice table HTML
    let invoiceTableHtml = '';
    if (invoicesWithOverdue.length > 0) {
        invoiceTableHtml = `
            <table style="width:100%; border-collapse: collapse; margin: 20px 0;">
                <thead>
                    <tr><th style="border:1px solid #ddd; padding:8px; background:#f2f2f2;">Invoice No</th>
                        <th style="border:1px solid #ddd; padding:8px; background:#f2f2f2;">Invoice Date</th>
                        <th style="border:1px solid #ddd; padding:8px; background:#f2f2f2;">Amount</th>
                    </tr>
                </thead>
                <tbody>
                    ${invoicesWithOverdue.map(inv => `
                        <tr>
                            <td style="border:1px solid #ddd; padding:8px;">${inv.invoice_no}</td>
                            <td style="border:1px solid #ddd; padding:8px;">${new Date(inv.invoice_date).toLocaleDateString('en-GB')}</td>
                            <td style="border:1px solid #ddd; padding:8px;">${inv.formatted_amount}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    } else {
        invoiceTableHtml = '<p>No pending invoices found.</p>';
    }

    const hasDebitBalance = balanceData.debit > 0;
    const formattedBalance = `₹${Math.abs(balanceData.balance).toLocaleString('en-IN')}`;

    const maxDaysOverdue = Math.max(...invoicesWithOverdue.map(inv => inv.days_overdue), 0);
    let urgencyLevel = "normal";
    let urgencyBadge = "🟢 Normal";
    if (maxDaysOverdue > 30) {
        urgencyLevel = "critical";
        urgencyBadge = "🔴 CRITICAL - Over 30 days overdue";
    } else if (maxDaysOverdue > 15) {
        urgencyLevel = "high";
        urgencyBadge = "🟠 HIGH - Over 15 days overdue";
    } else if (maxDaysOverdue > 7) {
        urgencyLevel = "medium";
        urgencyBadge = "🟡 Medium - Over 7 days overdue";
    } else if (maxDaysOverdue > 0) {
        urgencyLevel = "low";
        urgencyBadge = "🟢 Low - Overdue";
    }

    return {
        // User details
        name: user.name || username,
        username: user.username,
        email: user.email,
        mobile: user.mobile,
        phone: user.mobile,
        address: `${user.address_line_1 || ''} ${user.address_line_2 || ''}, ${user.city || ''}, ${user.state || ''} - ${user.pincode || ''}`,
        city: user.city || '',
        state: user.state || '',
        pincode: user.pincode || '',
        pan_number: user.pan_number || 'Not Provided',

        // Balance details
        balance: formattedBalance,
        balance_amount: Math.abs(balanceData.balance),
        balance_type: hasDebitBalance ? "debit" : "credit",
        debit_amount: `₹${balanceData.debit.toLocaleString('en-IN')}`,
        credit_amount: `₹${balanceData.credit.toLocaleString('en-IN')}`,
        has_debit: hasDebitBalance,
        has_credit: !hasDebitBalance && balanceData.credit > 0,

        // Firm details
        firm_name: firm.length ? firm[0].firm_name : 'Your Firm',
        firm_type: firm.length ? firm[0].firm_type : '',
        gst_no: firm.length ? firm[0].gst_no : '',
        pan_no: firm.length ? firm[0].pan_no : '',

        // Invoice details
        total_invoices: pendingInvoices.length,
        total_due_amount: `₹${pendingInvoices.reduce((sum, inv) => sum + Number(inv.amount), 0).toLocaleString('en-IN')}`,
        invoice_table: invoiceTableHtml,
        pending_invoices: invoicesWithOverdue,

        // Urgency
        urgency_level: urgencyLevel,
        urgency_badge: urgencyBadge,
        max_days_overdue: maxDaysOverdue,

        // Date and time
        current_date: new Date().toLocaleDateString('en-GB'),
        current_time: new Date().toLocaleTimeString(),
        current_year: new Date().getFullYear(),

        // Payment link
        payment_link: `${process.env.APP_URL || 'https://yourdomain.com'}/payment/${username}`,

        // Support contact
        support_email: process.env.SUPPORT_EMAIL || 'support@yourdomain.com',
        support_phone: process.env.SUPPORT_PHONE || '+91-XXXXXXXXXX'
    };
}
// ==================== PAYMENT REMINDER ENDPOINTS ====================

/**
 * Send payment reminder to a single user
 * POST /api/email/payment-reminder/send
 */
router.post("/payment-reminder/send", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { username, config_id, template_type = "payment_reminder" } = req.body || {};

        if (!username) {
            return fail(res, "username is required");
        }

        const user = await getUserByUsername(branch_id, username);

        if (!user.email) {
            return fail(res, `User ${username} does not have an email address`);
        }

        const balanceData = await getUserBalance(branch_id, username);

        if (balanceData.debit <= 0) {
            return ok(res, "User has no debit balance. Payment reminder not sent.", {
                username,
                email: user.email,
                balance: balanceData.balance,
                debit: balanceData.debit,
                credit: balanceData.credit,
                reminder_sent: false,
                reason: "No debit balance found"
            });
        }

        const template = await getActivePaymentTemplate(branch_id, template_type);
        const smtpConfig = await getActiveSmtpConfig(branch_id, config_id);
        const variables = await preparePaymentReminderVariables(branch_id, username, user, balanceData);

        const subject = renderTemplate(template.subject, variables);
        const htmlBody = renderTemplate(template.html_body, variables);
        const textBody = template.text_body ? renderTemplate(template.text_body, variables) : null;

        const sendResult = await sendEmail(smtpConfig, user.email, subject, htmlBody, textBody);

        // Create payment_reminder_logs table if not exists
        await pool.query(`
            CREATE TABLE IF NOT EXISTS payment_reminder_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                log_id VARCHAR(50) NOT NULL UNIQUE,
                branch_id VARCHAR(50),
                username VARCHAR(100),
                email VARCHAR(255),
                balance_debit DECIMAL(15,2),
                template_id VARCHAR(50),
                status VARCHAR(20),
                message_id VARCHAR(255),
                error_message TEXT,
                sent_at DATETIME
            )
        `);

        await pool.query(
            `INSERT INTO payment_reminder_logs 
             (log_id, branch_id, username, email, balance_debit, template_id, status, message_id, sent_at)
             VALUES (?, ?, ?, ?, ?, ?, 'sent', ?, NOW())`,
            [newId("prl"), branch_id, username, user.email, balanceData.debit, template.template_id, sendResult.messageId]
        );

        return ok(res, "Payment reminder sent successfully", {
            username,
            email: user.email,
            balance: balanceData.balance,
            debit: balanceData.debit,
            reminder_sent: true,
            message_id: sendResult.messageId
        });

    } catch (error) {
        console.error("Send payment reminder error:", error);
        return fail(res, error.message);
    }
});

/**
 * Send payment reminders to multiple users
 * POST /api/email/payment-reminder/bulk-send
 */
router.post("/payment-reminder/bulk-send", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { usernames, config_id, template_type = "payment_reminder" } = req.body || {};

        if (!usernames || !Array.isArray(usernames) || usernames.length === 0) {
            return fail(res, "usernames array is required");
        }

        const results = {
            total: usernames.length,
            sent: 0,
            skipped: 0,
            failed: 0,
            details: []
        };

        for (const username of usernames) {
            try {
                const user = await getUserByUsername(branch_id, username);

                if (!user.email) {
                    results.skipped++;
                    results.details.push({ username, status: "skipped", reason: "No email address" });
                    continue;
                }

                const balanceData = await getUserBalance(branch_id, username);

                if (balanceData.debit <= 0) {
                    results.skipped++;
                    results.details.push({
                        username,
                        email: user.email,
                        status: "skipped",
                        reason: "No debit balance",
                        debit: balanceData.debit
                    });
                    continue;
                }

                const template = await getActivePaymentTemplate(branch_id, template_type);
                const smtpConfig = await getActiveSmtpConfig(branch_id, config_id);
                const variables = await preparePaymentReminderVariables(branch_id, username, user, balanceData);

                const subject = renderTemplate(template.subject, variables);
                const htmlBody = renderTemplate(template.html_body, variables);
                const textBody = template.text_body ? renderTemplate(template.text_body, variables) : null;

                const sendResult = await sendEmail(smtpConfig, user.email, subject, htmlBody, textBody);

                results.sent++;
                results.details.push({
                    username,
                    email: user.email,
                    status: "sent",
                    debit: balanceData.debit,
                    message_id: sendResult.messageId
                });

                await new Promise(resolve => setTimeout(resolve, 1000));

            } catch (error) {
                console.error(`Error sending to ${username}:`, error);
                results.failed++;
                results.details.push({ username, status: "failed", reason: error.message });
            }
        }

        return ok(res, "Bulk payment reminders processed", results);

    } catch (error) {
        console.error("Bulk send error:", error);
        return fail(res, error.message);
    }
});

/**
 * Get all users (for client list)
 * GET /api/email/payment-reminder/users-list
 */
router.get("/payment-reminder/users-list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const page_no = Math.max(1, Number(req.query.page_no || 1));
        const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
        const offset = (page_no - 1) * limit;
        const search = req.query.search ? String(req.query.search).trim() : "";

        // Get all active users - status = 1 (active)
        let userQuery = `
            SELECT username, name, email, mobile, city, state, pan_number, status, create_date
            FROM profile 
            WHERE status = 1
        `;
        const queryParams = [];

        if (search) {
            userQuery += ` AND (username LIKE ? OR name LIKE ? OR email LIKE ? OR mobile LIKE ?)`;
            const searchPattern = `%${search}%`;
            queryParams.push(searchPattern, searchPattern, searchPattern, searchPattern);
        }

        userQuery += ` LIMIT ? OFFSET ?`;
        queryParams.push(limit, offset);

        const [users] = await pool.query(userQuery, queryParams);

        // Get total count
        let countQuery = `SELECT COUNT(*) as total FROM profile WHERE status = 1`;
        const countParams = [];
        if (search) {
            countQuery += ` AND (username LIKE ? OR name LIKE ? OR email LIKE ? OR mobile LIKE ?)`;
            countParams.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
        }
        const [countRows] = await pool.query(countQuery, countParams);
        const total = countRows[0]?.total || 0;

        // Get balance for each user
        const usersWithBalance = [];
        for (const user of users) {
            const balanceData = await getUserBalance(branch_id, user.username);
            usersWithBalance.push({
                ...user,
                balance: balanceData.balance,
                debit: balanceData.debit,
                credit: balanceData.credit,
                has_debit: balanceData.debit > 0
            });
        }

        const filterDebitOnly = req.query.debit_only === 'true';
        const filteredUsers = filterDebitOnly
            ? usersWithBalance.filter(u => u.has_debit)
            : usersWithBalance;

        const summary = {
            total_users: total,
            total_with_debit: usersWithBalance.filter(u => u.has_debit).length,
            total_with_credit: usersWithBalance.filter(u => !u.has_debit && u.credit > 0).length,
            total_zero_balance: usersWithBalance.filter(u => u.balance === 0).length,
            total_debit_amount: usersWithBalance.reduce((sum, u) => sum + (u.debit || 0), 0),
            total_credit_amount: usersWithBalance.reduce((sum, u) => sum + (u.credit || 0), 0)
        };

        return ok(res, "Users list retrieved successfully", {
            filters: {
                search: search || null,
                debit_only: filterDebitOnly
            },
            summary,
            users: filteredUsers,
            pagination: {
                page_no,
                limit,
                total: filteredUsers.length,
                total_pages: Math.ceil(filteredUsers.length / limit),
                has_more: offset + filteredUsers.length < filteredUsers.length
            }
        });

    } catch (error) {
        console.error("Get users list error:", error);
        return fail(res, error.message);
    }
});

/**
 * Get payment reminder logs
 * GET /api/email/payment-reminder/logs
 */
router.get("/payment-reminder/logs", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const page_no = Math.max(1, Number(req.query.page_no || 1));
        const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
        const offset = (page_no - 1) * limit;
        const username = req.query.username;
        const status = req.query.status;

        let query = `
            SELECT log_id, username, email, balance_debit, status, message_id, error_message, sent_at
            FROM payment_reminder_logs
            WHERE branch_id = ?
        `;
        const params = [branch_id];

        if (username) {
            query += ` AND username = ?`;
            params.push(username);
        }

        if (status && ['sent', 'failed'].includes(status)) {
            query += ` AND status = ?`;
            params.push(status);
        }

        query += ` ORDER BY sent_at DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const [logs] = await pool.query(query, params);

        let countQuery = `SELECT COUNT(*) as total FROM payment_reminder_logs WHERE branch_id = ?`;
        const countParams = [branch_id];
        if (username) {
            countQuery += ` AND username = ?`;
            countParams.push(username);
        }
        if (status && ['sent', 'failed'].includes(status)) {
            countQuery += ` AND status = ?`;
            countParams.push(status);
        }
        const [countRows] = await pool.query(countQuery, countParams);
        const total = countRows[0]?.total || 0;

        return ok(res, "Logs retrieved successfully", logs, {
            page_no,
            limit,
            total,
            total_pages: Math.ceil(total / limit),
            has_more: offset + logs.length < total
        });

    } catch (error) {
        console.error("Get logs error:", error);
        return fail(res, error.message);
    }
});

/**
 * Create/Update payment reminder template
 * POST /api/email/payment-reminder/template
 */
router.post("/payment-reminder/template", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = userFromReq(req);
        const { template_name, subject, html_body, text_body, is_default = 0, template_id } = req.body || {};

        if (!template_name || !subject || !html_body) {
            return fail(res, "template_name, subject and html_body are required");
        }

        const template_type = "payment_reminder";
        const variables = parseVariables(subject, html_body, text_body);

        let result;

        if (template_id) {
            const [existing] = await pool.query(
                `SELECT template_id FROM email_static_templates 
                 WHERE branch_id = ? AND template_id = ? AND template_type = ?`,
                [branch_id, template_id, template_type]
            );

            if (!existing.length) {
                return fail(res, "Template not found", 404);
            }

            if (Number(is_default) === 1) {
                await pool.query(
                    `UPDATE email_static_templates 
                     SET is_default = 0, modify_by = ?, modify_date = NOW()
                     WHERE branch_id = ? AND template_type = ?`,
                    [username, branch_id, template_type]
                );
            }

            await pool.query(
                `UPDATE email_static_templates 
                 SET template_name = ?, subject = ?, html_body = ?, text_body = ?, 
                     variables_json = ?, is_default = ?, modify_by = ?, modify_date = NOW()
                 WHERE branch_id = ? AND template_id = ? AND template_type = ?`,
                [template_name, subject, html_body, text_body, JSON.stringify(variables),
                    Number(is_default), username, branch_id, template_id, template_type]
            );

            result = { template_id };
        } else {
            const newTemplateId = newId("stpl");

            if (Number(is_default) === 1) {
                await pool.query(
                    `UPDATE email_static_templates 
                     SET is_default = 0, modify_by = ?, modify_date = NOW()
                     WHERE branch_id = ? AND template_type = ?`,
                    [username, branch_id, template_type]
                );
            }

            await pool.query(
                `INSERT INTO email_static_templates 
                 (template_id, branch_id, template_type, template_name, subject, html_body, text_body, 
                  variables_json, status, is_default, create_by, modify_by, create_date, modify_date)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NOW(), NOW())`,
                [newTemplateId, branch_id, template_type, template_name, subject, html_body, text_body,
                    JSON.stringify(variables), Number(is_default), username, username]
            );

            result = { template_id: newTemplateId };
        }

        return ok(res, "Payment reminder template saved successfully", result);

    } catch (error) {
        console.error("Save template error:", error);
        return fail(res, error.message);
    }
});

/**
 * Get payment reminder template
 * GET /api/email/payment-reminder/template
 */
router.get("/payment-reminder/template", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;

        const [templates] = await pool.query(
            `SELECT template_id, template_name, subject, html_body, text_body, variables_json, is_default, status, create_date
             FROM email_static_templates 
             WHERE branch_id = ? AND template_type = 'payment_reminder' AND status = 'active'
             ORDER BY is_default DESC, create_date DESC`,
            [branch_id]
        );

        const defaultTemplate = templates.find(t => t.is_default === 1) || templates[0];

        return ok(res, "Template retrieved successfully", {
            templates: templates.map(t => ({
                ...t,
                variables_json: parseJSON(t.variables_json, [])
            })),
            default_template: defaultTemplate ? {
                ...defaultTemplate,
                variables_json: parseJSON(defaultTemplate.variables_json, [])
            } : null
        });

    } catch (error) {
        console.error("Get template error:", error);
        return fail(res, error.message);
    }
});

/**
 * Get available variables for payment reminder template
 * GET /api/email/payment-reminder/variables
 */
router.get("/payment-reminder/variables", auth, validateBranch, async (req, res) => {
    const variables = {
        user: [
            { name: "name", description: "User's full name" },
            { name: "username", description: "User's username" },
            { name: "email", description: "User's email address" },
            { name: "mobile", description: "User's mobile number" },
            { name: "address", description: "User's full address" },
            { name: "city", description: "User's city" },
            { name: "state", description: "User's state" },
            { name: "pan_number", description: "User's PAN number" }
        ],
        balance: [
            { name: "balance", description: "Formatted balance amount" },
            { name: "balance_type", description: "'debit' or 'credit'" },
            { name: "debit_amount", description: "Formatted debit amount" },
            { name: "credit_amount", description: "Formatted credit amount" },
            { name: "has_debit", description: "true/false if user has debit" }
        ],
        firm: [
            { name: "firm_name", description: "User's firm name" },
            { name: "gst_no", description: "GST number of firm" }
        ],
        invoices: [
            { name: "total_invoices", description: "Number of pending invoices" },
            { name: "total_due_amount", description: "Total due amount" },
            { name: "invoice_table", description: "HTML table of pending invoices" }
        ],
        urgency: [
            { name: "urgency_level", description: "normal/low/medium/high/critical" },
            { name: "urgency_badge", description: "Formatted urgency badge" },
            { name: "max_days_overdue", description: "Maximum days overdue" }
        ],
        other: [
            { name: "current_date", description: "Current date" },
            { name: "current_year", description: "Current year" },
            { name: "payment_link", description: "Payment link" },
            { name: "support_email", description: "Support email" },
            { name: "support_phone", description: "Support phone" }
        ]
    };

    return ok(res, "Available variables", variables);
});

export {
    getActivePaymentTemplate,
    getActiveSmtpConfig,
    preparePaymentReminderVariables,
    renderTemplate,
    sendEmail,
};

export default router;