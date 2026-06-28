import nodemailer from "nodemailer";
import pool from "../db.js";
import { getConfigWithDecryptedPassword } from "../services/emailConfigService.js";
import { renderRecipientEmail } from "../utils/templateRenderer.js";
import { USER_SNIPPED_DATA, BANK_SNIPPED_DATA, CAPITAL_SNIPPED_DATA } from "./function.js";

// Transaction Email Types (matching your mapping table)
const PAYMENT_RECEIPT_TEMPLATE_TYPE = "payment_receipt";
const PAYMENT_TEMPLATE_TYPE = "payment";
const RECEIVED_TEMPLATE_TYPE = "received";

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

// ==================== PAYMENT RECEIPT (When client pays) ====================
async function resolvePaymentReceiptTemplateId(branch_id) {
    const key = branchKey(branch_id);
    const [mapRows] = await pool.query(
        `SELECT payment_receipt FROM email_static_mapping
         WHERE branch_id = ?
           AND payment_receipt IS NOT NULL
           AND TRIM(payment_receipt) <> ''
         ORDER BY id ASC
         LIMIT 1`,
        [key]
    );
    if (mapRows.length && mapRows[0].payment_receipt) {
        return String(mapRows[0].payment_receipt).trim();
    }

    const bid = Number(branch_id);
    if (Number.isNaN(bid)) return null;
    const [fallback] = await pool.query(
        `SELECT template_id FROM email_static_templates
         WHERE branch_id = ? AND template_type = ? AND status = 'active'
         ORDER BY is_default DESC, id DESC
         LIMIT 1`,
        [bid, PAYMENT_RECEIPT_TEMPLATE_TYPE]
    );
    return fallback[0]?.template_id ? String(fallback[0].template_id).trim() : null;
}

/**
 * Send Payment Receipt Email (when client makes a payment)
 */
async function sendPaymentReceiptEmail({ branch_id, transaction_id, amount, party1_id, party1_type, party2_id, party2_type, transaction_date, remark, invoice_no }) {
    if (!branch_id || !transaction_id) return;

    const template_id = await resolvePaymentReceiptTemplateId(branch_id);
    if (!template_id) return;

    const template = await loadActiveStaticTemplate(template_id);
    if (!template) return;

    // Get client details (party1 is the client making payment)
    const clientData = await USER_SNIPPED_DATA(party1_id);
    const to = clientData?.email;
    
    if (!to) return;
    if (await isUnsubscribed(branch_id, to)) return;

    // Get bank/capital details where money is received
    let receivedInto = {};
    if (party2_type === 'bank') {
        receivedInto = await BANK_SNIPPED_DATA(party2_id);
    } else if (party2_type === 'capital') {
        receivedInto = await CAPITAL_SNIPPED_DATA(party2_id);
    }

    const config_id = await getDefaultActiveConfigId(branch_id);
    if (!config_id) return;

    const smtp = await getConfigWithDecryptedPassword({ branch_id, config_id });

    const variables = {
        client_name: clientData?.name || clientData?.username || party1_id,
        amount: Number(amount).toFixed(2),
        received_into: receivedInto?.holder || receivedInto?.name || party2_id,
        received_into_type: party2_type,
        transaction_date: formatDateTime(transaction_date),
        transaction_id: transaction_id,
        invoice_no: invoice_no || "N/A",
        remark: remark || "No remark provided",
        payment_method: party2_type === 'bank' ? 'Bank Transfer' : 'Cash/Capital'
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

function notifyPaymentReceiptEmail(params) {
    void sendPaymentReceiptEmail(params).catch((err) => {
        console.error("Payment receipt email failed:", err?.message || err);
    });
}

// ==================== PAYMENT (When company pays to someone) ====================
async function resolvePaymentTemplateId(branch_id) {
    const key = branchKey(branch_id);
    const [mapRows] = await pool.query(
        `SELECT payment FROM email_static_mapping
         WHERE branch_id = ?
           AND payment IS NOT NULL
           AND TRIM(payment) <> ''
         ORDER BY id ASC
         LIMIT 1`,
        [key]
    );
    if (mapRows.length && mapRows[0].payment) {
        return String(mapRows[0].payment).trim();
    }

    const bid = Number(branch_id);
    if (Number.isNaN(bid)) return null;
    const [fallback] = await pool.query(
        `SELECT template_id FROM email_static_templates
         WHERE branch_id = ? AND template_type = ? AND status = 'active'
         ORDER BY is_default DESC, id DESC
         LIMIT 1`,
        [bid, PAYMENT_TEMPLATE_TYPE]
    );
    return fallback[0]?.template_id ? String(fallback[0].template_id).trim() : null;
}

/**
 * Send Payment Email (when company makes a payment to vendor/supplier)
 */
async function sendPaymentEmail({ branch_id, transaction_id, amount, party1_id, party1_type, party2_id, party2_type, transaction_date, remark, invoice_no }) {
    if (!branch_id || !transaction_id) return;

    const template_id = await resolvePaymentTemplateId(branch_id);
    if (!template_id) return;

    const template = await loadActiveStaticTemplate(template_id);
    if (!template) return;

    // Get vendor/client details (party2 is the receiver)
    const receiverData = await USER_SNIPPED_DATA(party2_id);
    const to = receiverData?.email;
    
    if (!to) return;
    if (await isUnsubscribed(branch_id, to)) return;

    // Get bank details where payment is sent from
    let sentFrom = {};
    if (party1_type === 'bank') {
        sentFrom = await BANK_SNIPPED_DATA(party1_id);
    } else if (party1_type === 'capital') {
        sentFrom = await CAPITAL_SNIPPED_DATA(party1_id);
    }

    const config_id = await getDefaultActiveConfigId(branch_id);
    if (!config_id) return;

    const smtp = await getConfigWithDecryptedPassword({ branch_id, config_id });

    const variables = {
        receiver_name: receiverData?.name || receiverData?.username || party2_id,
        amount: Number(amount).toFixed(2),
        sent_from: sentFrom?.holder || sentFrom?.name || party1_id,
        sent_from_type: party1_type,
        transaction_date: formatDateTime(transaction_date),
        transaction_id: transaction_id,
        invoice_no: invoice_no || "N/A",
        remark: remark || "No remark provided"
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

function notifyPaymentEmail(params) {
    void sendPaymentEmail(params).catch((err) => {
        console.error("Payment email failed:", err?.message || err);
    });
}

// ==================== RECEIVED (Money received from client - alias) ====================
async function resolveReceivedTemplateId(branch_id) {
    const key = branchKey(branch_id);
    const [mapRows] = await pool.query(
        `SELECT received FROM email_static_mapping
         WHERE branch_id = ?
           AND received IS NOT NULL
           AND TRIM(received) <> ''
         ORDER BY id ASC
         LIMIT 1`,
        [key]
    );
    if (mapRows.length && mapRows[0].received) {
        return String(mapRows[0].received).trim();
    }

    const bid = Number(branch_id);
    if (Number.isNaN(bid)) return null;
    const [fallback] = await pool.query(
        `SELECT template_id FROM email_static_templates
         WHERE branch_id = ? AND template_type = ? AND status = 'active'
         ORDER BY is_default DESC, id DESC
         LIMIT 1`,
        [bid, RECEIVED_TEMPLATE_TYPE]
    );
    return fallback[0]?.template_id ? String(fallback[0].template_id).trim() : null;
}

/**
 * Send Received Email (money received from client)
 */
async function sendReceivedEmail({ branch_id, transaction_id, amount, party1_id, party1_type, party2_id, party2_type, transaction_date, remark, invoice_no }) {
    if (!branch_id || !transaction_id) return;

    const template_id = await resolveReceivedTemplateId(branch_id);
    if (!template_id) return;

    const template = await loadActiveStaticTemplate(template_id);
    if (!template) return;

    // Get client details (party1 is the client)
    const clientData = await USER_SNIPPED_DATA(party1_id);
    const to = clientData?.email;
    
    if (!to) return;
    if (await isUnsubscribed(branch_id, to)) return;

    const config_id = await getDefaultActiveConfigId(branch_id);
    if (!config_id) return;

    const smtp = await getConfigWithDecryptedPassword({ branch_id, config_id });

    const variables = {
        client_name: clientData?.name || clientData?.username || party1_id,
        amount: Number(amount).toFixed(2),
        transaction_date: formatDateTime(transaction_date),
        invoice_no: invoice_no || "N/A",
        remark: remark || "No remark provided"
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

function notifyReceivedEmail(params) {
    void sendReceivedEmail(params).catch((err) => {
        console.error("Received email failed:", err?.message || err);
    });
}

// ==================== EXPORTS ====================
export {
    // Payment Receipt
    sendPaymentReceiptEmail,
    notifyPaymentReceiptEmail,
    PAYMENT_RECEIPT_TEMPLATE_TYPE,
    
    // Payment
    sendPaymentEmail,
    notifyPaymentEmail,
    PAYMENT_TEMPLATE_TYPE,
    
    // Received
    sendReceivedEmail,
    notifyReceivedEmail,
    RECEIVED_TEMPLATE_TYPE
};