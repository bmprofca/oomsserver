import crypto from "crypto";
import pool from "../db.js";

/** The only branch notification types. Independent from campaign Email Templates. */
export const EMAIL_STATIC_TEMPLATE_TYPES = {
    PAYMENT_REMINDER: "Payment Reminder",
    TASK_CREATE: "Task Create",
    PAYMENT: "Payment",
    PAYMENT_RECEIVE: "Payment Receive",
    TASK_COMPLETE: "Task Complete",
    DOCUMENT_SHARE: "Document Share",
    BIRTHDAY_WISH: "Birthday Wish",
};

export const STATIC_TYPE_LIST = Object.values(EMAIL_STATIC_TEMPLATE_TYPES);

const STARTERS = {
    [EMAIL_STATIC_TEMPLATE_TYPES.PAYMENT_REMINDER]: {
        subject: "Payment reminder for {{name}}",
        html_body: "<p>Hello {{name}},</p><p>This is a reminder that your outstanding balance is <strong>{{balance}}</strong>.</p>",
        variables: ["name", "balance"],
    },
    [EMAIL_STATIC_TEMPLATE_TYPES.TASK_CREATE]: {
        subject: "New task for {{firm_name}}: {{task_name}}",
        html_body: "<p>A new task has been created for <strong>{{firm_name}}</strong>.</p><p>Service: {{task_name}}<br/>Due: {{due_date}}<br/>Amount: {{fees}}</p>",
        variables: ["firm_name", "task_name", "due_date", "fees", "create_date", "create_by"],
    },
    [EMAIL_STATIC_TEMPLATE_TYPES.PAYMENT]: {
        subject: "Payment of {{amount}} has been sent",
        html_body: "<p>Hello {{receiver_name}},</p><p>A payment of <strong>{{amount}}</strong> was sent on {{transaction_date}}.</p>",
        variables: ["receiver_name", "amount", "transaction_date", "transaction_id"],
    },
    [EMAIL_STATIC_TEMPLATE_TYPES.PAYMENT_RECEIVE]: {
        subject: "We received your payment of {{amount}}",
        html_body: "<p>Hello {{client_name}},</p><p>We received your payment of <strong>{{amount}}</strong> on {{transaction_date}}.</p>",
        variables: ["client_name", "amount", "transaction_date", "transaction_id"],
    },
    [EMAIL_STATIC_TEMPLATE_TYPES.TASK_COMPLETE]: {
        subject: "Task completed for {{firm_name}}: {{task_name}}",
        html_body: "<p>The task <strong>{{task_name}}</strong> for {{firm_name}} has been completed.</p>",
        variables: ["firm_name", "task_name", "create_by"],
    },
    [EMAIL_STATIC_TEMPLATE_TYPES.DOCUMENT_SHARE]: {
        subject: "{{document_name}} has been shared with you",
        html_body: "<p>Hello {{name}},</p><p>{{shared_by}} shared <strong>{{document_name}}</strong> with you.</p><p><a href=\"{{document_link}}\">Open document</a></p>",
        variables: ["name", "document_name", "document_link", "shared_by"],
    },
    [EMAIL_STATIC_TEMPLATE_TYPES.BIRTHDAY_WISH]: {
        subject: "Happy birthday {{name}}",
        html_body: "<p>Happy birthday {{name}}!</p><p>Wishing you a wonderful year ahead.</p>",
        variables: ["name"],
    },
};

const ALIAS_TO_CANONICAL = {
    "payment reminder": EMAIL_STATIC_TEMPLATE_TYPES.PAYMENT_REMINDER,
    payment_reminder: EMAIL_STATIC_TEMPLATE_TYPES.PAYMENT_REMINDER,
    "payment-reminder": EMAIL_STATIC_TEMPLATE_TYPES.PAYMENT_REMINDER,

    "task create": EMAIL_STATIC_TEMPLATE_TYPES.TASK_CREATE,
    task_create: EMAIL_STATIC_TEMPLATE_TYPES.TASK_CREATE,
    "task-create": EMAIL_STATIC_TEMPLATE_TYPES.TASK_CREATE,

    payment: EMAIL_STATIC_TEMPLATE_TYPES.PAYMENT,

    "payment receive": EMAIL_STATIC_TEMPLATE_TYPES.PAYMENT_RECEIVE,
    payment_receive: EMAIL_STATIC_TEMPLATE_TYPES.PAYMENT_RECEIVE,
    "payment-receive": EMAIL_STATIC_TEMPLATE_TYPES.PAYMENT_RECEIVE,
    "payment receipt": EMAIL_STATIC_TEMPLATE_TYPES.PAYMENT_RECEIVE,
    payment_receipt: EMAIL_STATIC_TEMPLATE_TYPES.PAYMENT_RECEIVE,
    "payment-receipt": EMAIL_STATIC_TEMPLATE_TYPES.PAYMENT_RECEIVE,
    receive: EMAIL_STATIC_TEMPLATE_TYPES.PAYMENT_RECEIVE,
    received: EMAIL_STATIC_TEMPLATE_TYPES.PAYMENT_RECEIVE,

    "task complete": EMAIL_STATIC_TEMPLATE_TYPES.TASK_COMPLETE,
    task_complete: EMAIL_STATIC_TEMPLATE_TYPES.TASK_COMPLETE,
    "task-complete": EMAIL_STATIC_TEMPLATE_TYPES.TASK_COMPLETE,

    "document share": EMAIL_STATIC_TEMPLATE_TYPES.DOCUMENT_SHARE,
    document_share: EMAIL_STATIC_TEMPLATE_TYPES.DOCUMENT_SHARE,
    "document-share": EMAIL_STATIC_TEMPLATE_TYPES.DOCUMENT_SHARE,
    "document sharing": EMAIL_STATIC_TEMPLATE_TYPES.DOCUMENT_SHARE,
    document_sharing: EMAIL_STATIC_TEMPLATE_TYPES.DOCUMENT_SHARE,
    "document-sharing": EMAIL_STATIC_TEMPLATE_TYPES.DOCUMENT_SHARE,

    "birthday wish": EMAIL_STATIC_TEMPLATE_TYPES.BIRTHDAY_WISH,
    birthday_wish: EMAIL_STATIC_TEMPLATE_TYPES.BIRTHDAY_WISH,
    "birthday-wish": EMAIL_STATIC_TEMPLATE_TYPES.BIRTHDAY_WISH,
    birthday: EMAIL_STATIC_TEMPLATE_TYPES.BIRTHDAY_WISH,
    "birthday reminder": EMAIL_STATIC_TEMPLATE_TYPES.BIRTHDAY_WISH,
    birthday_reminder: EMAIL_STATIC_TEMPLATE_TYPES.BIRTHDAY_WISH,
    "birthday-reminder": EMAIL_STATIC_TEMPLATE_TYPES.BIRTHDAY_WISH,
};

const EXTRA_ALIASES = Object.fromEntries(
    STATIC_TYPE_LIST.map((type) => [
        type,
        Object.entries(ALIAS_TO_CANONICAL)
            .filter(([, canonical]) => canonical === type)
            .map(([alias]) => alias),
    ])
);

function titleCaseWords(raw) {
    return String(raw || "")
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

export function formatEmailTemplateType(raw) {
    if (raw == null || String(raw).trim() === "") return "";
    const key = String(raw).trim().toLowerCase();
    const compact = key.replace(/[\s_-]+/g, " ");
    return ALIAS_TO_CANONICAL[key] || ALIAS_TO_CANONICAL[compact] || titleCaseWords(raw);
}

export function isCanonicalStaticType(raw) {
    return STATIC_TYPE_LIST.includes(formatEmailTemplateType(raw));
}

export function emailTemplateTypeCandidates(raw) {
    const formatted = formatEmailTemplateType(raw);
    if (!formatted) return [];

    const compact = formatted.toLowerCase();
    const candidates = new Set([
        formatted,
        compact,
        compact.replace(/ /g, "_"),
        compact.replace(/ /g, "-"),
        String(raw || "").trim(),
        String(raw || "").trim().toLowerCase(),
    ]);

    (EXTRA_ALIASES[formatted] || []).forEach((alias) => candidates.add(alias));
    return [...candidates].map((item) => String(item).trim()).filter(Boolean);
}

export function emailTemplateTypeSqlIn(column = "template_type", rawType) {
    const lowers = [...new Set(emailTemplateTypeCandidates(rawType).map((item) => item.toLowerCase()))];
    if (!lowers.length) return { sql: "1=0", params: [] };
    return {
        sql: `LOWER(TRIM(${column})) IN (${lowers.map(() => "?").join(", ")})`,
        params: lowers,
    };
}

function queryFn(connection) {
    return connection ? connection.query.bind(connection) : pool.query.bind(pool);
}

export async function getActiveBranchSmtpConfigId(branch_id) {
    const [rows] = await pool.query(
        `SELECT config_id FROM email_configs
         WHERE branch_id = ? AND status = 'active'
         ORDER BY id DESC
         LIMIT 1`,
        [branch_id]
    );
    return rows[0]?.config_id || null;
}

/** Active static template of a notification type — used only when that type is activated. */
export async function findActiveStaticTemplate(branch_id, typeRaw) {
    const formatted = formatEmailTemplateType(typeRaw);
    if (!isCanonicalStaticType(formatted)) return null;

    const { sql, params } = emailTemplateTypeSqlIn("template_type", formatted);
    const [rows] = await pool.query(
        `SELECT
            template_id, template_type, template_name, subject,
            html_body, text_body, variables_json, status
         FROM email_static_templates
         WHERE branch_id = ? AND status = 'active' AND ${sql}
         ORDER BY id DESC
         LIMIT 1`,
        [branch_id, ...params]
    );
    return rows[0] || null;
}

export async function findActiveStaticTemplateId(branch_id, typeRaw) {
    const row = await findActiveStaticTemplate(branch_id, typeRaw);
    return row?.template_id ? String(row.template_id).trim() : null;
}

/** Ensure each branch has exactly the 7 static notification slots. */
export async function ensureBranchStaticCatalog(branch_id, username = "system", connection = null) {
    const q = queryFn(connection);
    const created = [];

    for (const type of STATIC_TYPE_LIST) {
        const { sql, params } = emailTemplateTypeSqlIn("template_type", type);
        const [existing] = await q(
            `SELECT template_id FROM email_static_templates
             WHERE branch_id = ? AND ${sql}
             ORDER BY FIELD(status, 'active', 'inactive') DESC, id DESC
             LIMIT 1`,
            [branch_id, ...params]
        );
        if (existing?.[0]?.template_id || existing?.template_id) continue;

        const starter = STARTERS[type];
        const template_id = `stpl_${crypto.randomBytes(8).toString("hex")}`;
        await q(
            `INSERT INTO email_static_templates
             (template_id, branch_id, template_type, template_name, subject, html_body, text_body,
              variables_json, status, is_default, create_by, modify_by, create_date, modify_date)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'inactive', 0, ?, ?, NOW(), NOW())`,
            [
                template_id,
                branch_id,
                type,
                type,
                starter.subject,
                starter.html_body,
                "",
                JSON.stringify(starter.variables),
                username,
                username,
            ]
        );
        created.push(type);
    }

    const [rows] = await q(
        `SELECT template_id, template_type, template_name, subject, html_body, text_body,
                variables_json, status, create_date, modify_date
         FROM email_static_templates
         WHERE branch_id = ?`,
        [branch_id]
    );

    const byType = new Map();
    for (const row of rows || []) {
        const type = formatEmailTemplateType(row.template_type);
        if (!isCanonicalStaticType(type)) continue;
        if (!byType.has(type)) byType.set(type, { ...row, template_type: type });
    }

    return STATIC_TYPE_LIST.map((type) => byType.get(type)).filter(Boolean);
}

const v = (name, label, description, example) => ({ name, label, description, example });

export const STATIC_TEMPLATE_VARIABLES = {
    [EMAIL_STATIC_TEMPLATE_TYPES.PAYMENT_REMINDER]: [
        v("name", "Client name", "Recipient display name", "Rahul Sharma"),
        v("username", "Username", "Client login / party id", "rahul01"),
        v("email", "Email", "Client email address", "rahul@example.com"),
        v("mobile", "Mobile", "Client mobile number", "9876543210"),
        v("firm_name", "Firm name", "Primary firm of the client", "Rahul & Co."),
        v("balance", "Outstanding balance", "Formatted outstanding amount", "₹12,500"),
        v("debit_amount", "Debit amount", "Formatted debit total", "₹15,000"),
        v("credit_amount", "Credit amount", "Formatted credit total", "₹2,500"),
        v("total_due_amount", "Total due", "Sum of pending invoices", "₹12,500"),
        v("invoice_table", "Invoice table", "HTML table of pending invoices", "<table>…</table>"),
        v("max_days_overdue", "Days overdue", "Largest overdue day count", "12"),
        v("urgency_badge", "Urgency badge", "Overdue urgency label", "🟡 Medium"),
        v("payment_link", "Payment link", "Link for the client to pay", "https://app.example.com/pay"),
        v("current_date", "Current date", "Today's date", "08/09/2026"),
    ],
    [EMAIL_STATIC_TEMPLATE_TYPES.TASK_CREATE]: [
        v("firm_name", "Firm name", "Firm the task belongs to", "Rahul & Co."),
        v("task_name", "Task / service name", "Service name of the new task", "GST Return"),
        v("due_date", "Due date", "Task due date", "2026-09-20"),
        v("fees", "Fees", "Task amount", "2500.00"),
        v("create_date", "Created on", "When the task was created", "2026-09-08 10:30"),
        v("create_by", "Created by", "Staff who created the task", "Anita"),
    ],
    [EMAIL_STATIC_TEMPLATE_TYPES.TASK_COMPLETE]: [
        v("firm_name", "Firm name", "Firm the task belongs to", "Rahul & Co."),
        v("task_name", "Task / service name", "Completed service name", "GST Return"),
        v("due_date", "Due date", "Original due date", "2026-09-20"),
        v("fees", "Fees", "Task amount", "2500.00"),
        v("create_by", "Created by", "Staff who created the task", "Anita"),
        v("completed_by", "Completed by", "Staff who completed the task", "Anita"),
        v("complete_date", "Completed on", "Completion date and time", "2026-09-08 18:00"),
    ],
    [EMAIL_STATIC_TEMPLATE_TYPES.PAYMENT]: [
        v("receiver_name", "Receiver name", "Vendor or party who received the payment", "ABC Supplies"),
        v("amount", "Amount", "Payment amount", "5000.00"),
        v("transaction_date", "Transaction date", "When the payment was sent", "2026-09-08 11:00"),
        v("transaction_id", "Transaction id", "Internal transaction id", "txn_8f2a"),
        v("invoice_no", "Invoice no", "Linked invoice number if any", "PAY/12"),
        v("sent_from", "Sent from", "Bank or cash account used", "HDFC Current"),
        v("remark", "Remark", "Payment remark", "September dues"),
    ],
    [EMAIL_STATIC_TEMPLATE_TYPES.PAYMENT_RECEIVE]: [
        v("client_name", "Client name", "Client who paid", "Rahul Sharma"),
        v("amount", "Amount", "Amount received", "3500.00"),
        v("transaction_date", "Transaction date", "When the payment was received", "2026-09-08 11:00"),
        v("transaction_id", "Transaction id", "Internal transaction id", "txn_9c11"),
        v("invoice_no", "Invoice no", "Linked invoice number if any", "REC/8"),
        v("received_into", "Received into", "Bank or cash account credited", "HDFC Current"),
        v("payment_method", "Payment method", "How the money was received", "Bank Transfer"),
        v("remark", "Remark", "Receipt remark", "Against invoice SAL/44"),
    ],
    [EMAIL_STATIC_TEMPLATE_TYPES.DOCUMENT_SHARE]: [
        v("name", "Recipient name", "Person the file is shared with", "Rahul Sharma"),
        v("email", "Recipient email", "Email the file is sent to", "rahul@example.com"),
        v("mobile", "Recipient mobile", "Mobile used on the share modal", "9876543210"),
        v("firm_name", "Firm / party name", "Related firm or ledger party", "Rahul & Co."),
        v("document_name", "Document name", "File name of the shared document", "Ledger_Sep.pdf"),
        v("document_link", "Document link", "Download link (file is also attached)", "https://cdn.example.com/file.pdf"),
        v("shared_by", "Shared by", "Staff who shared the file", "Anita"),
        v("remark", "Remark", "Share note (ledger range, invoice label, etc.)", "Ledger 01-09-2026 to 08-09-2026"),
    ],
    [EMAIL_STATIC_TEMPLATE_TYPES.BIRTHDAY_WISH]: [
        v("name", "Client name", "Birthday person's name", "Rahul Sharma"),
        v("email", "Email", "Client email", "rahul@example.com"),
        v("mobile", "Mobile", "Client mobile", "9876543210"),
        v("firm_name", "Firm name", "Primary firm", "Rahul & Co."),
        v("company", "Branch / company", "Branch display name", "OneSaaS Accounts"),
        v("birthday_date", "Birthday date", "Formatted date of birth", "08 September"),
        v("age", "Age", "Completed years", "34"),
        v("username", "Username", "Client username", "rahul01"),
    ],
};

export function getSuggestedStaticVariables(typeRaw) {
    const type = formatEmailTemplateType(typeRaw);
    return STATIC_TEMPLATE_VARIABLES[type] || [];
}
