import axios from "axios";
import pool from "../db.js";
import { BASE_DOMAIN } from "../helpers/Config.js";
import {
    findSystemTemplate,
    getActiveMapping,
} from "./wpSystemTemplateService.js";

const ONECHATTING_BASE_URL = process.env.ONECHATTING_BASE_URL || "https://server.onechatting.com";
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
        if (comp.type === "HEADER" && comp.format === "IMAGE") {
            const handle = comp.example?.header_handle?.[0] || "";
            const link = String(handle).replace(/\{BASE_DOMAIN\}/g, BASE_DOMAIN);
            if (!link) {
                continue;
            }
            components.push({
                type: "header",
                parameters: [
                    {
                        type: "image",
                        image: { link },
                    },
                ],
            });
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

    const templateEntry = findSystemTemplate(systemType, mapping.template_name);
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
    sendOomsSystemTemplateMessage,
};
