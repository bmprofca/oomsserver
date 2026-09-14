import pool from "../db.js";
import crypto from "crypto";
import { UNIQUE_RANDOM_STRING } from "../helpers/function.js";
import { SMS_TEMPLATELIST } from "../utils/WhatsAppTemplates.js";
import { normalizeFast2SmsRoute } from "../helpers/fast2sms.js";

export const SMS_SYSTEM_CAMPAIGN_TYPE = "campaign";

/** Count Fast2SMS / DLT `{#var#}` placeholders. */
export function deriveDltSlotsFromMessageBody(messageBody) {
    const text = String(messageBody || "");
    const matches = text.match(/\{#\s*var\s*#\}/gi) || [];
    return matches.map((_, index) => `variable_${index + 1}`);
}

export function listSmsSystemTypes() {
    return [
        ...SMS_TEMPLATELIST.map((item) => ({
            name: item.name,
            description: item.description || "",
            available_variables: item.available_variables || [],
        })),
        {
            name: SMS_SYSTEM_CAMPAIGN_TYPE,
            description: "Campaign-only templates (not used for auto notifications)",
            available_variables: [
                { key: "{{name}}", label: "Client name" },
                { key: "{{mobile}}", label: "Client mobile" },
                { key: "{{email}}", label: "Client email" },
                { key: "{{firm_name}}", label: "Firm name" },
                { key: "{{balance}}", label: "Balance" },
                { key: "{{current_date}}", label: "Current date" },
            ],
        },
    ];
}

function isKnownType(type) {
    const key = String(type || "").trim().toLowerCase();
    return listSmsSystemTypes().some((t) => t.name.toLowerCase() === key);
}

function canonicalType(type) {
    const key = String(type || "").trim().toLowerCase();
    const match = listSmsSystemTypes().find((t) => t.name.toLowerCase() === key);
    return match?.name || String(type || "").trim();
}

function parseVariableKeys(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.map((k) => String(k).trim()).filter(Boolean);
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            return parsed.map((k) => String(k).trim()).filter(Boolean);
        }
    } catch {
        /* fall through */
    }
    return String(raw)
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
}

function normalizeVariableKeys(keys, messageBody) {
    const fromBody = deriveDltSlotsFromMessageBody(messageBody);
    const provided = parseVariableKeys(keys).map((key) => {
        const raw = String(key || "").trim();
        if (!raw) return "";
        return raw.startsWith("{{") ? raw : `{{${raw.replace(/[{}]/g, "")}}}`;
    });
    if (fromBody.length) {
        return fromBody.map((_, index) => provided[index] || "");
    }
    return provided.filter(Boolean);
}

function serializeTemplate(row) {
    if (!row) return null;
    const variable_keys = parseVariableKeys(row.variable_keys);
    const slotCount = deriveDltSlotsFromMessageBody(row.message_body).length;
    return {
        template_id: row.template_id,
        type: row.type,
        name: row.name,
        dlt_message_id: row.dlt_message_id || "",
        message_body: row.message_body || "",
        variable_keys,
        placeholder_count: slotCount || variable_keys.length,
        sender_id: row.sender_id || "",
        route: normalizeFast2SmsRoute(row.route),
        status: row.status || "active",
        create_date: row.create_date || null,
        modify_date: row.modify_date || null,
        content_preview: String(row.message_body || "").slice(0, 160),
    };
}

export async function listAdminSystemTemplates({
    type = "",
    search = "",
    status = "",
    page_no = 1,
    limit = 50,
} = {}) {
    const page = Math.max(1, Number(page_no) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(limit) || 50));
    const offset = (page - 1) * pageSize;
    const params = [];
    let where = "WHERE 1=1";

    if (type) {
        where += " AND LOWER(TRIM(type)) = ?";
        params.push(String(type).trim().toLowerCase());
    }
    if (status) {
        where += " AND status = ?";
        params.push(String(status).trim());
    }
    if (search) {
        where += " AND (name LIKE ? OR dlt_message_id LIKE ? OR message_body LIKE ? OR type LIKE ?)";
        const like = `%${String(search).trim()}%`;
        params.push(like, like, like, like);
    }

    const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) AS total FROM sms_system_templates ${where}`,
        params
    );
    const [rows] = await pool.query(
        `SELECT * FROM sms_system_templates
         ${where}
         ORDER BY type ASC, name ASC, id ASC
         LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
    );

    return {
        data: rows.map(serializeTemplate),
        pagination: {
            page_no: page,
            limit: pageSize,
            total: Number(total) || 0,
            total_pages: Math.max(1, Math.ceil((Number(total) || 0) / pageSize)),
        },
    };
}

export async function getSystemTemplateById(template_id) {
    const [rows] = await pool.query(
        `SELECT * FROM sms_system_templates WHERE template_id = ? LIMIT 1`,
        [String(template_id || "").trim()]
    );
    return serializeTemplate(rows[0] || null);
}

export async function createSystemTemplate(body = {}, actor = null) {
    const type = canonicalType(body.type);
    const name = String(body.name || "").trim();
    const message_body = String(body.message_body || "").trim();
    const dlt_message_id = String(body.dlt_message_id || "").trim() || null;
    const route = normalizeFast2SmsRoute(body.route || "dlt");
    const sender_id = String(body.sender_id || "").trim().toUpperCase() || null;
    const status =
        body.status != null && String(body.status).trim()
            ? String(body.status).trim().toLowerCase()
            : "active";

    if (!type || !isKnownType(type)) {
        throw Object.assign(new Error("Invalid template type"), { status: 400 });
    }
    if (!name) {
        throw Object.assign(new Error("name is required"), { status: 400 });
    }
    if (!message_body && route === "q") {
        throw Object.assign(new Error("message_body is required"), { status: 400 });
    }
    if ((route === "dlt" || route === "otp") && !dlt_message_id) {
        throw Object.assign(new Error("dlt_message_id is required for DLT route"), {
            status: 400,
        });
    }

    const variable_keys = normalizeVariableKeys(body.variable_keys, message_body);
    const slotCount = deriveDltSlotsFromMessageBody(message_body).length;
    if (slotCount > 0 && variable_keys.filter(Boolean).length !== slotCount) {
        throw Object.assign(
            new Error(`Map all ${slotCount} DLT variables before saving`),
            { status: 400 }
        );
    }

    const template_id = await UNIQUE_RANDOM_STRING("sms_system_templates", "template_id", {
        prefix: "sst",
    });

    try {
        await pool.query(
            `INSERT INTO sms_system_templates
             (template_id, type, name, dlt_message_id, message_body, variable_keys,
              sender_id, route, status, create_by, modify_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                template_id,
                type,
                name,
                dlt_message_id,
                message_body || null,
                JSON.stringify(variable_keys),
                sender_id,
                route,
                status,
                actor,
                actor,
            ]
        );
    } catch (error) {
        if (error?.code === "ER_DUP_ENTRY") {
            throw Object.assign(
                new Error("A template with this type and name already exists"),
                { status: 400 }
            );
        }
        throw error;
    }

    return getSystemTemplateById(template_id);
}

export async function updateSystemTemplate(template_id, body = {}, actor = null) {
    const existing = await getSystemTemplateById(template_id);
    if (!existing) {
        throw Object.assign(new Error("Template not found"), { status: 404 });
    }

    const type =
        body.type != null ? canonicalType(body.type) : existing.type;
    const name =
        body.name != null ? String(body.name || "").trim() : existing.name;
    const message_body =
        body.message_body != null
            ? String(body.message_body || "").trim()
            : existing.message_body;
    const dlt_message_id =
        body.dlt_message_id != null
            ? String(body.dlt_message_id || "").trim() || null
            : existing.dlt_message_id || null;
    const route = normalizeFast2SmsRoute(body.route || existing.route || "dlt");
    const sender_id =
        body.sender_id != null
            ? String(body.sender_id || "").trim().toUpperCase() || null
            : existing.sender_id || null;
    const status =
        body.status != null
            ? String(body.status || "").trim().toLowerCase()
            : existing.status;

    if (!type || !isKnownType(type)) {
        throw Object.assign(new Error("Invalid template type"), { status: 400 });
    }
    if (!name) {
        throw Object.assign(new Error("name is required"), { status: 400 });
    }
    if ((route === "dlt" || route === "otp") && !dlt_message_id) {
        throw Object.assign(new Error("dlt_message_id is required for DLT route"), {
            status: 400,
        });
    }

    const variable_keys = normalizeVariableKeys(
        body.variable_keys != null ? body.variable_keys : existing.variable_keys,
        message_body
    );
    const slotCount = deriveDltSlotsFromMessageBody(message_body).length;
    if (slotCount > 0 && variable_keys.filter(Boolean).length !== slotCount) {
        throw Object.assign(
            new Error(`Map all ${slotCount} DLT variables before saving`),
            { status: 400 }
        );
    }

    try {
        await pool.query(
            `UPDATE sms_system_templates
             SET type = ?, name = ?, dlt_message_id = ?, message_body = ?,
                 variable_keys = ?, sender_id = ?, route = ?, status = ?,
                 modify_by = ?, modify_date = CURRENT_TIMESTAMP
             WHERE template_id = ?`,
            [
                type,
                name,
                dlt_message_id,
                message_body || null,
                JSON.stringify(variable_keys),
                sender_id,
                route,
                status,
                actor,
                String(template_id).trim(),
            ]
        );
    } catch (error) {
        if (error?.code === "ER_DUP_ENTRY") {
            throw Object.assign(
                new Error("A template with this type and name already exists"),
                { status: 400 }
            );
        }
        throw error;
    }

    return getSystemTemplateById(template_id);
}

export async function setSystemTemplateStatus(template_id, status, actor = null) {
    const next = String(status || "").trim().toLowerCase();
    if (!["active", "inactive"].includes(next)) {
        throw Object.assign(new Error("status must be active or inactive"), {
            status: 400,
        });
    }
    const [result] = await pool.query(
        `UPDATE sms_system_templates
         SET status = ?, modify_by = ?, modify_date = CURRENT_TIMESTAMP
         WHERE template_id = ?`,
        [next, actor, String(template_id).trim()]
    );
    if (!result.affectedRows) {
        throw Object.assign(new Error("Template not found"), { status: 404 });
    }
    return getSystemTemplateById(template_id);
}

export async function deleteSystemTemplate(template_id) {
    const id = String(template_id || "").trim();
    await pool.query(
        `DELETE FROM sms_system_template_mapping WHERE sms_template_id = ?`,
        [id]
    );
    const [result] = await pool.query(
        `DELETE FROM sms_system_templates WHERE template_id = ?`,
        [id]
    );
    if (!result.affectedRows) {
        throw Object.assign(new Error("Template not found"), { status: 404 });
    }
    return { template_id: id };
}

/** Active templates for a branch picker (by type). */
export async function listActiveSystemTemplatesByType(type) {
    const canonical = canonicalType(type);
    const [rows] = await pool.query(
        `SELECT * FROM sms_system_templates
         WHERE LOWER(TRIM(type)) = ?
           AND status = 'active'
         ORDER BY name ASC`,
        [String(canonical).toLowerCase()]
    );
    return rows.map(serializeTemplate);
}

export async function getActiveSystemTemplateRow(template_id) {
    const [rows] = await pool.query(
        `SELECT * FROM sms_system_templates
         WHERE template_id = ? AND status = 'active'
         LIMIT 1`,
        [String(template_id || "").trim()]
    );
    return rows[0] || null;
}

export async function listBranchSystemTemplateMaps(branch_id) {
    const [rows] = await pool.query(
        `SELECT m.map_id, m.template_type, m.sms_template_id, m.status,
                t.name AS sms_template_name, t.dlt_message_id, t.route,
                t.message_body, t.variable_keys, t.sender_id
         FROM sms_system_template_mapping m
         LEFT JOIN sms_system_templates t
           ON t.template_id = m.sms_template_id
         WHERE m.branch_id = ?`,
        [branch_id]
    );

    const byType = new Map();
    for (const row of rows) {
        byType.set(String(row.template_type || "").trim().toLowerCase(), row);
    }

    return SMS_TEMPLATELIST.map((item) => {
        const mapped = byType.get(String(item.name).toLowerCase());
        const is_set =
            Boolean(mapped) &&
            Number(mapped.status) === 1 &&
            Boolean(mapped.sms_template_id) &&
            Boolean(mapped.sms_template_name);

        return {
            type: item.name,
            description: item.description || "",
            available_variables: item.available_variables || [],
            is_set,
            map_id: is_set ? mapped.map_id : null,
            sms_template_id: is_set ? mapped.sms_template_id : null,
            sms_template_name: is_set ? mapped.sms_template_name : null,
            dlt_message_id: is_set ? mapped.dlt_message_id || "" : "",
            route: is_set ? normalizeFast2SmsRoute(mapped.route) : "",
            message_body: is_set ? mapped.message_body || "" : "",
            variable_keys: is_set ? parseVariableKeys(mapped.variable_keys) : [],
            status: is_set ? 1 : 0,
        };
    });
}

export async function setBranchSystemTemplateMap(
    branch_id,
    username,
    { type, sms_template_id } = {}
) {
    const template_type = canonicalType(type);
    if (!SMS_TEMPLATELIST.some((item) => item.name === template_type)) {
        throw Object.assign(new Error("Invalid notification type"), { status: 400 });
    }
    const template = await getActiveSystemTemplateRow(sms_template_id);
    if (!template) {
        throw Object.assign(new Error("System template not found or inactive"), {
            status: 404,
        });
    }
    if (String(template.type).toLowerCase() !== String(template_type).toLowerCase()) {
        throw Object.assign(
            new Error("Template type does not match notification type"),
            { status: 400 }
        );
    }

    const [existing] = await pool.query(
        `SELECT map_id FROM sms_system_template_mapping
         WHERE branch_id = ? AND LOWER(TRIM(template_type)) = ?
         LIMIT 1`,
        [branch_id, template_type.toLowerCase()]
    );

    if (existing[0]?.map_id) {
        await pool.query(
            `UPDATE sms_system_template_mapping
             SET sms_template_id = ?, status = 1, modify_by = ?,
                 modify_date = CURRENT_TIMESTAMP
             WHERE map_id = ?`,
            [template.template_id, username, existing[0].map_id]
        );
        return {
            map_id: existing[0].map_id,
            type: template_type,
            sms_template_id: template.template_id,
        };
    }

    const map_id = `SSTM${crypto.randomBytes(8).toString("hex")}`;
    await pool.query(
        `INSERT INTO sms_system_template_mapping
         (map_id, branch_id, template_type, sms_template_id, status, create_by, modify_by)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
        [map_id, branch_id, template_type, template.template_id, username, username]
    );
    return {
        map_id,
        type: template_type,
        sms_template_id: template.template_id,
    };
}

export async function unsetBranchSystemTemplateMap(
    branch_id,
    username,
    { type } = {}
) {
    const template_type = canonicalType(type);
    const [result] = await pool.query(
        `UPDATE sms_system_template_mapping
         SET status = 0, modify_by = ?, modify_date = CURRENT_TIMESTAMP
         WHERE branch_id = ? AND LOWER(TRIM(template_type)) = ?`,
        [username, branch_id, String(template_type).toLowerCase()]
    );
    return {
        type: template_type,
        updated: Number(result.affectedRows) || 0,
    };
}

export async function loadActiveSystemMapping(branch_id, templateType) {
    const [rows] = await pool.query(
        `SELECT m.map_id, t.template_id, t.name, t.dlt_message_id, t.message_body,
                t.variable_keys, t.sender_id, t.route, t.status AS template_status
         FROM sms_system_template_mapping m
         INNER JOIN sms_system_templates t
           ON t.template_id = m.sms_template_id
         WHERE m.branch_id = ?
           AND LOWER(TRIM(m.template_type)) = ?
           AND m.status = 1
           AND t.status = 'active'
         LIMIT 1`,
        [branch_id, String(templateType || "").trim().toLowerCase()]
    );
    return rows[0] || null;
}

/** Build pipe-separated DLT values from template variable_keys + braced vars. */
export function buildVariablesValuesFromKeys(variableKeys, bracedVariables = {}) {
    const keys = parseVariableKeys(variableKeys);
    if (!keys.length) return "";
    return keys
        .map((key) => {
            const bracedKey = key.startsWith("{{")
                ? key
                : `{{${String(key).replace(/[{}]/g, "")}}}`;
            const bare = bracedKey.replace(/[{}]/g, "");
            const value =
                bracedVariables[bracedKey] ??
                bracedVariables[bare] ??
                bracedVariables[`{{${bare}}}`] ??
                "";
            return String(value ?? "").trim();
        })
        .join("|");
}
