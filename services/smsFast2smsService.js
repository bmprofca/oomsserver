import pool from "../db.js";
import crypto from "crypto";
import { UNIQUE_RANDOM_STRING } from "../helpers/function.js";
import { decrypt } from "../utils/smtpEncryption.js";
import { TEMPLATELIST } from "../utils/WhatsAppTemplates.js";
import { normalizeFast2SmsRoute } from "../helpers/fast2sms.js";
import { sendFast2Sms } from "../helpers/fast2smsSend.js";
import { resolveSmsCampaignRecipients } from "../helpers/smsCampaignRecipients.js";

function newShortId(prefix) {
    return `${prefix}${crypto.randomBytes(8).toString("hex")}`;
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
        // fall through
    }
    return String(raw)
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
}

function serializeTemplate(row) {
    if (!row) return null;
    return {
        template_id: row.template_id,
        branch_id: row.branch_id,
        name: row.name,
        dlt_message_id: row.dlt_message_id || "",
        message_body: row.message_body || "",
        variable_keys: parseVariableKeys(row.variable_keys),
        sender_id: row.sender_id || "",
        route: normalizeFast2SmsRoute(row.route),
        status: row.status || "active",
        create_date: row.create_date || null,
        modify_date: row.modify_date || null,
    };
}

export async function getFast2SmsConfigForSend(branch_id) {
    const [rows] = await pool.query(
        `SELECT config_id, branch_id, auth_token_encrypted, sender_id, entity_id, route, status
         FROM sms_fast2sms_configs
         WHERE branch_id = ?
           AND status = 'active'
         LIMIT 1`,
        [branch_id]
    );
    const row = rows[0];
    if (!row?.auth_token_encrypted) return null;
    return {
        ...row,
        auth_token: decrypt(row.auth_token_encrypted),
        route: normalizeFast2SmsRoute(row.route),
    };
}

export async function listTemplates(branch_id, { page_no = 1, limit = 20, search = "", status = "" } = {}) {
    const page = Math.max(1, Number(page_no) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(limit) || 20));
    const offset = (page - 1) * pageSize;
    const params = [branch_id];
    let where = "WHERE branch_id = ?";

    if (status) {
        where += " AND status = ?";
        params.push(String(status).trim());
    }
    if (search) {
        where += " AND (name LIKE ? OR dlt_message_id LIKE ? OR message_body LIKE ?)";
        const like = `%${String(search).trim()}%`;
        params.push(like, like, like);
    }

    const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) AS total FROM sms_fast2sms_templates ${where}`,
        params
    );

    const [rows] = await pool.query(
        `SELECT * FROM sms_fast2sms_templates
         ${where}
         ORDER BY modify_date DESC
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

export async function createTemplate(branch_id, username, body = {}) {
    const name = String(body.name || "").trim();
    if (!name) throw Object.assign(new Error("name is required"), { status: 400 });

    const route = normalizeFast2SmsRoute(body.route);
    const dlt_message_id = String(body.dlt_message_id || "").trim();
    const message_body = String(body.message_body || "").trim();
    const sender_id = String(body.sender_id || "").trim().toUpperCase();
    const variable_keys = parseVariableKeys(body.variable_keys);

    if ((route === "dlt" || route === "otp") && !dlt_message_id) {
        throw Object.assign(new Error("dlt_message_id is required for DLT/OTP routes"), {
            status: 400,
        });
    }
    if ((route === "q" || route === "dlt_manual") && !message_body) {
        throw Object.assign(new Error("message_body is required for this route"), {
            status: 400,
        });
    }

    const template_id = await UNIQUE_RANDOM_STRING("sms_fast2sms_templates", "template_id", {
        prefix: "smt",
    });

    await pool.query(
        `INSERT INTO sms_fast2sms_templates
         (template_id, branch_id, name, dlt_message_id, message_body, variable_keys, sender_id, route, status, create_by, modify_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [
            template_id,
            branch_id,
            name,
            dlt_message_id || null,
            message_body || null,
            JSON.stringify(variable_keys),
            sender_id || null,
            route,
            username,
            username,
        ]
    );

    const [rows] = await pool.query(
        `SELECT * FROM sms_fast2sms_templates WHERE template_id = ? LIMIT 1`,
        [template_id]
    );
    return serializeTemplate(rows[0]);
}

export async function updateTemplate(branch_id, username, body = {}) {
    const template_id = String(body.template_id || "").trim();
    if (!template_id) {
        throw Object.assign(new Error("template_id is required"), { status: 400 });
    }

    const [existingRows] = await pool.query(
        `SELECT * FROM sms_fast2sms_templates WHERE template_id = ? AND branch_id = ? LIMIT 1`,
        [template_id, branch_id]
    );
    if (!existingRows.length) {
        throw Object.assign(new Error("Template not found"), { status: 404 });
    }

    const name = String(body.name ?? existingRows[0].name).trim();
    const route = normalizeFast2SmsRoute(body.route ?? existingRows[0].route);
    const dlt_message_id = String(
        body.dlt_message_id ?? existingRows[0].dlt_message_id ?? ""
    ).trim();
    const message_body = String(
        body.message_body ?? existingRows[0].message_body ?? ""
    ).trim();
    const sender_id = String(body.sender_id ?? existingRows[0].sender_id ?? "")
        .trim()
        .toUpperCase();
    const variable_keys =
        body.variable_keys != null
            ? parseVariableKeys(body.variable_keys)
            : parseVariableKeys(existingRows[0].variable_keys);
    const status = body.status != null ? String(body.status).trim() : existingRows[0].status;

    await pool.query(
        `UPDATE sms_fast2sms_templates
         SET name = ?, dlt_message_id = ?, message_body = ?, variable_keys = ?,
             sender_id = ?, route = ?, status = ?, modify_by = ?, modify_date = CURRENT_TIMESTAMP
         WHERE template_id = ? AND branch_id = ?`,
        [
            name,
            dlt_message_id || null,
            message_body || null,
            JSON.stringify(variable_keys),
            sender_id || null,
            route,
            status || "active",
            username,
            template_id,
            branch_id,
        ]
    );

    const [rows] = await pool.query(
        `SELECT * FROM sms_fast2sms_templates WHERE template_id = ? LIMIT 1`,
        [template_id]
    );
    return serializeTemplate(rows[0]);
}

export async function listTemplateMaps(branch_id) {
    const [maps] = await pool.query(
        `SELECT m.map_id, m.template_type, m.sms_template_id, m.status,
                t.name AS sms_template_name, t.dlt_message_id, t.route, t.message_body
         FROM sms_fast2sms_template_mapping m
         LEFT JOIN sms_fast2sms_templates t
           ON t.template_id = m.sms_template_id
          AND t.branch_id = m.branch_id
         WHERE m.branch_id = ?`,
        [branch_id]
    );

    const byType = new Map();
    for (const row of maps) {
        byType.set(String(row.template_type).trim(), row);
    }

    return TEMPLATELIST.map((item) => {
        const mapped = byType.get(item.name);
        const is_set = Boolean(mapped && Number(mapped.status) === 1 && mapped.sms_template_id);
        return {
            type: item.name,
            description: item.description || "",
            available_variables: item.available_variables || [],
            is_set,
            map_id: is_set ? mapped.map_id : null,
            sms_template_id: is_set ? mapped.sms_template_id : null,
            sms_template_name: is_set ? mapped.sms_template_name : null,
            dlt_message_id: is_set ? mapped.dlt_message_id : null,
            route: is_set ? normalizeFast2SmsRoute(mapped.route) : null,
            message_preview: is_set ? mapped.message_body : null,
            status: is_set ? 1 : 0,
        };
    });
}

export async function setTemplateMap(branch_id, username, { type, sms_template_id } = {}) {
    const template_type = String(type || "").trim();
    const templateId = String(sms_template_id || "").trim();
    if (!template_type) {
        throw Object.assign(new Error("type is required"), { status: 400 });
    }
    if (!TEMPLATELIST.some((item) => item.name === template_type)) {
        throw Object.assign(new Error("Invalid system template type"), { status: 400 });
    }
    if (!templateId) {
        throw Object.assign(new Error("sms_template_id is required"), { status: 400 });
    }

    const [tplRows] = await pool.query(
        `SELECT template_id FROM sms_fast2sms_templates
         WHERE template_id = ? AND branch_id = ? AND status = 'active' LIMIT 1`,
        [templateId, branch_id]
    );
    if (!tplRows.length) {
        throw Object.assign(new Error("SMS template not found or inactive"), { status: 404 });
    }

    const [existing] = await pool.query(
        `SELECT map_id FROM sms_fast2sms_template_mapping
         WHERE branch_id = ? AND template_type = ? LIMIT 1`,
        [branch_id, template_type]
    );

    if (existing.length) {
        await pool.query(
            `UPDATE sms_fast2sms_template_mapping
             SET sms_template_id = ?, status = 1, modify_by = ?, modify_date = CURRENT_TIMESTAMP
             WHERE map_id = ?`,
            [templateId, username, existing[0].map_id]
        );
        return { map_id: existing[0].map_id, type: template_type, sms_template_id: templateId, status: 1 };
    }

    const map_id = await UNIQUE_RANDOM_STRING("sms_fast2sms_template_mapping", "map_id", {
        prefix: "stm",
    });
    await pool.query(
        `INSERT INTO sms_fast2sms_template_mapping
         (map_id, branch_id, template_type, sms_template_id, status, create_by, modify_by)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
        [map_id, branch_id, template_type, templateId, username, username]
    );
    return { map_id, type: template_type, sms_template_id: templateId, status: 1 };
}

export async function unsetTemplateMap(branch_id, username, { type } = {}) {
    const template_type = String(type || "").trim();
    if (!template_type) {
        throw Object.assign(new Error("type is required"), { status: 400 });
    }

    const [result] = await pool.query(
        `UPDATE sms_fast2sms_template_mapping
         SET status = 0, modify_by = ?, modify_date = CURRENT_TIMESTAMP
         WHERE branch_id = ? AND template_type = ? AND status = 1`,
        [username, branch_id, template_type]
    );

    if (result.affectedRows === 0) {
        throw Object.assign(new Error("Mapping not found"), { status: 404 });
    }
    return { type: template_type, status: 0 };
}

export async function listCampaigns(branch_id, { page_no = 1, limit = 20, status = "all" } = {}) {
    const page = Math.max(1, Number(page_no) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(limit) || 20));
    const offset = (page - 1) * pageSize;
    const params = [branch_id];
    let where = "WHERE branch_id = ?";

    const statusFilter = String(status || "all").trim().toLowerCase();
    if (statusFilter && statusFilter !== "all") {
        where += " AND status = ?";
        params.push(statusFilter);
    }

    const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) AS total FROM sms_fast2sms_campaigns ${where}`,
        params
    );

    const [rows] = await pool.query(
        `SELECT campaign_id, name, template_id, template_name, route, status,
                schedule_at, total_count, sent_count, failed_count, create_date, modify_date
         FROM sms_fast2sms_campaigns
         ${where}
         ORDER BY create_date DESC
         LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
    );

    return {
        data: rows,
        pagination: {
            page_no: page,
            limit: pageSize,
            total: Number(total) || 0,
            total_pages: Math.max(1, Math.ceil((Number(total) || 0) / pageSize)),
        },
    };
}

export async function getCampaignDetails(branch_id, campaign_id) {
    const [rows] = await pool.query(
        `SELECT * FROM sms_fast2sms_campaigns
         WHERE campaign_id = ? AND branch_id = ?
         LIMIT 1`,
        [campaign_id, branch_id]
    );
    if (!rows.length) {
        throw Object.assign(new Error("Campaign not found"), { status: 404 });
    }
    const campaign = rows[0];
    let audience = null;
    try {
        audience = campaign.audience_json ? JSON.parse(campaign.audience_json) : null;
    } catch {
        audience = null;
    }
    return { ...campaign, audience };
}

export async function listCampaignMessages(
    branch_id,
    campaign_id,
    { page_no = 1, limit = 20, status = "all" } = {}
) {
    await getCampaignDetails(branch_id, campaign_id);

    const page = Math.max(1, Number(page_no) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(limit) || 20));
    const offset = (page - 1) * pageSize;
    const params = [campaign_id, branch_id];
    let where = "WHERE campaign_id = ? AND branch_id = ?";

    const statusFilter = String(status || "all").trim().toLowerCase();
    if (statusFilter && statusFilter !== "all") {
        where += " AND status = ?";
        params.push(statusFilter);
    }

    const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) AS total FROM sms_fast2sms_campaign_messages ${where}`,
        params
    );

    const [rows] = await pool.query(
        `SELECT message_id, mobile, name, username, status, provider_request_id,
                error_message, sent_at, create_date
         FROM sms_fast2sms_campaign_messages
         ${where}
         ORDER BY id ASC
         LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
    );

    return {
        data: rows,
        pagination: {
            page_no: page,
            limit: pageSize,
            total: Number(total) || 0,
            total_pages: Math.max(1, Math.ceil((Number(total) || 0) / pageSize)),
        },
    };
}

export async function deleteCampaign(branch_id, username, campaign_id) {
    const campaign = await getCampaignDetails(branch_id, campaign_id);
    if (["processing"].includes(String(campaign.status).toLowerCase())) {
        throw Object.assign(new Error("Cannot delete a campaign that is still processing"), {
            status: 400,
        });
    }

    await pool.query(
        `DELETE FROM sms_fast2sms_campaign_messages WHERE campaign_id = ? AND branch_id = ?`,
        [campaign_id, branch_id]
    );
    await pool.query(
        `DELETE FROM sms_fast2sms_campaigns WHERE campaign_id = ? AND branch_id = ?`,
        [campaign_id, branch_id]
    );
    return { campaign_id, deleted: true, modify_by: username };
}

/**
 * Create campaign + recipients, then process send asynchronously.
 */
export async function createCampaign(branch_id, username, body = {}) {
    const name = String(body.name || "").trim();
    const template_id = String(body.template_id || "").trim();
    if (!name) throw Object.assign(new Error("name is required"), { status: 400 });
    if (!template_id) {
        throw Object.assign(new Error("template_id is required"), { status: 400 });
    }

    const [tplRows] = await pool.query(
        `SELECT * FROM sms_fast2sms_templates
         WHERE template_id = ? AND branch_id = ? AND status = 'active'
         LIMIT 1`,
        [template_id, branch_id]
    );
    if (!tplRows.length) {
        throw Object.assign(new Error("Template not found or inactive"), { status: 404 });
    }
    const template = tplRows[0];

    const config = await getFast2SmsConfigForSend(branch_id);
    if (!config) {
        throw Object.assign(new Error("Fast2SMS is not configured for this branch"), {
            status: 400,
        });
    }

    let recipients = [];
    if (Array.isArray(body.numbers) && body.numbers.length) {
        const meta = { duplicates_skipped: 0, skipped_invalid_mobile: 0 };
        const map = new Map();
        for (const raw of body.numbers) {
            const mobile = String(raw || "").replace(/\D/g, "").slice(-10);
            if (mobile.length !== 10) {
                meta.skipped_invalid_mobile += 1;
                continue;
            }
            if (map.has(mobile)) {
                meta.duplicates_skipped += 1;
                continue;
            }
            map.set(mobile, { mobile, name: mobile, username: "" });
        }
        recipients = [...map.values()];
    } else if (body.audience && typeof body.audience === "object") {
        const resolved = await resolveSmsCampaignRecipients(branch_id, body.audience);
        if (!resolved.ok) {
            const err = new Error(resolved.data?.message || "Failed to resolve recipients");
            err.status = resolved.status;
            err.payload = resolved.data;
            throw err;
        }
        recipients = resolved.data;
    } else {
        throw Object.assign(new Error("Provide audience or numbers"), { status: 400 });
    }

    if (!recipients.length) {
        throw Object.assign(new Error("No valid recipients found"), { status: 400 });
    }

    const variables_values =
        body.variables_values != null ? String(body.variables_values).trim() : "";
    const schedule_at =
        body.schedule_at != null && String(body.schedule_at).trim()
            ? String(body.schedule_at).trim()
            : null;

    const route = normalizeFast2SmsRoute(template.route || config.route);
    const sender_id =
        String(template.sender_id || config.sender_id || "").trim().toUpperCase() || null;

    const campaign_id = await UNIQUE_RANDOM_STRING("sms_fast2sms_campaigns", "campaign_id", {
        prefix: "smc",
    });

    const initialStatus = schedule_at ? "scheduled" : "pending";

    await pool.query(
        `INSERT INTO sms_fast2sms_campaigns
         (campaign_id, branch_id, name, template_id, template_name, dlt_message_id, message_body,
          route, sender_id, variables_values, audience_json, status, schedule_at,
          total_count, sent_count, failed_count, create_by, modify_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
        [
            campaign_id,
            branch_id,
            name,
            template.template_id,
            template.name,
            template.dlt_message_id || null,
            template.message_body || null,
            route,
            sender_id,
            variables_values || null,
            body.audience ? JSON.stringify(body.audience) : null,
            initialStatus,
            schedule_at,
            recipients.length,
            username,
            username,
        ]
    );

    const messageValues = [];
    const messageParams = [];
    for (const recipient of recipients) {
        messageValues.push("(?, ?, ?, ?, ?, ?, 'pending')");
        messageParams.push(
            newShortId("smm"),
            campaign_id,
            branch_id,
            recipient.mobile,
            recipient.name || null,
            recipient.username || null
        );
    }

    const CHUNK = 200;
    for (let i = 0; i < messageValues.length; i += CHUNK) {
        const sliceValues = messageValues.slice(i, i + CHUNK);
        const start = i * 6;
        const end = Math.min(messageParams.length, (i + CHUNK) * 6);
        await pool.query(
            `INSERT INTO sms_fast2sms_campaign_messages
             (message_id, campaign_id, branch_id, mobile, name, username, status)
             VALUES ${sliceValues.join(",")}`,
            messageParams.slice(start, end)
        );
    }

    if (!schedule_at) {
        setImmediate(() => {
            processCampaign(branch_id, campaign_id).catch((err) => {
                console.error("SMS campaign process error:", campaign_id, err);
            });
        });
    }

    return getCampaignDetails(branch_id, campaign_id);
}

const SEND_BATCH_SIZE = 40;

export async function processCampaign(branch_id, campaign_id) {
    const campaign = await getCampaignDetails(branch_id, campaign_id);
    const status = String(campaign.status || "").toLowerCase();
    if (status === "complete" || status === "cancelled") return campaign;
    if (status === "scheduled" && campaign.schedule_at) {
        const when = new Date(String(campaign.schedule_at).replace(" ", "T"));
        if (!Number.isNaN(when.getTime()) && when.getTime() > Date.now()) {
            return campaign;
        }
    }

    const config = await getFast2SmsConfigForSend(branch_id);
    if (!config) {
        await pool.query(
            `UPDATE sms_fast2sms_campaigns
             SET status = 'failed', error_message = ?, modify_date = CURRENT_TIMESTAMP
             WHERE campaign_id = ? AND branch_id = ?`,
            ["Fast2SMS is not configured", campaign_id, branch_id]
        );
        return getCampaignDetails(branch_id, campaign_id);
    }

    await pool.query(
        `UPDATE sms_fast2sms_campaigns
         SET status = 'processing', modify_date = CURRENT_TIMESTAMP
         WHERE campaign_id = ? AND branch_id = ?`,
        [campaign_id, branch_id]
    );

    const [pending] = await pool.query(
        `SELECT message_id, mobile FROM sms_fast2sms_campaign_messages
         WHERE campaign_id = ? AND branch_id = ? AND status = 'pending'
         ORDER BY id ASC`,
        [campaign_id, branch_id]
    );

    let sent = Number(campaign.sent_count) || 0;
    let failed = Number(campaign.failed_count) || 0;
    const route = normalizeFast2SmsRoute(campaign.route || config.route);
    const senderId = campaign.sender_id || config.sender_id;
    const messagePayload =
        route === "dlt" || route === "otp"
            ? campaign.dlt_message_id
            : campaign.message_body;

    for (let i = 0; i < pending.length; i += SEND_BATCH_SIZE) {
        const batch = pending.slice(i, i + SEND_BATCH_SIZE);
        const numbers = batch.map((r) => r.mobile);
        try {
            const result = await sendFast2Sms({
                authToken: config.auth_token,
                route,
                numbers,
                senderId,
                message: messagePayload,
                variablesValues: campaign.variables_values,
                entityId: config.entity_id,
            });

            const ids = batch.map((r) => r.message_id);
            await pool.query(
                `UPDATE sms_fast2sms_campaign_messages
                 SET status = 'sent',
                     provider_request_id = ?,
                     sent_at = CURRENT_TIMESTAMP,
                     modify_date = CURRENT_TIMESTAMP
                 WHERE message_id IN (${ids.map(() => "?").join(",")})`,
                [result.request_id || null, ...ids]
            );
            sent += batch.length;
        } catch (error) {
            const ids = batch.map((r) => r.message_id);
            const errMsg = error.message || "Send failed";
            await pool.query(
                `UPDATE sms_fast2sms_campaign_messages
                 SET status = 'failed',
                     error_message = ?,
                     modify_date = CURRENT_TIMESTAMP
                 WHERE message_id IN (${ids.map(() => "?").join(",")})`,
                [errMsg, ...ids]
            );
            failed += batch.length;
        }

        await pool.query(
            `UPDATE sms_fast2sms_campaigns
             SET sent_count = ?, failed_count = ?, modify_date = CURRENT_TIMESTAMP
             WHERE campaign_id = ? AND branch_id = ?`,
            [sent, failed, campaign_id, branch_id]
        );
    }

    await pool.query(
        `UPDATE sms_fast2sms_campaigns
         SET status = 'complete', sent_count = ?, failed_count = ?, modify_date = CURRENT_TIMESTAMP
         WHERE campaign_id = ? AND branch_id = ?`,
        [sent, failed, campaign_id, branch_id]
    );

    return getCampaignDetails(branch_id, campaign_id);
}

export { resolveSmsCampaignRecipients };
