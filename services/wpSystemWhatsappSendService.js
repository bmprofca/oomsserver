import axios from "axios";
import pool from "../db.js";
import {
    findSystemTemplate,
    getActiveMapping,
} from "./wpSystemTemplateService.js";

const ONECHATTING_BASE_URL = String(process.env.ONECHATTING_BASE_URL || "")
    .trim()
    .replace(/\/$/, "");
const ONECHATTING_SEND_TEMPLATE_URL = `${ONECHATTING_BASE_URL}/developer/message/send-template`;
const ONECHATTING_TEMPLATE_LIST_URL = `${ONECHATTING_BASE_URL}/developer/template/template-list`;

function getSystemDeveloperToken() {
    const token = process.env.ONECHATTING_SYSTEM_DEVELOPER_TOKEN
        ? String(process.env.ONECHATTING_SYSTEM_DEVELOPER_TOKEN).trim()
        : "";
    return token || null;
}

function getProjectDeveloperToken() {
    const token = process.env.ONECHATTING_PROJECT_DEVELOPER_TOKEN
        ? String(process.env.ONECHATTING_PROJECT_DEVELOPER_TOKEN).trim()
        : "";
    return token || null;
}

function resolveVariableValue(variables, key) {
    if (variables == null) {
        return "";
    }
    if (Object.prototype.hasOwnProperty.call(variables, key)) {
        return variables[key] ?? "";
    }
    const normalized = String(key).replace(/[{}]/g, "");
    const braceKey = `{{${normalized}}}`;
    if (Object.prototype.hasOwnProperty.call(variables, braceKey)) {
        return variables[braceKey] ?? "";
    }
    return "";
}

function buildSendComponent(templateEntry, variables) {
    const components = [];
    const templateComponents = templateEntry?.template?.components || [];

    for (const comp of templateComponents) {
        if (comp.type === "HEADER") {
            const format = String(comp.format || "").toUpperCase();
            const link = String(comp.example?.header_handle?.[0] || "").trim();
            if (!link) {
                continue;
            }

            if (format === "IMAGE") {
                components.push({
                    type: "header",
                    parameters: [
                        {
                            type: "image",
                            image: { link },
                        },
                    ],
                });
            } else if (format === "VIDEO") {
                components.push({
                    type: "header",
                    parameters: [
                        {
                            type: "video",
                            video: { link },
                        },
                    ],
                });
            } else if (format === "DOCUMENT") {
                const filename =
                    String(comp.example?.filename || "").trim() ||
                    String(link.split("/").pop() || "document.pdf");
                components.push({
                    type: "header",
                    parameters: [
                        {
                            type: "document",
                            document: { link, filename },
                        },
                    ],
                });
            }
            continue;
        }

        if (comp.type === "BODY") {
            const variableKeys = comp.example?.body_text?.[0] || [];
            components.push({
                type: "body",
                parameters: variableKeys.map((key) => ({
                    type: "text",
                    text: String(resolveVariableValue(variables, key)),
                })),
            });
        }
    }

    return components;
}

async function resolveTemplateId(projectToken, templateName) {
    let page_no = 1;
    const limit = 100;

    while (page_no <= 50) {
        const response = await axios.get(ONECHATTING_TEMPLATE_LIST_URL, {
            headers: { token: projectToken },
            params: { status: "APPROVED", page_no, limit },
        });

        const items = response.data?.data ?? [];
        const match = items.find(
            (item) => String(item.template_name || "").trim() === String(templateName).trim()
        );
        if (match?.template_id) {
            return String(match.template_id);
        }

        const hasMore = response.data?.meta?.has_more === true;
        if (!hasMore || items.length === 0) {
            break;
        }
        page_no += 1;
    }

    return null;
}

/**
 * List OneChatting project templates using the same PROJECT token as OOMS System send.
 * Used by Admin to import APPROVED templates into wp_system_templates.
 */
async function listOneChattingProjectTemplates({
    status = "APPROVED",
    category = "",
    page_no = 1,
    limit = 100,
    fetch_all = false,
} = {}) {
    const projectToken = getProjectDeveloperToken();
    if (!projectToken) {
        const err = new Error(
            "ONECHATTING_PROJECT_DEVELOPER_TOKEN is not configured"
        );
        err.code = "MISSING_PROJECT_TOKEN";
        throw err;
    }
    if (!ONECHATTING_TEMPLATE_LIST_URL || !ONECHATTING_BASE_URL) {
        const err = new Error("ONECHATTING_BASE_URL is not configured");
        err.code = "MISSING_BASE_URL";
        throw err;
    }

    const pageSize = Math.min(100, Math.max(1, Number(limit) || 100));
    const startPage = Math.max(1, Number(page_no) || 1);
    const all = [];
    let currentPage = startPage;
    let meta = null;

    while (currentPage <= 50) {
        const params = { page_no: currentPage, limit: pageSize };
        if (status) params.status = String(status).trim();
        if (category) params.category = String(category).trim();

        const response = await axios.get(ONECHATTING_TEMPLATE_LIST_URL, {
            headers: { token: projectToken },
            params,
        });

        const items = Array.isArray(response.data?.data)
            ? response.data.data
            : [];
        all.push(...items);
        meta = response.data?.meta || null;

        if (!fetch_all) {
            return {
                data: items,
                count: Number(response.data?.count) || items.length,
                meta: meta || {
                    page_no: currentPage,
                    limit: pageSize,
                    total_records: items.length,
                    total_pages: 1,
                    has_more: false,
                },
            };
        }

        const hasMore = meta?.has_more === true;
        if (!hasMore || items.length === 0) break;
        currentPage += 1;
    }

    return {
        data: all,
        count: all.length,
        meta: {
            page_no: 1,
            limit: all.length,
            total_records: all.length,
            total_pages: 1,
            has_more: false,
        },
    };
}

async function getBranchName(branch_id) {
    const [rows] = await pool.query(
        `SELECT name
         FROM branch_list
         WHERE branch_id = ?
           AND is_deleted = '0'
         LIMIT 1`,
        [branch_id]
    );
    return rows[0]?.name != null ? String(rows[0].name) : "";
}

async function sendOomsSystemTemplateMessage({
    branch_id,
    systemType,
    recipientNumber,
    variables,
}) {
    if (!branch_id || !systemType || !recipientNumber) {
        return { ok: false, reason: "missing_required_fields" };
    }

    const sendToken = getSystemDeveloperToken();
    if (!sendToken) {
        return { ok: false, reason: "missing_system_token" };
    }

    const projectToken = getProjectDeveloperToken();
    if (!projectToken) {
        return { ok: false, reason: "missing_project_token" };
    }

    const mapping = await getActiveMapping(branch_id, systemType);
    if (!mapping?.template_name) {
        return { ok: false, reason: "template_not_mapped" };
    }

    const templateEntry = await findSystemTemplate(
        systemType,
        mapping.template_name
    );
    if (!templateEntry) {
        return { ok: false, reason: "template_not_found" };
    }

    let template_id;
    try {
        template_id = await resolveTemplateId(projectToken, templateEntry.template_name);
    } catch (error) {
        return { ok: false, reason: "template_list_failed", error };
    }

    if (!template_id) {
        return { ok: false, reason: "template_id_not_found" };
    }

    const branch_name = await getBranchName(branch_id);
    const resolvedVariables = {
        ...variables,
        "{{branch_name}}": variables?.["{{branch_name}}"] ?? branch_name,
    };
    const component = buildSendComponent(templateEntry, resolvedVariables);

    try {
        const response = await axios.post(
            ONECHATTING_SEND_TEMPLATE_URL,
            {
                number: recipientNumber,
                template_id,
                component,
            },
            {
                headers: {
                    token: sendToken,
                    "Content-Type": "application/json",
                },
            }
        );

        return { ok: true, template_id, template_name: templateEntry.template_name, response: response.data };
    } catch (error) {
        return { ok: false, reason: "send_failed", error };
    }
}

export {
    buildSendComponent,
    getSystemDeveloperToken,
    getProjectDeveloperToken,
    listOneChattingProjectTemplates,
    sendOomsSystemTemplateMessage,
};
