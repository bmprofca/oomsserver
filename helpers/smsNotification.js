import pool from "../db.js";
import { USER_SNIPPED_DATA } from "./function.js";
import { normalizeFast2SmsRoute } from "./fast2sms.js";
import { sendFast2Sms } from "./fast2smsSend.js";
import {
    getBranchSmsChannel,
    SMS_CHANNEL_DISABLED,
    SMS_CHANNEL_FAST2SMS,
} from "./smsChannel.js";
import { resolveVariablesValuesTemplate } from "./smsCampaignVariables.js";
import {
    deriveVariableKeysFromMessageBody,
    getFast2SmsConfigForSend,
} from "../services/smsFast2smsService.js";
import {
    buildPaymentReceiveVariables,
    buildPaymentVariables,
    buildTaskCompleteVariables,
    buildTaskCreateVariables,
    fetchTaskWhatsappContext,
} from "./whatsappNotification.js";

const PAYMENT_REMINDER_TEMPLATE_TYPE = "payment reminder";
const PAYMENT_RECEIVE_TEMPLATE_TYPE = "payment receive";
const PAYMENT_TEMPLATE_TYPE = "payment";
const BIRTHDAY_WISH_TEMPLATE_TYPE = "birthday wish";
const TASK_CREATE_TEMPLATE_TYPE = "task create";
const TASK_COMPLETE_TEMPLATE_TYPE = "task complete";

function normalizeMobileNumber(country_code, mobile) {
    const combined = `${country_code || ""}${mobile || ""}`.replace(/\D/g, "");
    if (combined.length >= 10) return combined.slice(-10);
    return String(mobile || "").replace(/\D/g, "").slice(-10);
}

function formatDltMoney(formattedValue, numericValue) {
    if (numericValue != null && Number.isFinite(Number(numericValue))) {
        return Math.abs(Number(numericValue)).toFixed(2);
    }
    const cleaned = String(formattedValue ?? "")
        .replace(/\u20B9/g, "")
        .replace(/,/g, "")
        .trim();
    const num = parseFloat(cleaned.replace(/[^\d.]/g, ""));
    if (Number.isFinite(num)) return Math.abs(num).toFixed(2);
    return cleaned;
}

/** Normalize mixed `{ name }` / `{ "{{name}}" }` maps into braced `{{key}}` entries. */
export function toBracedVariables(vars = {}) {
    const braced = {};
    for (const [key, value] of Object.entries(vars || {})) {
        const raw = String(key || "").trim();
        if (!raw) continue;
        const bracedKey = raw.startsWith("{{") ? raw : `{{${raw}}}`;
        braced[bracedKey] = value == null ? "" : String(value);
    }
    return braced;
}

function paymentReminderToBracedVariables(vars = {}) {
    const invoices = Array.isArray(vars.pending_invoices) ? vars.pending_invoices : [];
    const dueDate =
        invoices.find((inv) => inv?.due_date && inv.due_date !== "Not specified")?.due_date ||
        "";

    const balanceAmount = formatDltMoney(vars.balance, vars.balance_amount);
    const amount = formatDltMoney(vars.total_due_amount, vars.balance_amount);

    return toBracedVariables({
        name: vars.name ?? vars.username ?? "",
        mobile: vars.mobile ?? vars.phone ?? "",
        email: vars.email ?? "",
        firm_name: vars.firm_name ?? "",
        amount,
        due_date: dueDate,
        balance: balanceAmount,
        balance_amount: balanceAmount,
        payment_link: vars.payment_link ?? "",
        current_date: vars.current_date ?? "",
        username: vars.username ?? "",
    });
}

async function loadActiveSmsTemplateMapping(branch_id, templateType) {
    const [rows] = await pool.query(
        `SELECT m.variables_values,
                t.template_id,
                t.name,
                t.dlt_message_id,
                t.message_body,
                t.variable_keys,
                t.sender_id,
                t.route,
                t.status AS template_status
         FROM sms_fast2sms_template_mapping m
         INNER JOIN sms_fast2sms_templates t
           ON t.template_id = m.sms_template_id
          AND t.branch_id = m.branch_id
         WHERE m.branch_id = ?
           AND LOWER(TRIM(m.template_type)) = ?
           AND m.status = 1
           AND t.status = 'active'
         LIMIT 1`,
        [branch_id, String(templateType || "").trim().toLowerCase()]
    );
    return rows[0] || null;
}

/**
 * Shared Fast2SMS send using an active type → template mapping.
 * @throws on misconfiguration / invalid mobile when `throwOnError` (default true)
 */
export async function sendMappedFast2Sms({
    branch_id,
    templateType,
    bracedVariables = {},
    mobile: mobileOverride,
    country_code,
    username,
    labelForErrors,
}) {
    const typeLabel = labelForErrors || templateType || "SMS";

    if (!branch_id || !templateType) {
        throw new Error("branch_id and templateType are required");
    }

    const channel = await getBranchSmsChannel(branch_id);
    if (!channel || channel === SMS_CHANNEL_DISABLED) {
        throw new Error("SMS channel is disabled");
    }
    if (channel !== SMS_CHANNEL_FAST2SMS) {
        throw new Error("Unsupported SMS channel");
    }

    const mapping = await loadActiveSmsTemplateMapping(branch_id, templateType);
    if (!mapping?.template_id) {
        throw new Error(`${typeLabel} SMS template is not mapped`);
    }

    const config = await getFast2SmsConfigForSend(branch_id);
    if (!config?.auth_token) {
        throw new Error("Fast2SMS is not configured for this branch");
    }

    let mobile = mobileOverride;
    if (!mobile && username) {
        const clientData = await USER_SNIPPED_DATA(username);
        mobile = normalizeMobileNumber(clientData?.country_code, clientData?.mobile);
    } else {
        mobile = normalizeMobileNumber(country_code, mobile);
    }
    if (!mobile || mobile.length !== 10) {
        throw new Error("Recipient does not have a valid mobile number");
    }

    const variableKeys = deriveVariableKeysFromMessageBody(mapping.message_body);
    const variablesTemplate = String(mapping.variables_values || "").trim();

    if (variableKeys.length && !variablesTemplate) {
        throw new Error(`${typeLabel} SMS variable mapping is incomplete`);
    }

    const braced = toBracedVariables(bracedVariables);
    const variablesValues = resolveVariablesValuesTemplate(
        variablesTemplate,
        braced
    );

    if (variableKeys.length) {
        const parts = variablesValues.split("|");
        if (
            parts.length !== variableKeys.length ||
            parts.some((part) => !String(part || "").trim())
        ) {
            throw new Error(`${typeLabel} SMS variable mapping is incomplete`);
        }
    }

    const route = normalizeFast2SmsRoute(mapping.route || config.route);
    const senderId = mapping.sender_id || config.sender_id;
    const messagePayload =
        route === "dlt" || route === "otp"
            ? mapping.dlt_message_id
            : mapping.message_body;

    if ((route === "dlt" || route === "otp") && !String(messagePayload || "").trim()) {
        throw new Error(`${typeLabel} DLT message ID is not configured`);
    }

    const result = await sendFast2Sms({
        authToken: config.auth_token,
        route,
        numbers: [mobile],
        senderId,
        message: messagePayload,
        variablesValues: variablesValues || undefined,
        entityId: config.entity_id,
    });

    return {
        status: "sent",
        request_id: result.request_id || null,
        mobile,
        template_type: templateType,
    };
}

/**
 * Send payment reminder SMS using branch Fast2SMS mapping for "payment reminder".
 */
export async function sendPaymentReminderSms({
    branch_id,
    username,
    reminderVariables = {},
    mobile: mobileOverride,
}) {
    if (!branch_id || !username) {
        throw new Error("branch_id and username are required");
    }

    return sendMappedFast2Sms({
        branch_id,
        templateType: PAYMENT_REMINDER_TEMPLATE_TYPE,
        username,
        mobile: mobileOverride,
        bracedVariables: paymentReminderToBracedVariables({
            username,
            ...reminderVariables,
        }),
        labelForErrors: "Payment reminder",
    });
}

export async function sendBirthdayWishSms({
    branch_id,
    username,
    variables = {},
    mobile: mobileOverride,
}) {
    if (!branch_id || !username) {
        throw new Error("branch_id and username are required");
    }

    return sendMappedFast2Sms({
        branch_id,
        templateType: BIRTHDAY_WISH_TEMPLATE_TYPE,
        username,
        mobile: mobileOverride || variables.mobile || variables["{{mobile}}"],
        bracedVariables: toBracedVariables(variables),
        labelForErrors: "Birthday wish",
    });
}

export async function sendPaymentReceiveSms({
    branch_id,
    amount,
    party1_id,
    party1_type,
    transaction_date,
    invoice_no,
    received_by,
}) {
    if (!branch_id || !party1_id) {
        throw new Error("branch_id and party1_id are required");
    }

    const clientData = await USER_SNIPPED_DATA(party1_id);
    const bracedVariables = await buildPaymentReceiveVariables({
        branch_id,
        party1_id,
        party1_type,
        amount,
        transaction_date,
        invoice_no,
        received_by_username: received_by,
    });

    return sendMappedFast2Sms({
        branch_id,
        templateType: PAYMENT_RECEIVE_TEMPLATE_TYPE,
        username: party1_id,
        mobile: clientData?.mobile,
        country_code: clientData?.country_code,
        bracedVariables,
        labelForErrors: "Payment receive",
    });
}

export async function sendPaymentSms({
    branch_id,
    amount,
    party2_id,
    party2_type,
    transaction_date,
    invoice_no,
    paid_by,
}) {
    if (!branch_id || !party2_id) {
        throw new Error("branch_id and party2_id are required");
    }

    const receiverData = await USER_SNIPPED_DATA(party2_id);
    const bracedVariables = await buildPaymentVariables({
        branch_id,
        party2_id,
        party2_type,
        amount,
        transaction_date,
        invoice_no,
        paid_by_username: paid_by,
    });

    return sendMappedFast2Sms({
        branch_id,
        templateType: PAYMENT_TEMPLATE_TYPE,
        username: party2_id,
        mobile: receiverData?.mobile,
        country_code: receiverData?.country_code,
        bracedVariables,
        labelForErrors: "Payment",
    });
}

export async function sendTaskCreatedSms({ branch_id, task_id }) {
    if (!branch_id || !task_id) return null;

    const channel = await getBranchSmsChannel(branch_id);
    if (!channel || channel === SMS_CHANNEL_DISABLED || channel !== SMS_CHANNEL_FAST2SMS) {
        return null;
    }
    const mapping = await loadActiveSmsTemplateMapping(branch_id, TASK_CREATE_TEMPLATE_TYPE);
    if (!mapping?.template_id) return null;

    const taskRow = await fetchTaskWhatsappContext(branch_id, task_id);
    if (!taskRow) return null;

    const bracedVariables = await buildTaskCreateVariables(taskRow);
    return sendMappedFast2Sms({
        branch_id,
        templateType: TASK_CREATE_TEMPLATE_TYPE,
        mobile: taskRow.client_mobile,
        country_code: taskRow.client_country_code,
        username: taskRow.client_username,
        bracedVariables,
        labelForErrors: "Task create",
    });
}

export async function sendTaskCompletedSms({ branch_id, task_id, completed_by }) {
    if (!branch_id || !task_id) return null;

    const channel = await getBranchSmsChannel(branch_id);
    if (!channel || channel === SMS_CHANNEL_DISABLED || channel !== SMS_CHANNEL_FAST2SMS) {
        return null;
    }
    const mapping = await loadActiveSmsTemplateMapping(branch_id, TASK_COMPLETE_TEMPLATE_TYPE);
    if (!mapping?.template_id) return null;

    const taskRow = await fetchTaskWhatsappContext(branch_id, task_id);
    if (!taskRow) return null;

    const bracedVariables = await buildTaskCompleteVariables(taskRow, completed_by);
    return sendMappedFast2Sms({
        branch_id,
        templateType: TASK_COMPLETE_TEMPLATE_TYPE,
        mobile: taskRow.client_mobile,
        country_code: taskRow.client_country_code,
        username: taskRow.client_username,
        bracedVariables,
        labelForErrors: "Task complete",
    });
}

function notifyFireAndForget(label, promiseFactory) {
    void Promise.resolve()
        .then(promiseFactory)
        .catch((err) => {
            console.error(`${label} SMS failed:`, err?.response?.data || err?.message || err);
        });
}

export function notifyPaymentReceiveSms(params) {
    notifyFireAndForget("Payment receive", () => sendPaymentReceiveSms(params));
}

export function notifyPaymentSms(params) {
    notifyFireAndForget("Payment", () => sendPaymentSms(params));
}

export function notifyTaskCreatedSms({ branch_id, task_id }) {
    notifyFireAndForget("Task create", () => sendTaskCreatedSms({ branch_id, task_id }));
}

export function notifyTaskCompletedSms({ branch_id, task_id, completed_by }) {
    notifyFireAndForget("Task complete", () =>
        sendTaskCompletedSms({ branch_id, task_id, completed_by })
    );
}
