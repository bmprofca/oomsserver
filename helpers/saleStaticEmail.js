import nodemailer from "nodemailer";
import pool from "../db.js";
import { getConfigWithDecryptedPassword } from "../services/emailConfigService.js";
import { renderRecipientEmail } from "../utils/templateRenderer.js";
import { USER_SNIPPED_DATA, BANK_SNIPPED_DATA } from "./function.js";

// Sale Email Types
const SALE_INVOICE_TEMPLATE_TYPE = "sale_invoice";
const SALE_REMINDER_TEMPLATE_TYPE = "sale_reminder";

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function branchKey(branch_id) {
    return branch_id == null ? "" : String(branch_id);
}

function formatDateTime(value) {
    if (value == null || value === "") return "";
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDateOnly(value) {
    if (value == null || value === "") return "";
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function getDefaultActiveConfigId(branch_id) {
    const [rows] = await pool.query(
        `SELECT config_id FROM email_configs
         WHERE branch_id = ? AND status = 'active'
         ORDER BY is_default DESC, id DESC
         LIMIT 1`,
        [branch_id]
    );
    return rows[0]?.config_id || null;
}

async function loadActiveStaticTemplate(template_id) {
    const [rows] = await pool.query(
        `SELECT * FROM email_static_templates
         WHERE template_id = ? AND status = 'active'
         LIMIT 1`,
        [template_id]
    );
    return rows[0] || null;
}

async function isUnsubscribed(branch_id, email) {
    const [rows] = await pool.query(
        `SELECT unsubscribe_id FROM email_unsubscribes
         WHERE branch_id = ? AND email = ? AND status = 'active'
         LIMIT 1`,
        [branch_id, email]
    );
    return rows.length > 0;
}

// Get sale invoice items
async function getSaleItems(sale_id) {
    const [rows] = await pool.query(
        `SELECT si.service_id, si.fees, si.tax_perc, si.tax_value, si.total, si.remark,
                s.name as service_name, s.sac_code
         FROM sale_items si
         LEFT JOIN services s ON s.service_id = si.service_id
         WHERE si.sale_id = ?
         ORDER BY si.id ASC`,
        [sale_id]
    );
    return rows;
}


// ==================== SALE INVOICE (When invoice is created) ====================
async function resolveSaleInvoiceTemplateId(branch_id) {
    const key = branchKey(branch_id);
    const [mapRows] = await pool.query(
        `SELECT sale_invoice FROM email_static_mapping
         WHERE branch_id = ?
           AND sale_invoice IS NOT NULL
           AND TRIM(sale_invoice) <> ''
         ORDER BY id ASC
         LIMIT 1`,
        [key]
    );
    if (mapRows.length && mapRows[0].sale_invoice) {
        return String(mapRows[0].sale_invoice).trim();
    }

    const bid = Number(branch_id);
    if (Number.isNaN(bid)) return null;
    const [fallback] = await pool.query(
        `SELECT template_id FROM email_static_templates
         WHERE branch_id = ? AND template_type = ? AND status = 'active'
         ORDER BY is_default DESC, id DESC
         LIMIT 1`,
        [bid, SALE_INVOICE_TEMPLATE_TYPE]
    );
    return fallback[0]?.template_id ? String(fallback[0].template_id).trim() : null;
}

/**
 * Send Sale Invoice Email when invoice is created
 */
async function sendSaleInvoiceEmail({ branch_id, sale_id, invoice_id, invoice_no, party_id, party_type, sale_date, grand_total, items, subtotal, discount_value, tax_value, total }) {
    if (!branch_id || !sale_id) return;

    const template_id = await resolveSaleInvoiceTemplateId(branch_id);
    if (!template_id) return;

    const template = await loadActiveStaticTemplate(template_id);
    if (!template) return;

    // Get customer details
    let customerData = {};
    let to = null;

    if (party_type === 'bank') {
        const bankData = await BANK_SNIPPED_DATA(party_id);
        customerData = bankData;
        // Banks usually don't have email, so skip
        to = null;
    } else {
        customerData = await USER_SNIPPED_DATA(party_id);
        to = customerData?.email;
    }

    if (!to) return;
    if (await isUnsubscribed(branch_id, to)) return;

    const config_id = await getDefaultActiveConfigId(branch_id);
    if (!config_id) return;

    const smtp = await getConfigWithDecryptedPassword({ branch_id, config_id });

    // Format items for email
    const itemsHtml = items.map(item => `
        <tr>
            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0;">${item.service_name || item.service_id}</td>
            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: right;">₹${Number(item.fees).toFixed(2)}</td>
            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: right;">${item.tax_perc}%</td>
            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: right;">₹${Number(item.total).toFixed(2)}</td>
        </tr>
    `).join('');

    const itemsText = items.map(item => 
        `${item.service_name || item.service_id}: ₹${Number(item.fees).toFixed(2)} (Tax: ${item.tax_perc}%) = ₹${Number(item.total).toFixed(2)}`
    ).join('\n');

    const variables = {
        customer_name: customerData?.name || customerData?.holder || customerData?.username || party_id,
        customer_type: party_type,
        invoice_no: invoice_no,
        invoice_date: formatDateOnly(sale_date),
        due_date: formatDateOnly(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)), // 30 days due
        subtotal: Number(subtotal).toFixed(2),
        discount: Number(discount_value || 0).toFixed(2),
        tax: Number(tax_value || 0).toFixed(2),
        total: Number(total || grand_total).toFixed(2),
        grand_total: Number(grand_total).toFixed(2),
        items_html: itemsHtml,
        items_text: itemsText,
        payment_link: `https://yourdomain.com/pay/${invoice_id}`,
        invoice_link: `https://yourdomain.com/invoice/${invoice_id}`
    };

    const rendered = renderRecipientEmail({
        subject: template.subject,
        htmlBody: template.html_body,
        textBody: template.text_body,
        variables
    });

    const transporter = nodemailer.createTransport({
        host: smtp.host,
        port: Number(smtp.port),
        secure: Number(smtp.secure) === 1 || Number(smtp.port) === 465,
        auth: { user: smtp.username, pass: smtp.password }
    });

    await transporter.sendMail({
        from: smtp.from_name ? `${smtp.from_name} <${smtp.from_email}>` : smtp.from_email,
        to,
        replyTo: smtp.reply_to || undefined,
        subject: rendered.subject,
        html: rendered.htmlBody,
        text: rendered.textBody || undefined
    });
}

function notifySaleInvoiceEmail(params) {
    void sendSaleInvoiceEmail(params).catch((err) => {
        console.error("Sale invoice email failed:", err?.message || err);
    });
}

// ==================== SALE REMINDER (Payment reminder) ====================
async function resolveSaleReminderTemplateId(branch_id) {
    const key = branchKey(branch_id);
    const [mapRows] = await pool.query(
        `SELECT sale_reminder FROM email_static_mapping
         WHERE branch_id = ?
           AND sale_reminder IS NOT NULL
           AND TRIM(sale_reminder) <> ''
         ORDER BY id ASC
         LIMIT 1`,
        [key]
    );
    if (mapRows.length && mapRows[0].sale_reminder) {
        return String(mapRows[0].sale_reminder).trim();
    }

    const bid = Number(branch_id);
    if (Number.isNaN(bid)) return null;
    const [fallback] = await pool.query(
        `SELECT template_id FROM email_static_templates
         WHERE branch_id = ? AND template_type = ? AND status = 'active'
         ORDER BY is_default DESC, id DESC
         LIMIT 1`,
        [bid, SALE_REMINDER_TEMPLATE_TYPE]
    );
    return fallback[0]?.template_id ? String(fallback[0].template_id).trim() : null;
}

/**
 * Send Sale Reminder Email for pending payments
 */
async function sendSaleReminderEmail({ branch_id, sale_id, invoice_no, party_id, party_type, due_date, amount_due, customer_name, customer_email }) {
    if (!branch_id || !sale_id) return;

    const template_id = await resolveSaleReminderTemplateId(branch_id);
    if (!template_id) return;

    const template = await loadActiveStaticTemplate(template_id);
    if (!template) return;

    const to = customer_email;
    if (!to) return;
    if (await isUnsubscribed(branch_id, to)) return;

    const config_id = await getDefaultActiveConfigId(branch_id);
    if (!config_id) return;

    const smtp = await getConfigWithDecryptedPassword({ branch_id, config_id });

    const variables = {
        customer_name: customer_name || party_id,
        invoice_no: invoice_no,
        due_date: formatDateOnly(due_date),
        amount_due: Number(amount_due).toFixed(2),
        days_overdue: Math.max(0, Math.floor((new Date() - new Date(due_date)) / (1000 * 60 * 60 * 24))),
        payment_link: `https://yourdomain.com/pay/${sale_id}`,
        contact_number: smtp.from_name ? "Contact us" : "Support"
    };

    const rendered = renderRecipientEmail({
        subject: template.subject,
        htmlBody: template.html_body,
        textBody: template.text_body,
        variables
    });

    const transporter = nodemailer.createTransport({
        host: smtp.host,
        port: Number(smtp.port),
        secure: Number(smtp.secure) === 1 || Number(smtp.port) === 465,
        auth: { user: smtp.username, pass: smtp.password }
    });

    await transporter.sendMail({
        from: smtp.from_name ? `${smtp.from_name} <${smtp.from_email}>` : smtp.from_email,
        to,
        replyTo: smtp.reply_to || undefined,
        subject: rendered.subject,
        html: rendered.htmlBody,
        text: rendered.textBody || undefined
    });
}

function notifySaleReminderEmail(params) {
    void sendSaleReminderEmail(params).catch((err) => {
        console.error("Sale reminder email failed:", err?.message || err);
    });
}

// ==================== EXPORTS ====================
export {
      getSaleItems,  
    sendSaleInvoiceEmail,
    notifySaleInvoiceEmail,
    sendSaleReminderEmail,
    notifySaleReminderEmail,
    SALE_INVOICE_TEMPLATE_TYPE,
    SALE_REMINDER_TEMPLATE_TYPE
};