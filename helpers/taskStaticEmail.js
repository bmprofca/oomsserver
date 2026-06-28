import nodemailer from "nodemailer";
import pool from "../db.js";
import { getConfigWithDecryptedPassword } from "../services/emailConfigService.js";
import { renderRecipientEmail } from "../utils/templateRenderer.js";
import { USER_SNIPPED_DATA } from "./function.js";

const TASK_CREATE_TEMPLATE_TYPE = "task create";
const TASK_COMPLETE_TEMPLATE_TYPE = "task complete";
const TASK_CANCEL_TEMPLATE_TYPE = "task cancel";

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

async function resolveTaskCreateTemplateId(branch_id) {
    const key = branchKey(branch_id);
    const [mapRows] = await pool.query(
        `SELECT task_create FROM email_static_mapping
         WHERE branch_id = ?
           AND task_create IS NOT NULL
           AND TRIM(task_create) <> ''
         ORDER BY id ASC
         LIMIT 1`,
        [key]
    );
    if (mapRows.length && mapRows[0].task_create) {
        return String(mapRows[0].task_create).trim();
    }

    const bid = Number(branch_id);
    if (Number.isNaN(bid)) return null;
    const [fallback] = await pool.query(
        `SELECT template_id FROM email_static_templates
         WHERE branch_id = ? AND template_type = ? AND status = 'active'
         ORDER BY is_default DESC, id DESC
         LIMIT 1`,
        [bid, TASK_CREATE_TEMPLATE_TYPE]
    );
    return fallback[0]?.template_id ? String(fallback[0].template_id).trim() : null;
}
async function resolveTaskCompleteTemplateId(branch_id) {
    const key = branchKey(branch_id);
    const [mapRows] = await pool.query(
        `SELECT task_complete FROM email_static_mapping
         WHERE branch_id = ?
           AND task_complete IS NOT NULL
           AND TRIM(task_complete) <> ''
         ORDER BY id ASC
         LIMIT 1`,
        [key]
    );
    if (mapRows.length && mapRows[0].task_complete) {
        return String(mapRows[0].task_complete).trim();
    }

    const bid = Number(branch_id);
    if (Number.isNaN(bid)) return null;
    const [fallback] = await pool.query(
        `SELECT template_id FROM email_static_templates
         WHERE branch_id = ? AND template_type = ? AND status = 'active'
         ORDER BY is_default DESC, id DESC
         LIMIT 1`,
        [bid, TASK_COMPLETE_TEMPLATE_TYPE]
    );
    return fallback[0]?.template_id ? String(fallback[0].template_id).trim() : null;
}

async function resolveTaskCancelTemplateId(branch_id) {
    const key = branchKey(branch_id);
    const [mapRows] = await pool.query(
        `SELECT task_cancel FROM email_static_mapping
         WHERE branch_id = ?
           AND task_cancel IS NOT NULL
           AND TRIM(task_cancel) <> ''
         ORDER BY id ASC
         LIMIT 1`,
        [key]
    );
    if (mapRows.length && mapRows[0].task_cancel) {
        return String(mapRows[0].task_cancel).trim();
    }

    const bid = Number(branch_id);
    if (Number.isNaN(bid)) return null;
    const [fallback] = await pool.query(
        `SELECT template_id FROM email_static_templates
         WHERE branch_id = ? AND template_type = ? AND status = 'active'
         ORDER BY is_default DESC, id DESC
         LIMIT 1`,
        [bid, TASK_CANCEL_TEMPLATE_TYPE]
    );
    return fallback[0]?.template_id ? String(fallback[0].template_id).trim() : null;
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

async function fetchTaskEmailContext(branch_id, task_id) {
    const [rows] = await pool.query(
        `SELECT
            t.task_id,
            t.branch_id,
            t.firm_id,
            t.service_id,
            t.total,
            t.due_date,
            t.create_date,
            t.create_by,
            s.name AS service_name,
            f.firm_name
         FROM tasks t
         LEFT JOIN services s ON s.service_id = t.service_id
         LEFT JOIN firms f
           ON f.firm_id = t.firm_id
          AND f.branch_id = t.branch_id
          AND (f.is_deleted = '0' OR f.is_deleted = 0)
         WHERE t.task_id = ? AND t.branch_id = ?
         LIMIT 1`,
        [task_id, branch_id]
    );
    return rows[0] || null;
}

/**
 * Resolve recipient email from firm_id: firms.username → profile (active row) email.
 * Same pattern as payments — client username comes from the firm, not the request body.
 */
async function resolveFirmRecipientEmail(firm_id, branch_id) {
    const [rows] = await pool.query(
        `SELECT TRIM(p.email) AS email
         FROM firms f
         INNER JOIN profile p
           ON p.username = f.username
          AND p.status = '1'
         WHERE f.firm_id = ?
           AND f.branch_id = ?
           AND f.username IS NOT NULL
           AND TRIM(f.username) <> ''
           AND (f.is_deleted = '0' OR f.is_deleted = 0)
         ORDER BY p.id DESC
         LIMIT 1`,
        [firm_id, branch_id]
    );
    const email = rows[0]?.email;
    return email && isValidEmail(email) ? String(email).trim() : null;
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

/**
 * Sends the branch-configured static "task create" email after a task row exists.
 * Failures are logged only; task creation must not depend on email.
 */
async function sendTaskCreatedEmail({ branch_id, task_id }) {
    if (!branch_id || !task_id) return;

    const template_id = await resolveTaskCreateTemplateId(branch_id);
    if (!template_id) return;

    const template = await loadActiveStaticTemplate(template_id);
    if (!template) return;

    if (String(template.branch_id).trim() !== String(branch_id).trim()) {
        return;
    }

    const taskRow = await fetchTaskEmailContext(branch_id, task_id);
    if (!taskRow) return;

    const to = await resolveFirmRecipientEmail(taskRow.firm_id, branch_id);
    if (!to) return;

    if (await isUnsubscribed(branch_id, to)) return;

    const config_id = await getDefaultActiveConfigId(branch_id);
    if (!config_id) return;

    const smtp = await getConfigWithDecryptedPassword({ branch_id, config_id });

    const creator = await USER_SNIPPED_DATA(taskRow.create_by || "");
    const create_by_display = (creator?.name && String(creator.name).trim()) || creator?.username || String(taskRow.create_by || "").trim() || "";

    const variables = {
        task_name: taskRow.service_name != null ? String(taskRow.service_name) : "",
        create_date: formatDateTime(taskRow.create_date),
        create_by: create_by_display,
        fees: taskRow.total != null ? Number(taskRow.total).toFixed(2) : "",
        due_date: formatDateOnly(taskRow.due_date),
        firm_name: taskRow.firm_name != null ? String(taskRow.firm_name) : ""
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

/**
 * Sends the branch-configured static "task complete" email after a task is completed
 */
async function sendTaskCompletedEmail({ branch_id, task_id, completed_by }) {
    if (!branch_id || !task_id) return;

    const template_id = await resolveTaskCompleteTemplateId(branch_id);
    if (!template_id) return;

    const template = await loadActiveStaticTemplate(template_id);
    if (!template) return;

    if (String(template.branch_id).trim() !== String(branch_id).trim()) {
        return;
    }

    const taskRow = await fetchTaskEmailContext(branch_id, task_id);
    if (!taskRow) return;

    const to = await resolveFirmRecipientEmail(taskRow.firm_id, branch_id);
    if (!to) return;

    if (await isUnsubscribed(branch_id, to)) return;

    const config_id = await getDefaultActiveConfigId(branch_id);
    if (!config_id) return;

    const smtp = await getConfigWithDecryptedPassword({ branch_id, config_id });

    const creator = await USER_SNIPPED_DATA(taskRow.create_by || "");
    const create_by_display = (creator?.name && String(creator.name).trim()) || creator?.username || String(taskRow.create_by || "").trim() || "";

    const completer = await USER_SNIPPED_DATA(completed_by || "");
    const completed_by_display = (completer?.name && String(completer.name).trim()) || completer?.username || String(completed_by || "").trim() || "";

    const variables = {
        task_name: taskRow.service_name != null ? String(taskRow.service_name) : "",
        create_date: formatDateTime(taskRow.create_date),
        create_by: create_by_display,
        complete_date: formatDateTime(new Date()),
        completed_by: completed_by_display,
        fees: taskRow.total != null ? Number(taskRow.total).toFixed(2) : "",
        due_date: formatDateOnly(taskRow.due_date),
        firm_name: taskRow.firm_name != null ? String(taskRow.firm_name) : ""
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

/**
 * Sends the branch-configured static "task cancel" email after a task is cancelled
 */
async function sendTaskCanceledEmail({ branch_id, task_id, cancelled_by, cancel_reason = null }) {
    if (!branch_id || !task_id) return;

    const template_id = await resolveTaskCancelTemplateId(branch_id);
    if (!template_id) return;

    const template = await loadActiveStaticTemplate(template_id);
    if (!template) return;

    if (String(template.branch_id).trim() !== String(branch_id).trim()) {
        return;
    }

    const taskRow = await fetchTaskEmailContext(branch_id, task_id);
    if (!taskRow) return;

    const to = await resolveFirmRecipientEmail(taskRow.firm_id, branch_id);
    if (!to) return;

    if (await isUnsubscribed(branch_id, to)) return;

    const config_id = await getDefaultActiveConfigId(branch_id);
    if (!config_id) return;

    const smtp = await getConfigWithDecryptedPassword({ branch_id, config_id });

    const creator = await USER_SNIPPED_DATA(taskRow.create_by || "");
    const create_by_display = (creator?.name && String(creator.name).trim()) || creator?.username || String(taskRow.create_by || "").trim() || "";

    const canceller = await USER_SNIPPED_DATA(cancelled_by || "");
    const cancelled_by_display = (canceller?.name && String(canceller.name).trim()) || canceller?.username || String(cancelled_by || "").trim() || "";

    const variables = {
        task_name: taskRow.service_name != null ? String(taskRow.service_name) : "",
        create_date: formatDateTime(taskRow.create_date),
        create_by: create_by_display,
        cancel_date: formatDateTime(new Date()),
        cancelled_by: cancelled_by_display,
        cancel_reason: cancel_reason || "Not specified",
        fees: taskRow.total != null ? Number(taskRow.total).toFixed(2) : "",
        due_date: formatDateOnly(taskRow.due_date),
        firm_name: taskRow.firm_name != null ? String(taskRow.firm_name) : ""
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

function notifyTaskCanceledEmail({ branch_id, task_id, cancelled_by, cancel_reason = null }) {
    void sendTaskCanceledEmail({ branch_id, task_id, cancelled_by, cancel_reason }).catch((err) => {
        console.error("Task cancel email failed:", err?.message || err);
    });
}
function notifyTaskCreatedEmail({ branch_id, task_id }) {
    void sendTaskCreatedEmail({ branch_id, task_id }).catch((err) => {
        console.error("Task create email failed:", err?.message || err);
    });
}

function notifyTaskCompletedEmail({ branch_id, task_id, completed_by }) {
    void sendTaskCompletedEmail({ branch_id, task_id, completed_by }).catch((err) => {
        console.error("Task complete email failed:", err?.message || err);
    });
}

export {
    sendTaskCreatedEmail,
    notifyTaskCreatedEmail,
    sendTaskCompletedEmail,
    notifyTaskCompletedEmail,
    sendTaskCanceledEmail,
    notifyTaskCanceledEmail,
    TASK_CREATE_TEMPLATE_TYPE,
    TASK_COMPLETE_TEMPLATE_TYPE,
    TASK_CANCEL_TEMPLATE_TYPE
};