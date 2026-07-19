import axios from "axios";
import pool from "../db.js";
import { GET_BALANCE, USER_SNIPPED_DATA } from "./function.js";
import { sendWhatsappWebMessage } from "./whatsappWeb.js";
import { getTemplateBySystemName } from "../services/whatsappWebTemplateMappingService.js";
import { sendOomsSystemTemplateMessage } from "../services/wpSystemWhatsappSendService.js";
import { resolveComponentMedia } from "./onechattingTemplateMedia.js";

const ONECHATTING_BASE_URL = process.env.ONECHATTING_BASE_URL || "https://server.onechatting.com";
const ONECHATTING_SEND_TEMPLATE_URL = `${ONECHATTING_BASE_URL}/developer/message/send-template`;
const ONECHATTING_TEMPLATE_LIST_URL = `${ONECHATTING_BASE_URL}/developer/template/template-list`;

const TASK_CREATE_TEMPLATE_NAME = "task create";
const TASK_COMPLETE_TEMPLATE_NAME = "task complete";
const PAYMENT_RECEIVE_TEMPLATE_NAME = "payment receive";
const PAYMENT_REMINDER_TEMPLATE_NAME = "payment reminder";
const WHATSAPP_CHANNEL_ONECHATTING = "onechatting";
const WHATSAPP_CHANNEL_OOMS_WEB = "ooms web";
const WHATSAPP_CHANNEL_OOMS_SYSTEM = "ooms system";

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

function parseStoredComponent(value) {
    if (value == null) return null;
    if (typeof value === "object") return value;
    try {
        return JSON.parse(String(value));
    } catch {
        return null;
    }
}

function formatWhatsappNumber(countryCode, mobile) {
    const cc = String(countryCode || "91").replace(/\D/g, "");
    const mob = String(mobile || "").replace(/\D/g, "");
    if (!mob) return null;
    if (mob.startsWith(cc)) return mob;
    return `${cc}${mob}`;
}

function replaceVariablesInString(str, variables) {
    if (typeof str !== "string") return str;
    let out = str;
    for (const [key, value] of Object.entries(variables)) {
        if (Object.prototype.hasOwnProperty.call(variables, key)) {
            out = out.split(key).join(value ?? "");
        }
    }
    return out;
}

function replaceVariablesInValue(value, variables) {
    if (typeof value === "string") {
        return replaceVariablesInString(value, variables);
    }
    if (Array.isArray(value)) {
        return value.map((item) => replaceVariablesInValue(item, variables));
    }
    if (value && typeof value === "object") {
        const next = {};
        for (const [key, item] of Object.entries(value)) {
            next[key] = replaceVariablesInValue(item, variables);
        }
        return next;
    }
    return value;
}

async function getBranchWhatsappChannel(branch_id) {
    const [rows] = await pool.query(
        `SELECT whatsapp_channel
         FROM branch_list
         WHERE branch_id = ?
           AND is_deleted = '0'
         LIMIT 1`,
        [branch_id]
    );
    const channel = rows[0]?.whatsapp_channel;
    return channel != null ? String(channel).trim().toLowerCase() : null;
}

async function getBranchDeveloperToken(branch_id) {
    const [rows] = await pool.query(
        `SELECT onechatting_developer_token
         FROM branch_list
         WHERE branch_id = ?
           AND is_deleted = '0'
         LIMIT 1`,
        [branch_id]
    );
    const token = rows[0]?.onechatting_developer_token
        ? String(rows[0].onechatting_developer_token).trim()
        : "";
    return token || null;
}

async function getUserOnechattingToken(username, branch_id) {
    const [rows] = await pool.query(
        `SELECT onechatting_token, onechatting_enabled
         FROM branch_mapping
         WHERE username = ?
           AND branch_id = ?
           AND is_deleted = '0'
         LIMIT 1`,
        [username, branch_id]
    );
    if (!rows.length) return null;
    const row = rows[0];
    if (row.onechatting_enabled !== "1" || !row.onechatting_token) return null;
    return String(row.onechatting_token).trim();
}

async function loadActiveTemplateMapping(branch_id, systemTemplateName) {
    const [rows] = await pool.query(
        `SELECT map_id, template, onechatting_template_name, component, status
         FROM onechatting_template_mapping
         WHERE branch_id = ?
           AND template = ?
           AND status = 1
         LIMIT 1`,
        [branch_id, systemTemplateName]
    );
    return rows[0] || null;
}

async function resolveOnechattingTemplateId(developerToken, templateName) {
    let page_no = 1;
    const limit = 100;

    while (page_no <= 50) {
        const response = await axios.get(ONECHATTING_TEMPLATE_LIST_URL, {
            headers: { token: developerToken },
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
        if (!hasMore || items.length === 0) break;
        page_no += 1;
    }

    return null;
}

async function fetchTaskWhatsappContext(branch_id, task_id) {
    const [rows] = await pool.query(
        `SELECT
            t.task_id,
            t.branch_id,
            t.firm_id,
            t.total,
            t.fees,
            t.due_date,
            t.create_date,
            t.create_by,
            t.complete_date,
            t.complete_by,
            s.name AS service_name,
            f.firm_name,
            f.username AS client_username,
            p.name AS client_name,
            p.mobile AS client_mobile,
            p.country_code AS client_country_code,
            p.email AS client_email
         FROM tasks t
         LEFT JOIN services s ON s.service_id = t.service_id
         LEFT JOIN firms f
           ON f.firm_id = t.firm_id
          AND f.branch_id = t.branch_id
          AND (f.is_deleted = '0' OR f.is_deleted = 0)
         LEFT JOIN profile p
           ON p.username = f.username
          AND p.status = '1'
          AND p.id = (
              SELECT MAX(p2.id)
              FROM profile p2
              WHERE p2.username = f.username
                AND p2.status = '1'
          )
         WHERE t.task_id = ?
           AND t.branch_id = ?
         LIMIT 1`,
        [task_id, branch_id]
    );
    return rows[0] || null;
}

async function buildTaskPaymentVariables(branch_id, clientUsername) {
    const username = clientUsername ? String(clientUsername).trim() : "";
    const payment_link = username
        ? `${process.env.APP_URL || "https://yourdomain.com"}/payment/${username}`
        : "";

    let balance = "";
    if (username) {
        try {
            const balanceData = await GET_BALANCE({
                branch_id,
                party_id: username,
                party_type: "client",
            });
            balance =
                balanceData?.balance != null ? Number(balanceData.balance).toFixed(2) : "";
        } catch {
            balance = "";
        }
    }

    return {
        "{{payment_link}}": payment_link,
        "{{balance}}": balance,
    };
}

function formatTaskFees(taskRow) {
    if (taskRow.total != null) return Number(taskRow.total).toFixed(2);
    if (taskRow.fees != null) return Number(taskRow.fees).toFixed(2);
    return "";
}

async function buildTaskCreateVariables(taskRow) {
    const creator = await USER_SNIPPED_DATA(taskRow.create_by || "");
    const createByDisplay =
        (creator?.name && String(creator.name).trim()) ||
        creator?.username ||
        String(taskRow.create_by || "").trim() ||
        "";

    const paymentVariables = await buildTaskPaymentVariables(
        taskRow.branch_id,
        taskRow.client_username
    );

    return {
        "{{name}}": taskRow.client_name != null ? String(taskRow.client_name) : "",
        "{{mobile}}": taskRow.client_mobile != null ? String(taskRow.client_mobile) : "",
        "{{email}}": taskRow.client_email != null ? String(taskRow.client_email) : "",
        "{{firm_name}}": taskRow.firm_name != null ? String(taskRow.firm_name) : "",
        "{{service_name}}": taskRow.service_name != null ? String(taskRow.service_name) : "",
        "{{due_date}}": formatDateOnly(taskRow.due_date),
        "{{created_by}}": createByDisplay,
        "{{created_date}}": formatDateTime(taskRow.create_date),
        "{{fees}}": formatTaskFees(taskRow),
        ...paymentVariables,
    };
}

async function buildTaskCompleteVariables(taskRow, completed_by) {
    const completer = await USER_SNIPPED_DATA(
        completed_by || taskRow.complete_by || ""
    );
    const completedByDisplay =
        (completer?.name && String(completer.name).trim()) ||
        completer?.username ||
        String(completed_by || taskRow.complete_by || "").trim() ||
        "";

    const paymentVariables = await buildTaskPaymentVariables(
        taskRow.branch_id,
        taskRow.client_username
    );

    return {
        "{{name}}": taskRow.client_name != null ? String(taskRow.client_name) : "",
        "{{mobile}}": taskRow.client_mobile != null ? String(taskRow.client_mobile) : "",
        "{{email}}": taskRow.client_email != null ? String(taskRow.client_email) : "",
        "{{firm_name}}": taskRow.firm_name != null ? String(taskRow.firm_name) : "",
        "{{service_name}}": taskRow.service_name != null ? String(taskRow.service_name) : "",
        "{{due_date}}": formatDateOnly(taskRow.due_date),
        "{{completed_by}}": completedByDisplay,
        "{{completed_date}}": formatDateTime(new Date()),
        "{{fees}}": formatTaskFees(taskRow),
        ...paymentVariables,
    };
}

async function buildPaymentReceiveVariables({
    branch_id,
    party1_id,
    party1_type,
    amount,
    transaction_date,
    invoice_no,
    received_by_username,
}) {
    const clientData = await USER_SNIPPED_DATA(party1_id);
    const receiver = await USER_SNIPPED_DATA(received_by_username || "");
    const receivedByDisplay =
        (receiver?.name && String(receiver.name).trim()) ||
        receiver?.username ||
        String(received_by_username || "").trim() ||
        "";

    const receivedAmount = Number(amount).toFixed(2);

    let opening_balance = "";
    let closing_balance = "";
    try {
        const balanceData = await GET_BALANCE({
            branch_id,
            party_id: party1_id,
            party_type: party1_type,
        });
        if (balanceData?.balance != null) {
            const closing = Number(balanceData.balance);
            closing_balance = closing.toFixed(2);
            opening_balance = (closing + Number(amount)).toFixed(2);
        }
    } catch {
        opening_balance = "";
        closing_balance = "";
    }

    return {
        "{{name}}":
            clientData?.name != null
                ? String(clientData.name)
                : clientData?.username || String(party1_id),
        "{{mobile}}": clientData?.mobile != null ? String(clientData.mobile) : "",
        "{{email}}": clientData?.email != null ? String(clientData.email) : "",
        "{{received_amount}}": receivedAmount,
        "{{received_by}}": receivedByDisplay,
        "{{transaction_date}}": formatDateOnly(transaction_date),
        "{{invoice_no}}": invoice_no != null ? String(invoice_no) : "",
        "{{opening_balance}}": opening_balance,
        "{{closing_balance}}": closing_balance,
    };
}

async function sendOnechattingTemplateMessage({ token, number, template_id, component }) {
    await axios.post(
        ONECHATTING_SEND_TEMPLATE_URL,
        { number, template_id, component },
        {
            headers: {
                token,
                "Content-Type": "application/json",
            },
        }
    );
}

async function sendOnechattingByChannel({
    branch_id,
    systemTemplateName,
    senderUsername,
    recipientNumber,
    variables,
}) {
    const mapping = await loadActiveTemplateMapping(branch_id, systemTemplateName);
    if (!mapping?.onechatting_template_name) return;

    const storedComponent = parseStoredComponent(mapping.component);
    if (!storedComponent) return;

    const branchDeveloperToken = await getBranchDeveloperToken(branch_id);
    if (!branchDeveloperToken) return;

    const template_id = await resolveOnechattingTemplateId(
        branchDeveloperToken,
        mapping.onechatting_template_name
    );
    if (!template_id) return;

    const senderToken = await getUserOnechattingToken(senderUsername, branch_id);
    if (!senderToken) return;

    const withVariables = replaceVariablesInValue(storedComponent, variables);
    const component = await resolveComponentMedia(withVariables);

    await sendOnechattingTemplateMessage({
        token: senderToken,
        number: recipientNumber,
        template_id,
        component,
    });
}

async function sendWhatsappWebByChannel({
    branch_id,
    systemTemplateName,
    recipientNumber,
    variables,
}) {
    const template = await getTemplateBySystemName({
        branch_id,
        systemTemplateName,
    });
    if (!template || template.status !== "active" || !template.content) return;

    const content = replaceVariablesInValue(template.content, variables);

    await sendWhatsappWebMessage({
        branch_id,
        number: recipientNumber,
        template_type: template.template_type || "text",
        content,
    });
}

async function sendWhatsappByChannel({
    branch_id,
    systemTemplateName,
    senderUsername,
    recipientNumber,
    variables,
}) {
    const channel = await getBranchWhatsappChannel(branch_id);
    if (channel === WHATSAPP_CHANNEL_ONECHATTING) {
        await sendOnechattingByChannel({
            branch_id,
            systemTemplateName,
            senderUsername,
            recipientNumber,
            variables,
        });
        return;
    }

    if (channel === WHATSAPP_CHANNEL_OOMS_WEB) {
        await sendWhatsappWebByChannel({
            branch_id,
            systemTemplateName,
            recipientNumber,
            variables,
        });
        return;
    }

    if (channel === WHATSAPP_CHANNEL_OOMS_SYSTEM) {
        await sendOomsSystemTemplateMessage({
            branch_id,
            systemType: systemTemplateName,
            recipientNumber,
            variables,
        });
    }
}

async function sendTaskCreatedWhatsapp({ branch_id, task_id, created_by }) {
    if (!branch_id || !task_id) return;

    const channel = await getBranchWhatsappChannel(branch_id);
    if (!channel || channel === "disabled") return;

    const taskRow = await fetchTaskWhatsappContext(branch_id, task_id);
    if (!taskRow) return;

    const recipientNumber = formatWhatsappNumber(
        taskRow.client_country_code,
        taskRow.client_mobile
    );
    if (!recipientNumber) return;

    const variables = await buildTaskCreateVariables(taskRow);

    if (channel === WHATSAPP_CHANNEL_OOMS_SYSTEM) {
        await sendOomsSystemTemplateMessage({
            branch_id,
            systemType: TASK_CREATE_TEMPLATE_NAME,
            recipientNumber,
            variables,
        });
        return;
    }

    await sendWhatsappByChannel({
        branch_id,
        systemTemplateName: TASK_CREATE_TEMPLATE_NAME,
        senderUsername: created_by || taskRow.create_by,
        recipientNumber,
        variables,
    });
}

function notifyTaskCreatedWhatsapp({ branch_id, task_id, created_by }) {
    void sendTaskCreatedWhatsapp({ branch_id, task_id, created_by }).catch((err) => {
        console.error("Task create WhatsApp failed:", err?.response?.data || err?.message || err);
    });
}

async function sendTaskCompletedWhatsapp({ branch_id, task_id, completed_by }) {
    if (!branch_id || !task_id) return;

    const taskRow = await fetchTaskWhatsappContext(branch_id, task_id);
    if (!taskRow) return;

    const recipientNumber = formatWhatsappNumber(
        taskRow.client_country_code,
        taskRow.client_mobile
    );
    if (!recipientNumber) return;

    const variables = await buildTaskCompleteVariables(taskRow, completed_by);

    await sendWhatsappByChannel({
        branch_id,
        systemTemplateName: TASK_COMPLETE_TEMPLATE_NAME,
        senderUsername: completed_by || taskRow.complete_by || taskRow.create_by,
        recipientNumber,
        variables,
    });
}

function notifyTaskCompletedWhatsapp({ branch_id, task_id, completed_by }) {
    void sendTaskCompletedWhatsapp({ branch_id, task_id, completed_by }).catch((err) => {
        console.error("Task complete WhatsApp failed:", err?.response?.data || err?.message || err);
    });
}

async function sendPaymentReceiveWhatsapp({
    branch_id,
    amount,
    party1_id,
    party1_type,
    transaction_date,
    invoice_no,
    received_by,
}) {
    if (!branch_id || !party1_id) return;

    const clientData = await USER_SNIPPED_DATA(party1_id);
    const recipientNumber = formatWhatsappNumber(
        clientData?.country_code,
        clientData?.mobile
    );
    if (!recipientNumber) return;

    const variables = await buildPaymentReceiveVariables({
        branch_id,
        party1_id,
        party1_type,
        amount,
        transaction_date,
        invoice_no,
        received_by_username: received_by,
    });

    await sendWhatsappByChannel({
        branch_id,
        systemTemplateName: PAYMENT_RECEIVE_TEMPLATE_NAME,
        senderUsername: received_by,
        recipientNumber,
        variables,
    });
}

async function sendPaymentReminderWhatsapp({
    branch_id,
    username,
    balanceData,
    sent_by,
}) {
    if (!branch_id || !username) {
        throw new Error("branch_id and username are required");
    }

    const clientData = await USER_SNIPPED_DATA(username);
    const recipientNumber = formatWhatsappNumber(
        clientData?.country_code,
        clientData?.mobile
    );
    if (!recipientNumber) {
        throw new Error("Client does not have a valid mobile number");
    }

    const channel = await getBranchWhatsappChannel(branch_id);
    if (!channel || channel === "disabled") {
        throw new Error("WhatsApp channel is disabled");
    }
    if (channel === WHATSAPP_CHANNEL_ONECHATTING) {
        const mapping = await loadActiveTemplateMapping(
            branch_id,
            PAYMENT_REMINDER_TEMPLATE_NAME
        );
        if (!mapping?.onechatting_template_name || !parseStoredComponent(mapping.component)) {
            throw new Error("Payment reminder WhatsApp template is not configured");
        }
        if (!await getBranchDeveloperToken(branch_id)) {
            throw new Error("OneChatting developer token is not configured");
        }
        if (!await getUserOnechattingToken(sent_by, branch_id)) {
            throw new Error("Your OneChatting user token is not enabled");
        }
    } else if (channel === WHATSAPP_CHANNEL_OOMS_WEB) {
        const template = await getTemplateBySystemName({
            branch_id,
            systemTemplateName: PAYMENT_REMINDER_TEMPLATE_NAME,
        });
        if (!template || template.status !== "active" || !template.content) {
            throw new Error("Payment reminder WhatsApp Web template is not configured");
        }
    } else if (channel === WHATSAPP_CHANNEL_OOMS_SYSTEM) {
        const [rows] = await pool.query(
            `SELECT map_id
             FROM wp_system_template_mapping
             WHERE branch_id = ? AND status = 1 AND LOWER(TRIM(type)) = ?
             LIMIT 1`,
            [branch_id, PAYMENT_REMINDER_TEMPLATE_NAME]
        );
        if (!rows[0]?.map_id) {
            throw new Error("Payment reminder OOMS WhatsApp template is not configured");
        }
    } else {
        throw new Error("Unsupported WhatsApp channel");
    }

    const rawBalance = Number(balanceData?.balance ?? balanceData?.debit ?? 0);
    const balance = Math.abs(rawBalance).toFixed(2);
    const variables = {
        "{{name}}": clientData?.name != null ? String(clientData.name) : String(username),
        "{{username}}": String(username),
        "{{mobile}}": clientData?.mobile != null ? String(clientData.mobile) : "",
        "{{email}}": clientData?.email != null ? String(clientData.email) : "",
        "{{balance}}": balance,
        "{{balance_amount}}": balance,
        "{{debit_amount}}": Number(balanceData?.debit || 0).toFixed(2),
        "{{payment_link}}": `${process.env.APP_URL || "https://yourdomain.com"}/payment/${username}`,
        "{{current_date}}": formatDateOnly(new Date()),
    };

    await sendWhatsappByChannel({
        branch_id,
        systemTemplateName: PAYMENT_REMINDER_TEMPLATE_NAME,
        senderUsername: sent_by,
        recipientNumber,
        variables,
    });
}

function notifyPaymentReceiveWhatsapp(params) {
    void sendPaymentReceiveWhatsapp(params).catch((err) => {
        console.error("Payment receive WhatsApp failed:", err?.response?.data || err?.message || err);
    });
}

export {
    notifyTaskCreatedWhatsapp,
    notifyTaskCompletedWhatsapp,
    notifyPaymentReceiveWhatsapp,
    sendTaskCreatedWhatsapp,
    sendTaskCompletedWhatsapp,
    sendPaymentReceiveWhatsapp,
    sendPaymentReminderWhatsapp,
    replaceVariablesInValue,
    TASK_CREATE_TEMPLATE_NAME,
    TASK_COMPLETE_TEMPLATE_NAME,
    PAYMENT_RECEIVE_TEMPLATE_NAME,
    PAYMENT_REMINDER_TEMPLATE_NAME,
};
