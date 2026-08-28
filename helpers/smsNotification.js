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

const PAYMENT_REMINDER_TEMPLATE_TYPE = "payment reminder";

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

function paymentReminderToBracedVariables(vars = {}) {
    const invoices = Array.isArray(vars.pending_invoices) ? vars.pending_invoices : [];
    const dueDate =
        invoices.find((inv) => inv?.due_date && inv.due_date !== "Not specified")?.due_date ||
        "";

    const balanceAmount = formatDltMoney(vars.balance, vars.balance_amount);
    const amount = formatDltMoney(vars.total_due_amount, vars.balance_amount);

    const entries = {
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
    };

    const braced = {};
    for (const [key, value] of Object.entries(entries)) {
        braced[`{{${key}}}`] = value == null ? "" : String(value);
    }
    return braced;
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
           AND m.template_type = ?
           AND m.status = 1
           AND t.status = 'active'
         LIMIT 1`,
        [branch_id, templateType]
    );
    return rows[0] || null;
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

    const channel = await getBranchSmsChannel(branch_id);
    if (!channel || channel === SMS_CHANNEL_DISABLED) {
        throw new Error("SMS channel is disabled");
    }
    if (channel !== SMS_CHANNEL_FAST2SMS) {
        throw new Error("Unsupported SMS channel");
    }

    const mapping = await loadActiveSmsTemplateMapping(
        branch_id,
        PAYMENT_REMINDER_TEMPLATE_TYPE
    );
    if (!mapping?.template_id) {
        throw new Error("Payment reminder SMS template is not mapped");
    }

    const config = await getFast2SmsConfigForSend(branch_id);
    if (!config?.auth_token) {
        throw new Error("Fast2SMS is not configured for this branch");
    }

    let mobile = mobileOverride;
    if (!mobile) {
        const clientData = await USER_SNIPPED_DATA(username);
        mobile = normalizeMobileNumber(clientData?.country_code, clientData?.mobile);
    } else {
        mobile = normalizeMobileNumber(null, mobile);
    }
    if (!mobile || mobile.length !== 10) {
        throw new Error("Client does not have a valid mobile number");
    }

    const variableKeys = deriveVariableKeysFromMessageBody(mapping.message_body);
    const variablesTemplate = String(mapping.variables_values || "").trim();

    if (variableKeys.length && !variablesTemplate) {
        throw new Error("Payment reminder SMS variable mapping is incomplete");
    }

    const braced = paymentReminderToBracedVariables({
        username,
        ...reminderVariables,
    });
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
            throw new Error("Payment reminder SMS variable mapping is incomplete");
        }
    }

    const route = normalizeFast2SmsRoute(mapping.route || config.route);
    const senderId = mapping.sender_id || config.sender_id;
    const messagePayload =
        route === "dlt" || route === "otp"
            ? mapping.dlt_message_id
            : mapping.message_body;

    if ((route === "dlt" || route === "otp") && !String(messagePayload || "").trim()) {
        throw new Error("Payment reminder DLT message ID is not configured");
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
    };
}
