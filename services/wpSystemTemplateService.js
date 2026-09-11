import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../db.js";
import { TEMPLATELIST } from "../utils/WhatsAppTemplates.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SEED_DATA_PATH = path.join(
    __dirname,
    "..",
    "helpers",
    "wpSystemTemplateSeedData.json"
);

const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS \`wp_system_templates\` (
  \`id\` INT NOT NULL AUTO_INCREMENT,
  \`template_id\` VARCHAR(50) NOT NULL,
  \`type\` VARCHAR(80) NOT NULL,
  \`template_name\` VARCHAR(120) NOT NULL,
  \`category\` VARCHAR(40) NOT NULL DEFAULT 'UTILITY',
  \`language\` VARCHAR(20) NOT NULL DEFAULT 'en',
  \`template_json\` LONGTEXT NOT NULL,
  \`example_json\` LONGTEXT NOT NULL,
  \`status\` VARCHAR(20) NOT NULL DEFAULT 'active',
  \`create_by\` VARCHAR(50) NULL DEFAULT NULL,
  \`create_date\` DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  \`modify_by\` VARCHAR(50) NULL DEFAULT NULL,
  \`modify_date\` DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_wp_system_templates_id\` (\`template_id\`),
  UNIQUE KEY \`uk_wp_system_templates_type_name\` (\`type\`, \`template_name\`),
  KEY \`idx_wp_system_templates_type\` (\`type\`),
  KEY \`idx_wp_system_templates_status\` (\`status\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

let tableReady = false;
let cachedTemplates = null;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 30_000;

function newTemplateId() {
    return `WST_${crypto.randomBytes(8).toString("hex")}`;
}

function newMapId() {
    return `WSTM_${crypto.randomBytes(8).toString("hex")}`;
}

function normalizeType(value) {
    return value != null ? String(value).trim().toLowerCase() : "";
}

function normalizeStatus(value) {
    const raw = value != null ? String(value).trim().toLowerCase() : "active";
    return raw === "inactive" ? "inactive" : "active";
}

function invalidateTemplateCache() {
    cachedTemplates = null;
    cacheLoadedAt = 0;
}

function parseJsonField(value, fallback) {
    if (value == null || value === "") return fallback;
    if (typeof value === "object") return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
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

function rowToEntry(row) {
    if (!row) return null;
    const template = parseJsonField(row.template_json, {});
    const example = parseJsonField(row.example_json, []);
    return {
        template_id: row.template_id,
        type: row.type,
        template_name: row.template_name,
        category: row.category || template?.category || "UTILITY",
        language: row.language || template?.language || "en",
        status: row.status || "active",
        template,
        example: Array.isArray(example) ? example : [],
        create_by: row.create_by ?? null,
        create_date: row.create_date ?? null,
        modify_by: row.modify_by ?? null,
        modify_date: row.modify_date ?? null,
    };
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
        template_id: entry.template_id || null,
        type: entry.type,
        template_name: entry.template_name,
        category: formatCategoryLabel(categoryRaw),
        category_raw: categoryRaw ? String(categoryRaw).trim().toUpperCase() : "",
        language: entry.language || entry.template?.language || "en",
        status: entry.status || "active",
        content_preview: buildContentPreview(entry),
        template: entry.template,
        example,
        available_variables,
    };
}

function listCanonicalTypes() {
    return TEMPLATELIST.map((item) => String(item.name).trim());
}

function findTemplateListMeta(type) {
    const normalized = normalizeType(type);
    return (
        TEMPLATELIST.find((item) => normalizeType(item.name) === normalized) || null
    );
}

function canonicalType(type) {
    const meta = findTemplateListMeta(type);
    if (meta?.name) return String(meta.name).trim();
    return type != null ? String(type).trim() : "";
}

function isKnownSystemType(type) {
    return Boolean(findTemplateListMeta(type));
}

async function ensureTemplatesTable() {
    if (tableReady) return;
    await pool.query(TABLE_SQL);
    tableReady = true;
}

async function loadSystemTemplates({ force = false, includeInactive = false } = {}) {
    await ensureTemplatesTable();

    const now = Date.now();
    if (
        !force &&
        cachedTemplates &&
        now - cacheLoadedAt < CACHE_TTL_MS
    ) {
        return includeInactive
            ? cachedTemplates
            : cachedTemplates.filter((item) => normalizeStatus(item.status) === "active");
    }

    const [rows] = await pool.query(
        `SELECT template_id, type, template_name, category, language,
                template_json, example_json, status,
                create_by, create_date, modify_by, modify_date
         FROM wp_system_templates
         ORDER BY type ASC, template_name ASC, id ASC`
    );

    cachedTemplates = rows.map(rowToEntry);
    cacheLoadedAt = now;

    return includeInactive
        ? cachedTemplates
        : cachedTemplates.filter((item) => normalizeStatus(item.status) === "active");
}

async function listTemplatesByType(type, { includeInactive = false } = {}) {
    const normalizedType = normalizeType(type);
    if (!normalizedType) {
        throw new Error("type is required");
    }

    const templates = await loadSystemTemplates({ includeInactive });
    return templates
        .filter((item) => normalizeType(item.type) === normalizedType)
        .map(formatTemplatePreview);
}

async function listDistinctTypes() {
    return listCanonicalTypes();
}

async function findSystemTemplate(type, templateName, { includeInactive = false } = {}) {
    const normalizedType = normalizeType(type);
    const normalizedName = templateName != null ? String(templateName).trim() : "";
    if (!normalizedType || !normalizedName) {
        return null;
    }

    const templates = await loadSystemTemplates({ includeInactive });
    return (
        templates.find(
            (item) =>
                normalizeType(item.type) === normalizedType &&
                String(item.template_name || "").trim() === normalizedName
        ) || null
    );
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

    const templates = await loadSystemTemplates();

    return listCanonicalTypes().map((type) => {
        const meta = findTemplateListMeta(type);
        const mapping = mappingByType.get(normalizeType(type));
        const isSet = mapping && Number(mapping.status) === 1;
        const typeTemplates = templates.filter(
            (item) => normalizeType(item.type) === normalizeType(type)
        );

        const selectedEntry = isSet
            ? typeTemplates.find(
                  (item) =>
                      String(item.template_name || "").trim() ===
                      String(mapping.template_name || "").trim()
              ) || {
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
            name: type,
            description: meta?.description || `${type} template`,
            available_variables: meta?.available_variables || [],
            available_templates: typeTemplates.map((item) => item.template_name),
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
    if (!isKnownSystemType(normalizedType)) {
        throw new Error("Invalid type for OOMS system templates");
    }

    const templateEntry = await findSystemTemplate(
        normalizedType,
        normalizedTemplateName
    );
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
        type: canonicalType(type) || normalizedType,
        template_name: existing[0].template_name,
        status: 0,
    };
}

function coerceTemplatePayload(templateInput, fallbackName, category, language) {
    let template = templateInput;
    if (typeof template === "string") {
        template = JSON.parse(template);
    }
    if (!template || typeof template !== "object" || Array.isArray(template)) {
        throw new Error("template must be a JSON object");
    }

    const name =
        template.name != null && String(template.name).trim()
            ? String(template.name).trim()
            : fallbackName;
    const next = {
        ...template,
        name,
        category: String(template.category || category || "UTILITY")
            .trim()
            .toUpperCase(),
        language: String(template.language || language || "en").trim() || "en",
        components: Array.isArray(template.components) ? template.components : [],
    };
    return next;
}

function coerceExamplePayload(exampleInput) {
    let example = exampleInput;
    if (typeof example === "string") {
        example = JSON.parse(example);
    }
    if (!Array.isArray(example)) {
        throw new Error("example must be a JSON array");
    }
    return example;
}

async function listAdminTemplates({
    type = "",
    search = "",
    status = "",
    page_no = 1,
    limit = 50,
} = {}) {
    await ensureTemplatesTable();

    const page = Math.max(1, Number(page_no) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(limit) || 50));
    const offset = (page - 1) * pageSize;

    const where = [];
    const params = [];

    if (type) {
        where.push("LOWER(TRIM(type)) = ?");
        params.push(normalizeType(type));
    }
    if (status) {
        where.push("LOWER(TRIM(status)) = ?");
        params.push(normalizeStatus(status));
    }
    if (search) {
        where.push(
            `(template_name LIKE ? OR type LIKE ? OR template_id LIKE ? OR category LIKE ?)`
        );
        const sp = `%${String(search).trim()}%`;
        params.push(sp, sp, sp, sp);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) AS total FROM wp_system_templates ${whereSql}`,
        params
    );

    const [rows] = await pool.query(
        `SELECT template_id, type, template_name, category, language,
                template_json, example_json, status,
                create_by, create_date, modify_by, modify_date
         FROM wp_system_templates
         ${whereSql}
         ORDER BY type ASC, template_name ASC, id DESC
         LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
    );

    const data = rows.map((row) => {
        const entry = rowToEntry(row);
        return formatTemplatePreview(entry);
    });

    return {
        data,
        pagination: {
            page_no: page,
            limit: pageSize,
            total: Number(total) || 0,
            total_pages: Math.ceil((Number(total) || 0) / pageSize) || 1,
        },
    };
}

async function getAdminTemplate(template_id) {
    await ensureTemplatesTable();
    const id = template_id != null ? String(template_id).trim() : "";
    if (!id) throw new Error("template_id is required");

    const [rows] = await pool.query(
        `SELECT template_id, type, template_name, category, language,
                template_json, example_json, status,
                create_by, create_date, modify_by, modify_date
         FROM wp_system_templates
         WHERE template_id = ?
         LIMIT 1`,
        [id]
    );
    if (!rows.length) return null;
    return formatTemplatePreview(rowToEntry(rows[0]));
}

async function createSystemTemplate({
    type,
    template_name,
    category = "UTILITY",
    language = "en",
    template,
    example,
    status = "active",
    username = null,
}) {
    await ensureTemplatesTable();

    const storedType = canonicalType(type);
    const name = template_name != null ? String(template_name).trim() : "";
    if (!storedType || !isKnownSystemType(storedType)) {
        throw new Error("type must be a valid TEMPLATELIST system type");
    }
    if (!name) {
        throw new Error("template_name is required");
    }

    const templateObj = coerceTemplatePayload(template, name, category, language);
    const exampleArr = coerceExamplePayload(example);
    const storedStatus = normalizeStatus(status);
    const template_id = newTemplateId();

    try {
        await pool.query(
            `INSERT INTO wp_system_templates
             (template_id, type, template_name, category, language,
              template_json, example_json, status, create_by, modify_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                template_id,
                storedType,
                name,
                templateObj.category,
                templateObj.language,
                JSON.stringify(templateObj),
                JSON.stringify(exampleArr),
                storedStatus,
                username,
                username,
            ]
        );
    } catch (error) {
        if (error?.code === "ER_DUP_ENTRY") {
            throw new Error("A template with this type and template_name already exists");
        }
        throw error;
    }

    invalidateTemplateCache();
    return getAdminTemplate(template_id);
}

async function updateSystemTemplate({
    template_id,
    type,
    template_name,
    category,
    language,
    template,
    example,
    status,
    username = null,
}) {
    await ensureTemplatesTable();
    const id = template_id != null ? String(template_id).trim() : "";
    if (!id) throw new Error("template_id is required");

    const existing = await getAdminTemplate(id);
    if (!existing) {
        throw new Error("Template not found");
    }

    const nextType = type != null ? canonicalType(type) : existing.type;
    if (!isKnownSystemType(nextType)) {
        throw new Error("type must be a valid TEMPLATELIST system type");
    }

    const nextName =
        template_name != null ? String(template_name).trim() : existing.template_name;
    if (!nextName) {
        throw new Error("template_name is required");
    }

    const nextCategory =
        category != null
            ? String(category).trim().toUpperCase()
            : existing.category_raw || existing.category || "UTILITY";
    const nextLanguage =
        language != null
            ? String(language).trim() || "en"
            : existing.language || "en";
    const templateObj = coerceTemplatePayload(
        template != null ? template : existing.template,
        nextName,
        nextCategory,
        nextLanguage
    );
    const exampleArr = coerceExamplePayload(
        example != null ? example : existing.example
    );
    const nextStatus =
        status != null ? normalizeStatus(status) : normalizeStatus(existing.status);

    try {
        await pool.query(
            `UPDATE wp_system_templates
             SET type = ?,
                 template_name = ?,
                 category = ?,
                 language = ?,
                 template_json = ?,
                 example_json = ?,
                 status = ?,
                 modify_by = ?,
                 modify_date = NOW()
             WHERE template_id = ?`,
            [
                nextType,
                nextName,
                templateObj.category,
                templateObj.language,
                JSON.stringify(templateObj),
                JSON.stringify(exampleArr),
                nextStatus,
                username,
                id,
            ]
        );
    } catch (error) {
        if (error?.code === "ER_DUP_ENTRY") {
            throw new Error("A template with this type and template_name already exists");
        }
        throw error;
    }

    invalidateTemplateCache();
    return getAdminTemplate(id);
}

async function setSystemTemplateStatus({ template_id, status, username = null }) {
    await ensureTemplatesTable();
    const id = template_id != null ? String(template_id).trim() : "";
    if (!id) throw new Error("template_id is required");

    const nextStatus = normalizeStatus(status);
    const [result] = await pool.query(
        `UPDATE wp_system_templates
         SET status = ?, modify_by = ?, modify_date = NOW()
         WHERE template_id = ?`,
        [nextStatus, username, id]
    );
    if (!result.affectedRows) {
        throw new Error("Template not found");
    }

    invalidateTemplateCache();
    return getAdminTemplate(id);
}

async function deleteSystemTemplate({ template_id }) {
    await ensureTemplatesTable();
    const id = template_id != null ? String(template_id).trim() : "";
    if (!id) throw new Error("template_id is required");

    const existing = await getAdminTemplate(id);
    if (!existing) {
        throw new Error("Template not found");
    }

    await pool.query(`DELETE FROM wp_system_templates WHERE template_id = ?`, [id]);
    invalidateTemplateCache();
    return { template_id: id, deleted: true };
}

function countBodyPlaceholders(text) {
    const matches = String(text || "").match(/\{\{(\d+)\}\}/g) || [];
    if (!matches.length) return 0;
    return Math.max(
        ...matches.map((token) => Number(String(token).replace(/\D/g, "")) || 0)
    );
}

function deepClone(value) {
    return JSON.parse(JSON.stringify(value ?? null));
}

/**
 * Convert a OneChatting template-list item into OOMS system template + example payloads.
 * `variable_keys` must be Meta-order keys like ["{{name}}", "{{balance}}", ...].
 */
function buildSystemTemplateFromOneChatting(
    oneChattingItem,
    variable_keys = [],
    { header_media_url = null } = {}
) {
    if (!oneChattingItem || typeof oneChattingItem !== "object") {
        throw new Error("OneChatting template payload is required");
    }

    const templateName =
        oneChattingItem.template_name ||
        oneChattingItem.template?.name ||
        "";
    const name = String(templateName).trim();
    if (!name) {
        throw new Error("OneChatting template_name is missing");
    }

    const sourceTemplate = deepClone(oneChattingItem.template || {});
    const category = String(
        oneChattingItem.category || sourceTemplate.category || "UTILITY"
    )
        .trim()
        .toUpperCase();
    const language = String(
        oneChattingItem.language_code ||
            sourceTemplate.language ||
            "en"
    ).trim() || "en";

    const components = Array.isArray(sourceTemplate.components)
        ? sourceTemplate.components
        : [];

    const bodyComp = components.find((item) => item?.type === "BODY");
    const placeholderCount = countBodyPlaceholders(bodyComp?.text);
    const keys = Array.isArray(variable_keys)
        ? variable_keys.map((key) => String(key || "").trim()).filter(Boolean)
        : [];

    if (placeholderCount > 0 && keys.length !== placeholderCount) {
        throw new Error(
            `This template has ${placeholderCount} body variables; map exactly ${placeholderCount} keys`
        );
    }

    const originalSamples = Array.isArray(bodyComp?.example?.body_text?.[0])
        ? bodyComp.example.body_text[0].map((v) =>
              v != null ? String(v) : ""
          )
        : keys.map((key) => String(key).replace(/[{}]/g, "") || "sample");

    const overrideMediaUrl =
        header_media_url != null && String(header_media_url).trim()
            ? String(header_media_url).trim()
            : null;

    const templateComponents = components.map((comp) => {
        if (comp?.type === "HEADER") {
            const next = deepClone(comp);
            const format = String(next.format || "").toUpperCase();
            if (
                overrideMediaUrl &&
                ["IMAGE", "VIDEO", "DOCUMENT"].includes(format)
            ) {
                next.example = {
                    ...(next.example || {}),
                    header_handle: [overrideMediaUrl],
                };
            }
            return next;
        }
        if (comp?.type !== "BODY") return deepClone(comp);
        const next = deepClone(comp);
        if (keys.length) {
            next.example = { body_text: [keys] };
        }
        return next;
    });

    const example = templateComponents.map((comp) => {
        if (comp?.type === "HEADER") {
            return deepClone(comp);
        }
        if (comp?.type === "BODY") {
            return {
                type: "BODY",
                text: comp.text || "",
                example: {
                    body_text: [
                        originalSamples.length
                            ? originalSamples
                            : keys.map((key) =>
                                  String(key).replace(/[{}]/g, "")
                              ),
                    ],
                },
            };
        }
        return deepClone(comp);
    });

    const template = {
        name,
        category,
        language,
        components: templateComponents,
    };

    return {
        template_name: name,
        category,
        language,
        template,
        example,
        onechatting_template_id: oneChattingItem.template_id || null,
        placeholder_count: placeholderCount,
    };
}

async function importSystemTemplateFromOneChatting({
    type,
    oneChattingItem,
    variable_keys,
    status = "active",
    template_id = null,
    header_media_url = null,
    username = null,
}) {
    const built = buildSystemTemplateFromOneChatting(
        oneChattingItem,
        variable_keys,
        { header_media_url }
    );

    if (template_id) {
        return updateSystemTemplate({
            template_id,
            type,
            template_name: built.template_name,
            category: built.category,
            language: built.language,
            template: built.template,
            example: built.example,
            status,
            username,
        });
    }

    return createSystemTemplate({
        type,
        template_name: built.template_name,
        category: built.category,
        language: built.language,
        template: built.template,
        example: built.example,
        status,
        username,
    });
}

async function seedSystemTemplatesFromFile({ username = "system", force = false } = {}) {
    await ensureTemplatesTable();

    const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) AS total FROM wp_system_templates`
    );
    if (Number(total) > 0 && !force) {
        return { seeded: 0, skipped: true, total: Number(total) };
    }

    if (!fs.existsSync(SEED_DATA_PATH)) {
        throw new Error(`Seed file not found: ${SEED_DATA_PATH}`);
    }

    const raw = JSON.parse(fs.readFileSync(SEED_DATA_PATH, "utf8"));
    if (!Array.isArray(raw) || !raw.length) {
        throw new Error("Seed file is empty");
    }

    let seeded = 0;
    for (const item of raw) {
        const type = canonicalType(item.type);
        const template_name =
            item.template_name != null
                ? String(item.template_name).trim()
                : String(item.template?.name || "").trim();
        if (!type || !template_name) continue;

        const [existing] = await pool.query(
            `SELECT id FROM wp_system_templates
             WHERE LOWER(TRIM(type)) = ? AND template_name = ?
             LIMIT 1`,
            [normalizeType(type), template_name]
        );
        if (existing.length && !force) {
            continue;
        }

        const templateObj = coerceTemplatePayload(
            item.template,
            template_name,
            item.template?.category || "UTILITY",
            item.template?.language || "en"
        );
        const exampleArr = coerceExamplePayload(item.example || []);

        if (existing.length) {
            await pool.query(
                `UPDATE wp_system_templates
                 SET category = ?, language = ?, template_json = ?, example_json = ?,
                     status = 'active', modify_by = ?, modify_date = NOW()
                 WHERE id = ?`,
                [
                    templateObj.category,
                    templateObj.language,
                    JSON.stringify(templateObj),
                    JSON.stringify(exampleArr),
                    username,
                    existing[0].id,
                ]
            );
        } else {
            await pool.query(
                `INSERT INTO wp_system_templates
                 (template_id, type, template_name, category, language,
                  template_json, example_json, status, create_by, modify_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
                [
                    newTemplateId(),
                    type,
                    template_name,
                    templateObj.category,
                    templateObj.language,
                    JSON.stringify(templateObj),
                    JSON.stringify(exampleArr),
                    username,
                    username,
                ]
            );
        }
        seeded += 1;
    }

    invalidateTemplateCache();
    const [[{ total: after }]] = await pool.query(
        `SELECT COUNT(*) AS total FROM wp_system_templates`
    );
    return { seeded, skipped: false, total: Number(after) || 0 };
}

export {
    loadSystemTemplates,
    listTemplatesByType,
    listDistinctTypes,
    listCanonicalTypes,
    findSystemTemplate,
    getActiveMapping,
    listBranchMappings,
    setTemplateMapping,
    unsetTemplateMapping,
    formatTemplatePreview,
    invalidateTemplateCache,
    listAdminTemplates,
    getAdminTemplate,
    createSystemTemplate,
    updateSystemTemplate,
    setSystemTemplateStatus,
    deleteSystemTemplate,
    seedSystemTemplatesFromFile,
    ensureTemplatesTable,
    isKnownSystemType,
    buildSystemTemplateFromOneChatting,
    importSystemTemplateFromOneChatting,
    countBodyPlaceholders,
};
