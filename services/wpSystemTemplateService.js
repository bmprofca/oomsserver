import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMPLATES_PATH = path.join(__dirname, "..", "utils", "WP_SYSTEM_TEMPLATES.json");

let cachedTemplates = null;

function loadSystemTemplates() {
    if (!cachedTemplates) {
        const raw = fs.readFileSync(TEMPLATES_PATH, "utf8");
        cachedTemplates = JSON.parse(raw);
    }
    return cachedTemplates;
}

function normalizeType(value) {
    return value != null ? String(value).trim().toLowerCase() : "";
}

function newMapId() {
    return `WSTM_${crypto.randomBytes(8).toString("hex")}`;
}

function formatCategoryLabel(category) {
    const raw = category != null ? String(category).trim() : "";
    if (!raw) return "";
    return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

function buildContentPreview(entry, maxLen = 140) {
    const example = Array.isArray(entry?.example) ? entry.example : [];
    const body = example.find((item) => item?.type === "BODY");
    let text = body?.text != null ? String(body.text) : "";
    const samples = body?.example?.body_text?.[0];
    if (Array.isArray(samples)) {
        text = samples.reduce((result, sample, index) => {
            const placeholder = new RegExp(`\\{\\{${index + 1}\\}\\}`, "g");
            return result.replace(placeholder, sample != null ? String(sample) : "");
        }, text);
    }

    text = text
        .replace(/\*+/g, "")
        .replace(/\r\n|\r|\n/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    if (!text) return "";
    if (text.length <= maxLen) return text;
    return `${text.slice(0, Math.max(1, maxLen - 1)).trimEnd()}…`;
}

function formatTemplatePreview(entry) {
    const example = Array.isArray(entry.example) ? entry.example : [];
    const bodyComponent = entry.template?.components?.find((item) => item.type === "BODY");
    const available_variables = (bodyComponent?.example?.body_text?.[0] || []).map((key) => ({
        key: String(key),
        label: String(key).replace(/[{}]/g, ""),
    }));
    const categoryRaw = entry.template?.category || entry.category || "";

    return {
        type: entry.type,
        template_name: entry.template_name,
        category: formatCategoryLabel(categoryRaw),
        category_raw: categoryRaw ? String(categoryRaw).trim().toUpperCase() : "",
        content_preview: buildContentPreview(entry),
        template: entry.template,
        example,
        available_variables,
    };
}

function listTemplatesByType(type) {
    const normalizedType = normalizeType(type);
    if (!normalizedType) {
        throw new Error("type is required");
    }

    const templates = loadSystemTemplates();
    return templates
        .filter((item) => normalizeType(item.type) === normalizedType)
        .map(formatTemplatePreview);
}

function listDistinctTypes() {
    const templates = loadSystemTemplates();
    const typeSet = new Set();
    for (const item of templates) {
        if (item?.type) {
            typeSet.add(String(item.type).trim());
        }
    }
    return Array.from(typeSet).sort((a, b) => a.localeCompare(b));
}

function findSystemTemplate(type, templateName) {
    const normalizedType = normalizeType(type);
    const normalizedName = templateName != null ? String(templateName).trim() : "";
    if (!normalizedType || !normalizedName) {
        return null;
    }

    return (
        loadSystemTemplates().find(
            (item) =>
                normalizeType(item.type) === normalizedType &&
                String(item.template_name || "").trim() === normalizedName
        ) || null
    );
}

function canonicalType(type) {
    const normalized = normalizeType(type);
    if (!normalized) {
        return "";
    }
    const match = loadSystemTemplates().find(
        (item) => normalizeType(item.type) === normalized
    );
    return match?.type ? String(match.type).trim() : String(type).trim();
}

async function getActiveMapping(branch_id, type) {
    const normalizedType = normalizeType(type);
    if (!normalizedType) {
        return null;
    }

    const [rows] = await pool.query(
        `SELECT map_id, branch_id, type, template_name, status, create_date, modify_date
         FROM wp_system_template_mapping
         WHERE branch_id = ?
           AND LOWER(TRIM(type)) = ?
           AND status = 1
         LIMIT 1`,
        [branch_id, normalizedType]
    );

    return rows[0] || null;
}

async function listBranchMappings(branch_id) {
    const [rows] = await pool.query(
        `SELECT map_id, type, template_name, status, create_date, modify_date
         FROM wp_system_template_mapping
         WHERE branch_id = ?
         ORDER BY type ASC, id DESC`,
        [branch_id]
    );

    const mappingByType = new Map();
    for (const row of rows) {
        const key = row.type ? normalizeType(row.type) : "";
        if (key && !mappingByType.has(key)) {
            mappingByType.set(key, row);
        }
    }

    return listDistinctTypes().map((type) => {
        const mapping = mappingByType.get(normalizeType(type));
        const isSet = mapping && Number(mapping.status) === 1;
        const templates = loadSystemTemplates().filter(
            (item) => normalizeType(item.type) === normalizeType(type)
        );

        const selectedEntry = isSet
            ? findSystemTemplate(type, mapping.template_name) || {
                type,
                template_name: mapping.template_name,
                template: { components: [] },
                example: [],
            }
            : null;
        const selected_template = selectedEntry
            ? formatTemplatePreview(selectedEntry)
            : null;

        return {
            type,
            available_templates: templates.map((item) => item.template_name),
            is_set: Boolean(isSet),
            map_id: mapping?.map_id ?? null,
            template_name: mapping?.template_name ?? null,
            status: mapping?.status ?? 0,
            category: selected_template?.category || null,
            content_preview: selected_template?.content_preview || null,
            selected_template,
        };
    });
}

async function setTemplateMapping({ branch_id, username, type, template_name }) {
    const normalizedType = type != null ? String(type).trim() : "";
    const normalizedTemplateName =
        template_name != null ? String(template_name).trim() : "";

    if (!normalizedType) {
        throw new Error("type is required");
    }
    if (!normalizedTemplateName) {
        throw new Error("template_name is required");
    }

    const templateEntry = findSystemTemplate(normalizedType, normalizedTemplateName);
    if (!templateEntry) {
        throw new Error("Invalid type or template_name for OOMS system templates");
    }

    const storedType = canonicalType(templateEntry.type);

    const [existing] = await pool.query(
        `SELECT id, map_id
         FROM wp_system_template_mapping
         WHERE branch_id = ?
           AND LOWER(TRIM(type)) = ?
         LIMIT 1`,
        [branch_id, normalizeType(storedType)]
    );

    if (existing.length) {
        await pool.query(
            `UPDATE wp_system_template_mapping
             SET type = ?,
                 template_name = ?,
                 status = 1,
                 modify_by = ?,
                 modify_date = NOW()
             WHERE id = ?`,
            [storedType, normalizedTemplateName, username || null, existing[0].id]
        );

        const preview = formatTemplatePreview(templateEntry);
        return {
            map_id: existing[0].map_id,
            type: storedType,
            template_name: normalizedTemplateName,
            status: 1,
            category: preview.category,
            content_preview: preview.content_preview,
            template: preview,
        };
    }

    const map_id = newMapId();
    await pool.query(
        `INSERT INTO wp_system_template_mapping
         (map_id, branch_id, type, template_name, status, create_by, modify_by)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
        [
            map_id,
            branch_id,
            storedType,
            normalizedTemplateName,
            username || null,
            username || null,
        ]
    );

    const preview = formatTemplatePreview(templateEntry);
    return {
        map_id,
        type: storedType,
        template_name: normalizedTemplateName,
        status: 1,
        category: preview.category,
        content_preview: preview.content_preview,
        template: preview,
    };
}

async function unsetTemplateMapping({ branch_id, username, type }) {
    const normalizedType = normalizeType(type);
    if (!normalizedType) {
        throw new Error("type is required");
    }

    const [existing] = await pool.query(
        `SELECT id, map_id, template_name
         FROM wp_system_template_mapping
         WHERE branch_id = ?
           AND LOWER(TRIM(type)) = ?
         LIMIT 1`,
        [branch_id, normalizedType]
    );

    if (!existing.length) {
        throw new Error("Template mapping not found");
    }

    await pool.query(
        `UPDATE wp_system_template_mapping
         SET status = 0,
             modify_by = ?,
             modify_date = NOW()
         WHERE id = ?`,
        [username || null, existing[0].id]
    );

    return {
        map_id: existing[0].map_id,
        type: normalizedType,
        template_name: existing[0].template_name,
        status: 0,
    };
}

export {
    loadSystemTemplates,
    listTemplatesByType,
    listDistinctTypes,
    findSystemTemplate,
    getActiveMapping,
    listBranchMappings,
    setTemplateMapping,
    unsetTemplateMapping,
    formatTemplatePreview,
};
