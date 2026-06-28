import crypto from "crypto";
import pool from "../db.js";
import {
    buildStoredVariablesJson,
    normalizeStoredVariablesJson,
    parseVariableNamesFromText,
} from "../utils/whatsappWebVariables.js";

const TEMPLATE_TYPES = ["text", "image", "video", "document", "audio"];

const CONTENT_FIELDS = {
    text: { required: ["message"], optional: [] },
    image: { required: ["url"], optional: ["caption"] },
    video: { required: ["url"], optional: ["caption"] },
    document: { required: ["url", "filename"], optional: ["caption"] },
    audio: { required: ["url"], optional: [] },
};

function newId(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function parseTemplateVariables(text) {
    return parseVariableNamesFromText(text);
}

function parseVariablesFromContent(content) {
    return buildStoredVariablesJson(content);
}

function normalizeContentInput(payload) {
    if (payload.content !== undefined) {
        return payload.content;
    }
    if (payload.content_json !== undefined) {
        return payload.content_json;
    }
    return undefined;
}

function validateTemplateType(template_type) {
    if (!TEMPLATE_TYPES.includes(template_type)) {
        throw new Error(`template_type must be one of: ${TEMPLATE_TYPES.join(", ")}`);
    }
}

function normalizeContentObject(content) {
    if (content === undefined || content === null) {
        return null;
    }
    if (typeof content === "string") {
        try {
            return JSON.parse(content);
        } catch {
            throw new Error("content must be a valid JSON object");
        }
    }
    if (typeof content !== "object" || Array.isArray(content)) {
        throw new Error("content must be a JSON object");
    }
    return content;
}

function validateAndNormalizeContent(template_type, rawContent) {
    validateTemplateType(template_type);

    const content = normalizeContentObject(rawContent);
    if (!content) {
        throw new Error("content is required");
    }

    const schema = CONTENT_FIELDS[template_type];
    for (const field of schema.required) {
        const value = content[field];
        if (value === undefined || value === null || !String(value).trim()) {
            throw new Error(`content.${field} is required for ${template_type} templates`);
        }
    }

    const normalized = {};
    for (const field of [...schema.required, ...schema.optional]) {
        if (content[field] !== undefined && content[field] !== null) {
            normalized[field] = String(content[field]).trim();
        }
    }

    for (const [key, value] of Object.entries(content)) {
        if (normalized[key] !== undefined) {
            continue;
        }
        if (value === undefined || value === null) {
            continue;
        }
        if (typeof value === "string") {
            normalized[key] = value.trim();
        } else {
            normalized[key] = value;
        }
    }

    return normalized;
}

function formatTemplateRow(row) {
    if (!row) return row;
    const { id: _id, content_json, variables_json, ...rest } = row;
    const parsedVariables = variables_json ? JSON.parse(variables_json) : [];
    return {
        ...rest,
        content: content_json ? JSON.parse(content_json) : {},
        variables_json: normalizeStoredVariablesJson(parsedVariables),
    };
}

async function createTemplate({ branch_id, username, payload }) {
    const { template_name, template_type = "text", status = "active" } = payload;

    if (!template_name || !String(template_name).trim()) {
        throw new Error("template_name is required");
    }
    if (!["active", "inactive"].includes(status)) {
        throw new Error("status must be 'active' or 'inactive'");
    }

    const content = validateAndNormalizeContent(template_type, normalizeContentInput(payload));
    const variables = parseVariablesFromContent(content);
    const template_id = newId("wwtpl");

    await pool.query(
        `INSERT INTO whatsappweb_templates
        (template_id, branch_id, template_name, template_type, content_json, variables_json, status, create_by, modify_by, create_date, modify_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
            template_id,
            branch_id,
            String(template_name).trim(),
            template_type,
            JSON.stringify(content),
            JSON.stringify(variables),
            status,
            username || null,
            username || null,
        ]
    );

    return getTemplateDetails({ branch_id, template_id });
}

async function updateTemplate({ branch_id, username, payload }) {
    const { template_id, template_name, template_type, status } = payload;
    if (!template_id) {
        throw new Error("template_id is required");
    }

    const [rows] = await pool.query(
        "SELECT * FROM whatsappweb_templates WHERE branch_id = ? AND template_id = ? LIMIT 1",
        [branch_id, template_id]
    );
    if (!rows.length) {
        throw new Error("Template not found");
    }
    const existing = rows[0];

    const nextType = template_type ?? existing.template_type;
    validateTemplateType(nextType);

    const nextStatus = status ?? existing.status;
    if (!["active", "inactive"].includes(nextStatus)) {
        throw new Error("status must be 'active' or 'inactive'");
    }

    const nextName =
        template_name !== undefined ? String(template_name).trim() : existing.template_name;
    if (!nextName) {
        throw new Error("template_name cannot be empty");
    }

    const rawContent = normalizeContentInput(payload);
    const nextContent =
        rawContent !== undefined
            ? validateAndNormalizeContent(nextType, rawContent)
            : JSON.parse(existing.content_json || "{}");

    if (nextType !== existing.template_type && rawContent === undefined) {
        throw new Error("content is required when changing template_type");
    }

    const variables = parseVariablesFromContent(nextContent);

    await pool.query(
        `UPDATE whatsappweb_templates
         SET template_name = ?, template_type = ?, content_json = ?, variables_json = ?, status = ?, modify_by = ?, modify_date = NOW()
         WHERE branch_id = ? AND template_id = ?`,
        [
            nextName,
            nextType,
            JSON.stringify(nextContent),
            JSON.stringify(variables),
            nextStatus,
            username || null,
            branch_id,
            template_id,
        ]
    );

    return getTemplateDetails({ branch_id, template_id });
}

async function listTemplates({ branch_id, page_no = 1, limit = 10, status = null, template_type = null }) {
    const page = Math.max(Number(page_no) || 1, 1);
    const size = Math.max(Number(limit) || 10, 1);
    const offset = (page - 1) * size;

    const where = ["branch_id = ?"];
    const params = [branch_id];

    if (status) {
        if (!["active", "inactive"].includes(status)) {
            throw new Error("status must be 'active' or 'inactive'");
        }
        where.push("status = ?");
        params.push(status);
    }

    if (template_type) {
        validateTemplateType(template_type);
        where.push("template_type = ?");
        params.push(template_type);
    }

    const whereClause = where.join(" AND ");

    const [rows] = await pool.query(
        `SELECT * FROM whatsappweb_templates
         WHERE ${whereClause}
         ORDER BY id DESC
         LIMIT ? OFFSET ?`,
        [...params, size, offset]
    );
    const [countRows] = await pool.query(
        `SELECT COUNT(*) AS total FROM whatsappweb_templates WHERE ${whereClause}`,
        params
    );
    const total = Number(countRows[0]?.total || 0);

    return {
        data: rows.map(formatTemplateRow),
        pagination: {
            page_no: page,
            limit: size,
            total,
            total_pages: Math.ceil(total / size) || 1,
            has_more: page * size < total,
        },
    };
}

async function getTemplateDetails({ branch_id, template_id }) {
    const [rows] = await pool.query(
        "SELECT * FROM whatsappweb_templates WHERE branch_id = ? AND template_id = ? LIMIT 1",
        [branch_id, template_id]
    );
    if (!rows.length) {
        throw new Error("Template not found");
    }
    return formatTemplateRow(rows[0]);
}

export {
    createTemplate,
    updateTemplate,
    listTemplates,
    getTemplateDetails,
    parseTemplateVariables,
    validateAndNormalizeContent,
    normalizeContentInput,
    TEMPLATE_TYPES,
};
