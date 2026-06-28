import pool from "../db.js";
import { GET_BALANCE } from "../helpers/function.js";
import {
    assertWhatsappWebSessionReady,
    executeWhatsappWebSend,
} from "../helpers/whatsappWeb.js";
import {
    getTemplateDetails,
    validateAndNormalizeContent,
    normalizeContentInput,
} from "./whatsappWebTemplateService.js";
import {
    WHATSAPPWEB_STANDARD_VARIABLES,
    buildVariableMap,
    normalizeVariableToken,
    replaceVariablesInValue,
} from "../utils/whatsappWebVariables.js";

function toStringArray(value) {
    if (value == null) return [];
    const list = Array.isArray(value) ? value : [value];
    return list
        .map((item) => (item == null ? "" : String(item).trim()))
        .filter(Boolean);
}

function formatWhatsappNumber(countryCode, mobile) {
    const cc = String(countryCode || "91").replace(/\D/g, "");
    const mob = String(mobile || "").replace(/\D/g, "");
    if (!mob) return null;
    if (mob.length >= 12 && mob.startsWith(cc)) return mob;
    if (mob.length === 10) return `${cc}${mob}`;
    if (mob.startsWith(cc)) return mob;
    return `${cc}${mob}`;
}

function numberDedupeKey(number) {
    return String(number || "").replace(/\D/g, "");
}

function mobileLookupKey(mobile) {
    const digits = numberDedupeKey(mobile);
    return digits.length >= 10 ? digits.slice(-10) : digits;
}

async function resolveClientProfileByMobile(branch_id, number) {
    const lookupKey = mobileLookupKey(number);
    if (!lookupKey) return null;

    const [rows] = await pool.query(
        `SELECT p.username, p.name, p.mobile, p.country_code, p.email
         FROM clients c
         INNER JOIN profile p ON p.username = c.username
         WHERE c.branch_id = ?
           AND c.user_type = 'client'
           AND c.is_deleted = '0'
           AND (p.status = '1' OR p.status = 'active')
           AND RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(p.mobile, ' ', ''), '-', ''), '+', ''), '(', ''), ')', ''), 10) = ?
         LIMIT 1`,
        [branch_id, lookupKey]
    );

    return rows[0] || null;
}

async function resolveClientBalance(branch_id, username) {
    if (!username) return "";
    try {
        const balanceData = await GET_BALANCE({
            branch_id,
            party_id: username,
            party_type: "client",
        });
        return balanceData?.balance != null ? Number(balanceData.balance).toFixed(2) : "";
    } catch {
        return "";
    }
}

async function enrichRecipientsWithClientProfiles(branch_id, recipients) {
    for (const recipient of recipients) {
        if (recipient.username) continue;

        const profile = await resolveClientProfileByMobile(branch_id, recipient.number);
        if (!profile) continue;

        recipient.username = profile.username;
        recipient.name = profile.name || profile.username;
        recipient.profile = profile;
        recipient.auto_variables = buildStandardClientVariables(profile);
    }
}

function buildStandardClientVariables(profile, firmName = "") {
    const vars = {
        "{{name}}": profile?.name || profile?.username || "",
        "{{mobile}}": profile?.mobile || "",
        "{{email}}": profile?.email || "",
        "{{balance}}": "",
    };
    if (firmName) {
        vars["{{firm_name}}"] = firmName;
    }
    return buildVariableMap(vars);
}

function collectRecipientInputs(payload) {
    const recipients = payload.recipients && typeof payload.recipients === "object"
        ? payload.recipients
        : {};

    return {
        usernames: [
            ...toStringArray(recipients.usernames),
            ...toStringArray(recipients.username),
            ...toStringArray(payload.usernames),
            ...toStringArray(payload.username),
        ],
        numbers: [
            ...toStringArray(recipients.numbers),
            ...toStringArray(recipients.number),
            ...toStringArray(payload.numbers),
            ...toStringArray(payload.number),
        ],
        group_ids: [
            ...toStringArray(recipients.group_ids),
            ...toStringArray(recipients.group_id),
            ...toStringArray(payload.group_ids),
            ...toStringArray(payload.group_id),
        ],
    };
}

async function resolveUserRecipients(branch_id, usernames, defaultCountryCode) {
    const uniqueUsernames = [...new Set(usernames)];
    if (!uniqueUsernames.length) {
        return { recipients: [], skipped: [] };
    }

    const placeholders = uniqueUsernames.map(() => "?").join(", ");
    const [rows] = await pool.query(
        `SELECT p.username, p.name, p.mobile, p.country_code, p.email
         FROM clients c
         INNER JOIN profile p ON p.username = c.username
         WHERE c.branch_id = ?
           AND c.user_type = 'client'
           AND c.is_deleted = '0'
           AND (p.status = '1' OR p.status = 'active')
           AND c.username IN (${placeholders})`,
        [branch_id, ...uniqueUsernames]
    );

    const profileByUsername = new Map(rows.map((row) => [row.username, row]));
    const recipients = [];
    const skipped = [];

    for (const username of uniqueUsernames) {
        const profile = profileByUsername.get(username);
        if (!profile) {
            skipped.push({
                type: "username",
                value: username,
                reason: "Client not found in this branch",
            });
            continue;
        }

        const number = formatWhatsappNumber(
            profile.country_code || defaultCountryCode,
            profile.mobile
        );
        if (!number) {
            skipped.push({
                type: "username",
                value: username,
                reason: "Mobile number not found for client",
            });
            continue;
        }

        recipients.push({
            number,
            username: profile.username,
            name: profile.name || profile.username,
            profile,
            sources: [`username:${username}`],
            auto_variables: buildStandardClientVariables(profile),
        });
    }

    return { recipients, skipped };
}

async function resolveGroupRecipients(branch_id, group_ids, defaultCountryCode) {
    const uniqueGroupIds = [...new Set(group_ids)];
    if (!uniqueGroupIds.length) {
        return { recipients: [], skipped: [] };
    }

    const placeholders = uniqueGroupIds.map(() => "?").join(", ");
    const [rows] = await pool.query(
        `SELECT g.group_id,
                p.username,
                p.name,
                p.mobile,
                p.country_code,
                p.email,
                f.firm_name
         FROM groups g
         INNER JOIN group_firms gf ON gf.group_id = g.group_id AND gf.is_deleted = '0'
         INNER JOIN firms f ON f.firm_id = gf.firm_id AND f.is_deleted = '0'
         INNER JOIN profile p ON p.username = f.username
         WHERE g.branch_id = ?
           AND g.is_deleted = '0'
           AND g.group_id IN (${placeholders})
           AND (p.status = '1' OR p.status = 'active')`,
        [branch_id, ...uniqueGroupIds]
    );

    const foundGroupIds = new Set(rows.map((row) => row.group_id));
    const skipped = [];

    for (const group_id of uniqueGroupIds) {
        if (!foundGroupIds.has(group_id)) {
            skipped.push({
                type: "group_id",
                value: group_id,
                reason: "Group not found in this branch",
            });
        }
    }

    const recipients = [];
    for (const row of rows) {
        const number = formatWhatsappNumber(row.country_code || defaultCountryCode, row.mobile);
        if (!number) {
            skipped.push({
                type: "username",
                value: row.username,
                group_id: row.group_id,
                reason: "Mobile number not found for group member",
            });
            continue;
        }

        recipients.push({
            number,
            username: row.username,
            name: row.name || row.username,
            group_id: row.group_id,
            profile: row,
            sources: [`group_id:${row.group_id}`],
            auto_variables: buildStandardClientVariables(row, row.firm_name),
        });
    }

    return { recipients, skipped };
}

function resolveNumberRecipients(numbers, defaultCountryCode) {
    const recipients = [];
    const skipped = [];

    for (const raw of numbers) {
        const number = formatWhatsappNumber(defaultCountryCode, raw);
        if (!number) {
            skipped.push({
                type: "number",
                value: raw,
                reason: "Invalid mobile number",
            });
            continue;
        }

        recipients.push({
            number,
            username: null,
            name: null,
            sources: [`number:${raw}`],
            auto_variables: {},
        });
    }

    return { recipients, skipped };
}

function dedupeRecipients(recipients) {
    const map = new Map();

    for (const recipient of recipients) {
        const key = numberDedupeKey(recipient.number);
        if (!key) continue;

        if (map.has(key)) {
            const existing = map.get(key);
            existing.sources = [...new Set([...existing.sources, ...recipient.sources])];
            if (!existing.username && recipient.username) {
                existing.username = recipient.username;
                existing.name = recipient.name;
                existing.profile = recipient.profile;
                existing.auto_variables = recipient.auto_variables;
            }
            if (!existing.group_id && recipient.group_id) {
                existing.group_id = recipient.group_id;
            }
            continue;
        }

        map.set(key, {
            ...recipient,
            sources: [...recipient.sources],
        });
    }

    return Array.from(map.values());
}

async function resolveAllRecipients(branch_id, payload) {
    const defaultCountryCode = payload.default_country_code || "91";
    const inputs = collectRecipientInputs(payload);

    const fromUsers = await resolveUserRecipients(branch_id, inputs.usernames, defaultCountryCode);
    const fromGroups = await resolveGroupRecipients(branch_id, inputs.group_ids, defaultCountryCode);
    const fromNumbers = resolveNumberRecipients(inputs.numbers, defaultCountryCode);

    const recipients = dedupeRecipients([
        ...fromUsers.recipients,
        ...fromGroups.recipients,
        ...fromNumbers.recipients,
    ]);

    return {
        recipients,
        skipped: [...fromUsers.skipped, ...fromGroups.skipped, ...fromNumbers.skipped],
        input_counts: {
            usernames: inputs.usernames.length,
            numbers: inputs.numbers.length,
            group_ids: inputs.group_ids.length,
        },
    };
}

async function resolveMessageTemplate(branch_id, payload) {
    const { template_id, template_type, variables = {} } = payload;

    if (template_id) {
        const template = await getTemplateDetails({ branch_id, template_id });
        if (template.status !== "active") {
            throw new Error("Template is not active");
        }

        const templateVariables = (template.variables_json || []).map(normalizeVariableToken).filter(Boolean);
        if (!templateVariables.length) {
            throw new Error("Template has no variables configured");
        }

        return {
            mode: "template",
            template_id: template.template_id,
            template_name: template.template_name,
            template_type: template.template_type,
            content_template: template.content,
            template_variables: templateVariables,
            optional_overrides: variables,
        };
    }

    const rawContent = normalizeContentInput(payload);
    if (template_type && rawContent !== undefined) {
        const content = validateAndNormalizeContent(template_type, rawContent);
        return {
            mode: "direct",
            template_id: null,
            template_name: null,
            template_type,
            content_template: content,
            template_variables: WHATSAPPWEB_STANDARD_VARIABLES,
            optional_overrides: variables,
        };
    }

    throw new Error("Provide template_id or both template_type and content");
}

function collectOptionalOverrides(payload) {
    const overrides = buildVariableMap(payload.variables || {});
    const recipientVariables = payload.recipient_variables || {};

    return {
        global: overrides,
        recipient: recipientVariables,
    };
}

async function resolveTemplateVariablesForRecipient(
    branch_id,
    recipient,
    templateVariables,
    optionalOverrides = {}
) {
    const profile = recipient.profile || {
        username: recipient.username,
        name: recipient.name,
        mobile: "",
        email: "",
        country_code: "",
    };

    if (!recipient.username && !profile.username) {
        const error = new Error("Recipient profile is required to resolve template variables");
        error.status = 400;
        throw error;
    }

    const recipientOverrides = optionalOverrides.recipient || {};
    const byUsername = recipient.username ? recipientOverrides[recipient.username] : null;
    const byNumber =
        recipientOverrides[recipient.number] || recipientOverrides[numberDedupeKey(recipient.number)];

    const manualOverrides = buildVariableMap({
        ...optionalOverrides.global,
        ...byUsername,
        ...byNumber,
    });

    const needsBalance = templateVariables.includes("{{balance}}");
    let balance = "";
    if (needsBalance && recipient.username) {
        balance = await resolveClientBalance(branch_id, recipient.username);
    }

    const variables = {};
    for (const token of templateVariables) {
        const normalized = normalizeVariableToken(token);
        if (!normalized) continue;

        if (manualOverrides[normalized] !== undefined && manualOverrides[normalized] !== "") {
            variables[normalized] = manualOverrides[normalized];
            continue;
        }

        switch (normalized) {
            case "{{name}}":
                variables[normalized] = profile.name || recipient.name || profile.username || "";
                break;
            case "{{mobile}}":
                variables[normalized] = profile.mobile || "";
                break;
            case "{{email}}":
                variables[normalized] = profile.email || "";
                break;
            case "{{balance}}":
                variables[normalized] = balance;
                break;
            default:
                variables[normalized] = manualOverrides[normalized] ?? "";
        }
    }

    return variables;
}

async function resolveDirectVariables(branch_id, recipient, templateVariables, optionalOverrides = {}) {
    let variables = buildVariableMap(recipient.auto_variables || {});

    const recipientOverrides = optionalOverrides.recipient || {};
    const byUsername = recipient.username ? recipientOverrides[recipient.username] : null;
    const byNumber =
        recipientOverrides[recipient.number] || recipientOverrides[numberDedupeKey(recipient.number)];

    variables = buildVariableMap({
        ...variables,
        ...optionalOverrides.global,
        ...byUsername,
        ...byNumber,
    });

    const profile = recipient.profile || {
        username: recipient.username,
        name: recipient.name,
        mobile: variables["{{mobile}}"] || "",
        email: variables["{{email}}"] || "",
    };

    variables["{{name}}"] = profile?.name || recipient.name || variables["{{name}}"] || "";
    variables["{{mobile}}"] = profile?.mobile || variables["{{mobile}}"] || "";
    variables["{{email}}"] = profile?.email || variables["{{email}}"] || "";

    const manualBalance =
        optionalOverrides.global?.["{{balance}}"] ??
        optionalOverrides.global?.balance ??
        byUsername?.balance ??
        byUsername?.["{{balance}}"] ??
        byNumber?.balance ??
        byNumber?.["{{balance}}"];

    if (manualBalance != null && manualBalance !== "") {
        variables["{{balance}}"] = String(manualBalance);
    } else if (recipient.username) {
        variables["{{balance}}"] = await resolveClientBalance(branch_id, recipient.username);
    } else {
        variables["{{balance}}"] = variables["{{balance}}"] || "";
    }

    return variables;
}

function renderMessageContent(contentTemplate, variables) {
    return replaceVariablesInValue(contentTemplate, variables);
}

function extractUpstreamMessage(responseData) {
    if (!responseData) return "Send failed";
    if (typeof responseData === "string") return responseData;
    return responseData.message || responseData.error || "Send failed";
}

async function sendWhatsappWebMessages({ branch_id, payload }) {
    const inputs = collectRecipientInputs(payload);
    if (!inputs.usernames.length && !inputs.numbers.length && !inputs.group_ids.length) {
        const error = new Error("At least one recipient is required (username, number, or group_id)");
        error.status = 400;
        throw error;
    }

    const session = await assertWhatsappWebSessionReady(branch_id);
    if (!session.ok) {
        const error = new Error(session.data?.message || "WhatsApp Web session is not ready");
        error.status = session.status || 400;
        throw error;
    }

    const messageConfig = await resolveMessageTemplate(branch_id, payload);
    const { recipients, skipped, input_counts } = await resolveAllRecipients(branch_id, payload);

    if (!recipients.length) {
        const error = new Error("No valid recipients found");
        error.status = 400;
        error.data = {
            summary: {
                input_usernames: input_counts.usernames,
                input_numbers: input_counts.numbers,
                input_group_ids: input_counts.group_ids,
                unique_recipients: 0,
                sent: 0,
                failed: 0,
                skipped: skipped.length,
            },
            skipped,
        };
        throw error;
    }

    await enrichRecipientsWithClientProfiles(branch_id, recipients);

    const optionalOverrides = collectOptionalOverrides(payload);
    const results = [];
    let sent = 0;
    let failed = 0;

    for (const recipient of recipients) {
        let variables;
        try {
            if (messageConfig.mode === "template") {
                variables = await resolveTemplateVariablesForRecipient(
                    branch_id,
                    recipient,
                    messageConfig.template_variables,
                    optionalOverrides
                );
            } else {
                variables = await resolveDirectVariables(
                    branch_id,
                    recipient,
                    messageConfig.template_variables,
                    optionalOverrides
                );
            }
        } catch (error) {
            failed += 1;
            results.push({
                number: recipient.number,
                username: recipient.username,
                name: recipient.name,
                group_id: recipient.group_id || null,
                sources: recipient.sources,
                status: "failed",
                error: error.message || "Failed to resolve template variables",
            });
            continue;
        }

        const renderedContent = renderMessageContent(messageConfig.content_template, variables);

        try {
            const response = await executeWhatsappWebSend({
                sessionId: session.sessionId,
                number: recipient.number,
                template_type: messageConfig.template_type,
                content: renderedContent,
            });

            const upstream = response.data || {};
            const isSuccess = response.status >= 200 && response.status < 300 && upstream.success !== false;

            if (isSuccess) {
                sent += 1;
                results.push({
                    number: recipient.number,
                    username: recipient.username,
                    name: recipient.name,
                    group_id: recipient.group_id || null,
                    sources: recipient.sources,
                    status: "sent",
                    resolved_variables: variables,
                    rendered_content: renderedContent,
                    upstream: upstream.data ?? upstream,
                });
            } else {
                failed += 1;
                results.push({
                    number: recipient.number,
                    username: recipient.username,
                    name: recipient.name,
                    group_id: recipient.group_id || null,
                    sources: recipient.sources,
                    status: "failed",
                    error: extractUpstreamMessage(upstream),
                    upstream,
                });
            }
        } catch (error) {
            failed += 1;
            results.push({
                number: recipient.number,
                username: recipient.username,
                name: recipient.name,
                group_id: recipient.group_id || null,
                sources: recipient.sources,
                status: "failed",
                error: extractUpstreamMessage(error.response?.data) || error.message || "Send failed",
                upstream: error.response?.data || null,
            });
        }
    }

    const summary = {
        mode: messageConfig.mode,
        template_id: messageConfig.template_id,
        template_name: messageConfig.template_name,
        template_type: messageConfig.template_type,
        input_usernames: input_counts.usernames,
        input_numbers: input_counts.numbers,
        input_group_ids: input_counts.group_ids,
        unique_recipients: recipients.length,
        sent,
        failed,
        skipped: skipped.length,
    };

    return {
        success: sent > 0,
        message:
            sent > 0
                ? `Successfully sent ${sent} of ${recipients.length} message(s)`
                : "No messages were sent",
        data: {
            summary,
            results,
            skipped,
        },
    };
}

export { sendWhatsappWebMessages };
