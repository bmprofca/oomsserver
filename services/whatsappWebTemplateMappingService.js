import crypto from "crypto";
import pool from "../db.js";
import { TEMPLATELIST } from "../utils/WhatsAppTemplates.js";

const VARIABLE_REGEX = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;

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
    const variableSet = new Set();
    const content = text == null ? "" : String(text);
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

function parseVariablesFromContent(content) {
    const variableSet = new Set();

    const walk = (value) => {
        if (typeof value === "string") {
            parseTemplateVariables(value).forEach((name) => variableSet.add(name));
            return;
        }
        if (Array.isArray(value)) {
            value.forEach(walk);
            return;
        }
        if (value && typeof value === "object") {
            Object.values(value).forEach(walk);
        }
    };

    walk(content);
    return Array.from(variableSet);
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
    return {
        ...rest,
        content: content_json ? JSON.parse(content_json) : {},
        variables_json: variables_json ? JSON.parse(variables_json) : [],
    };
}

function resolveSystemTemplateName(payload) {
    const rawName = payload.name ?? payload.template_name;
    const systemTemplateName = rawName != null ? String(rawName).trim() : "";
    if (!systemTemplateName) {
        throw new Error("name is required");
    }

    const systemTemplate = TEMPLATELIST.find((item) => item.name === systemTemplateName);
    if (!systemTemplate) {
        throw new Error("Invalid system template name");
    }

    return systemTemplateName;
}

async function getTemplateDetails({ branch_id, template_id }) {
    const [rows] = await pool.query(
        "SELECT * FROM whatsappweb_template_mapping WHERE branch_id = ? AND template_id = ? LIMIT 1",
        [branch_id, template_id]
    );
    if (!rows.length) {
        throw new Error("Template not found");
    }
    return formatTemplateRow(rows[0]);
}

async function getTemplateBySystemName({ branch_id, systemTemplateName }) {
    const [rows] = await pool.query(
        "SELECT * FROM whatsappweb_template_mapping WHERE branch_id = ? AND template_name = ? LIMIT 1",
        [branch_id, systemTemplateName]
    );
    if (!rows.length) {
        return null;
    }
    return formatTemplateRow(rows[0]);
}

async function listBranchTemplates({ branch_id }) {
    const [rows] = await pool.query(
        `SELECT * FROM whatsappweb_template_mapping
         WHERE branch_id = ?
         ORDER BY id ASC`,
        [branch_id]
    );
    return rows.map(formatTemplateRow);
}

async function setStaticTemplate({ branch_id, username, payload }) {
    const systemTemplateName = resolveSystemTemplateName(payload);
    const template_type = payload.template_type ?? "text";
    const status = payload.status ?? "active";

    if (!["active", "inactive"].includes(status)) {
        throw new Error("status must be 'active' or 'inactive'");
    }

    const content = validateAndNormalizeContent(template_type, normalizeContentInput(payload));
    const variables = parseVariablesFromContent(content);
    const contentJson = JSON.stringify(content);
    const variablesJson = JSON.stringify(variables);

    const [existing] = await pool.query(
        `SELECT template_id, template_type, content_json
         FROM whatsappweb_template_mapping
         WHERE branch_id = ?
           AND template_name = ?
         LIMIT 1`,
        [branch_id, systemTemplateName]
    );

    if (existing.length) {
        await pool.query(
            `UPDATE whatsappweb_template_mapping
             SET template_type = ?,
                 content_json = ?,
                 variables_json = ?,
                 status = ?,
                 modify_by = ?,
                 modify_date = NOW()
             WHERE branch_id = ?
               AND template_id = ?`,
            [
                template_type,
                contentJson,
                variablesJson,
                status,
                username || null,
                branch_id,
                existing[0].template_id,
            ]
        );

        return getTemplateDetails({ branch_id, template_id: existing[0].template_id });
    }

    const template_id = newId("wwmap");
    await pool.query(
        `INSERT INTO whatsappweb_template_mapping
        (template_id, branch_id, template_name, template_type, content_json, variables_json, status, create_by, modify_by, create_date, modify_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
            template_id,
            branch_id,
            systemTemplateName,
            template_type,
            contentJson,
            variablesJson,
            status,
            username || null,
            username || null,
        ]
    );

    return getTemplateDetails({ branch_id, template_id });
}

async function unsetStaticTemplate({ branch_id, systemTemplateName }) {
    const templateName = systemTemplateName != null ? String(systemTemplateName).trim() : "";
    if (!templateName) {
        throw new Error("name is required");
    }

    const systemTemplate = TEMPLATELIST.find((item) => item.name === templateName);
    if (!systemTemplate) {
        throw new Error("Invalid system template name");
    }

    const [existing] = await pool.query(
        `SELECT template_id
         FROM whatsappweb_template_mapping
         WHERE branch_id = ?
           AND template_name = ?
         LIMIT 1`,
        [branch_id, templateName]
    );

    if (!existing.length) {
        throw new Error("Template not found");
    }

    await pool.query(
        `UPDATE whatsappweb_template_mapping
         SET status = 'inactive', modify_date = NOW()
         WHERE branch_id = ?
           AND template_id = ?`,
        [branch_id, existing[0].template_id]
    );

    return getTemplateDetails({ branch_id, template_id: existing[0].template_id });
}

export {
    setStaticTemplate,
    unsetStaticTemplate,
    listBranchTemplates,
    getTemplateDetails,
    getTemplateBySystemName,
};
