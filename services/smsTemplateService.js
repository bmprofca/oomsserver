import crypto from "crypto";
import pool from "../db.js";

const VARIABLE_REGEX = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;

function newId(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function toStringSafe(value) {
    if (value === null || value === undefined) return "";
    return String(value);
}

function parseTemplateVariables(text) {
    const variableSet = new Set();
    const content = toStringSafe(text);
    let match = VARIABLE_REGEX.exec(content);
    while (match) {
        if (match[1]) {
            variableSet.add(match[1]);
        }
        match = VARIABLE_REGEX.exec(content);
    }
    VARIABLE_REGEX.lastIndex = 0;
    return Array.from(variableSet);
}

function renderSms(text, variables = {}) {
    return toStringSafe(text).replace(VARIABLE_REGEX, (_, key) => toStringSafe(variables?.[key]));
}

async function createTemplate({ branch_id, username, payload }) {
    const { template_name, message, dlt_template_id = null, status = "active" } = payload;
    if (!template_name || !message) throw new Error("template_name and message are required");
    if (!["active", "inactive"].includes(status)) throw new Error("Invalid status value");

    const template_id = newId("stpl");
    const variables = parseTemplateVariables(message);

    await pool.query(
        `INSERT INTO sms_templates
        (template_id, branch_id, template_name, message, dlt_template_id, variables_json, status, create_by, modify_by, create_date, modify_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [template_id, branch_id, template_name, message, dlt_template_id, JSON.stringify(variables), status, username || null, username || null]
    );

    return getTemplateDetails({ branch_id, template_id });
}

async function updateTemplate({ branch_id, username, payload }) {
    const { template_id, template_name, message, dlt_template_id, status } = payload;
    if (!template_id) throw new Error("template_id is required");

    const [rows] = await pool.query(
        "SELECT * FROM sms_templates WHERE branch_id = ? AND template_id = ? LIMIT 1",
        [branch_id, template_id]
    );
    if (!rows.length) throw new Error("Template not found");
    const existing = rows[0];

    const nextMessage = message ?? existing.message;
    const nextStatus = status ?? existing.status;
    if (!["active", "inactive"].includes(nextStatus)) throw new Error("Invalid status value");

    const variables = parseTemplateVariables(nextMessage);

    await pool.query(
        `UPDATE sms_templates
         SET template_name = ?, message = ?, dlt_template_id = ?, variables_json = ?, status = ?, modify_by = ?, modify_date = NOW()
         WHERE branch_id = ? AND template_id = ?`,
        [
            template_name ?? existing.template_name,
            nextMessage,
            dlt_template_id ?? existing.dlt_template_id,
            JSON.stringify(variables),
            nextStatus,
            username || null,
            branch_id,
            template_id
        ]
    );

    return getTemplateDetails({ branch_id, template_id });
}

async function listTemplates({ branch_id, page_no = 1, limit = 10 }) {
    const page = Math.max(Number(page_no) || 1, 1);
    const size = Math.max(Number(limit) || 10, 1);
    const offset = (page - 1) * size;

    const [rows] = await pool.query(
        `SELECT * FROM sms_templates
         WHERE branch_id = ?
         ORDER BY id DESC
         LIMIT ? OFFSET ?`,
        [branch_id, size, offset]
    );
    const [countRows] = await pool.query(
        "SELECT COUNT(*) AS total FROM sms_templates WHERE branch_id = ?",
        [branch_id]
    );
    const total = Number(countRows[0]?.total || 0);

    return {
        data: rows.map((row) => ({
            ...row,
            variables_json: row.variables_json ? JSON.parse(row.variables_json) : []
        })),
        pagination: {
            page_no: page,
            limit: size,
            total,
            total_pages: Math.ceil(total / size) || 1,
            has_more: page * size < total
        }
    };
}

async function getTemplateDetails({ branch_id, template_id }) {
    const [rows] = await pool.query(
        `SELECT * FROM sms_templates WHERE branch_id = ? AND template_id = ? LIMIT 1`,
        [branch_id, template_id]
    );
    if (!rows.length) throw new Error("Template not found");
    return {
        ...rows[0],
        variables_json: rows[0].variables_json ? JSON.parse(rows[0].variables_json) : []
    };
}

async function previewTemplate({ message = "", variables = {} }) {
    return {
        rendered: renderSms(message, variables)
    };
}

async function changeTemplateStatus({ branch_id, template_id, status, username }) {
    if (!["active", "inactive"].includes(status)) throw new Error("Invalid status value");
    const [result] = await pool.query(
        "UPDATE sms_templates SET status = ?, modify_by = ?, modify_date = NOW() WHERE branch_id = ? AND template_id = ?",
        [status, username || null, branch_id, template_id]
    );
    if (result.affectedRows === 0) throw new Error("Template not found");
    return getTemplateDetails({ branch_id, template_id });
}

async function getActiveTemplate({ branch_id, template_id }) {
    const [rows] = await pool.query(
        "SELECT * FROM sms_templates WHERE branch_id = ? AND template_id = ? AND status = 'active' LIMIT 1",
        [branch_id, template_id]
    );
    if (!rows.length) throw new Error("Active template not found");
    return rows[0];
}

export {
    createTemplate,
    updateTemplate,
    listTemplates,
    getTemplateDetails,
    previewTemplate,
    changeTemplateStatus,
    getActiveTemplate,
    parseTemplateVariables,
    renderSms
};
