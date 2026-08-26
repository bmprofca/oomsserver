import express from "express";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { UNIQUE_RANDOM_STRING } from "../helpers/function.js";
import { encrypt, decrypt } from "../utils/smtpEncryption.js";
import {
    SMS_CHANNELS,
    normalizeSmsChannel,
    smsChannelLabel,
} from "../helpers/smsChannel.js";
import { normalizeFast2SmsRoute, maskFast2SmsAuthToken } from "../helpers/fast2sms.js";
import * as fast2smsService from "../services/smsFast2smsService.js";

const router = express.Router();

function httpError(res, error, fallbackMessage) {
    const status = error?.status || 500;
    if (error?.payload) {
        return res.status(status).json(error.payload);
    }
    return res.status(status).json({
        success: false,
        message: error?.message || fallbackMessage,
    });
}

function usernameFromReq(req) {
    return req.headers["username"] || req.headers["Username"] || "";
}

function serializeFast2SmsConfig(row, { includeToken = false } = {}) {
    if (!row) return null;
    const authToken = row.auth_token_encrypted ? decrypt(row.auth_token_encrypted) : "";
    return {
        config_id: row.config_id,
        branch_id: row.branch_id,
        sender_id: row.sender_id || "",
        entity_id: row.entity_id || "",
        route: normalizeFast2SmsRoute(row.route),
        status: row.status || "active",
        configured: Boolean(authToken),
        auth_token_masked: maskFast2SmsAuthToken(authToken),
        auth_token: includeToken ? authToken : undefined,
        modify_date: row.modify_date || null,
    };
}

async function getFast2SmsConfigRow(branch_id) {
    const [rows] = await pool.query(
        `SELECT config_id, branch_id, auth_token_encrypted, sender_id, entity_id, route, status, modify_date
         FROM sms_fast2sms_configs
         WHERE branch_id = ?
         LIMIT 1`,
        [branch_id]
    );
    return rows[0] || null;
}

router.get("/channel", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const [rows] = await pool.query(
            `SELECT branch_id, sms_channel
             FROM branch_list
             WHERE branch_id = ?
               AND is_deleted = '0'
             LIMIT 1`,
            [branch_id]
        );

        if (!rows.length) {
            return res.status(404).json({
                success: false,
                message: "Branch not found",
            });
        }

        const channel = normalizeSmsChannel(rows[0].sms_channel);
        return res.status(200).json({
            success: true,
            message: "SMS channel retrieved successfully",
            data: {
                channel,
                channel_label: smsChannelLabel(channel),
            },
        });
    } catch (error) {
        console.error("GET SMS CHANNEL ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch SMS channel",
        });
    }
});

router.put("/channel", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = usernameFromReq(req);
        const { channel } = req.body || {};

        if (channel == null || String(channel).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "channel is required",
            });
        }

        const channelValue = normalizeSmsChannel(channel);
        if (!SMS_CHANNELS.includes(channelValue)) {
            return res.status(400).json({
                success: false,
                message: "channel must be one of: disabled, fast2sms",
            });
        }

        const [result] = await pool.query(
            `UPDATE branch_list
             SET sms_channel = ?, modify_by = ?, modify_date = CURRENT_TIMESTAMP
             WHERE branch_id = ?
               AND is_deleted = '0'`,
            [channelValue, username, branch_id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: "Branch not found",
            });
        }

        return res.status(200).json({
            success: true,
            message: "SMS channel updated successfully",
            data: {
                branch_id,
                channel: channelValue,
                channel_label: smsChannelLabel(channelValue),
            },
        });
    } catch (error) {
        console.error("PUT SMS CHANNEL ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update SMS channel",
        });
    }
});

router.get("/fast2sms/config", auth, validateBranch, async (req, res) => {
    try {
        const row = await getFast2SmsConfigRow(req.branch_id);
        return res.status(200).json({
            success: true,
            message: row
                ? "Fast2SMS config retrieved successfully"
                : "Fast2SMS is not configured",
            data: serializeFast2SmsConfig(row, { includeToken: true }) || {
                configured: false,
                sender_id: "",
                entity_id: "",
                route: "dlt",
                auth_token: "",
                auth_token_masked: "",
            },
        });
    } catch (error) {
        console.error("GET FAST2SMS CONFIG ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch Fast2SMS config",
        });
    }
});

router.put("/fast2sms/config", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = usernameFromReq(req);
        const { auth_token, sender_id, entity_id, route } = req.body || {};

        const tokenValue = String(auth_token || "").trim();
        const senderId = String(sender_id || "").trim().toUpperCase();
        const entityId = String(entity_id || "").trim();
        const resolvedRoute = normalizeFast2SmsRoute(route);

        const existing = await getFast2SmsConfigRow(branch_id);
        if (!tokenValue && !existing) {
            return res.status(400).json({
                success: false,
                message: "auth_token is required",
            });
        }

        const encryptedToken = tokenValue
            ? encrypt(tokenValue)
            : existing.auth_token_encrypted;

        if (existing) {
            await pool.query(
                `UPDATE sms_fast2sms_configs
                 SET auth_token_encrypted = ?,
                     sender_id = ?,
                     entity_id = ?,
                     route = ?,
                     status = 'active',
                     modify_by = ?,
                     modify_date = CURRENT_TIMESTAMP
                 WHERE branch_id = ?`,
                [encryptedToken, senderId || null, entityId || null, resolvedRoute, username, branch_id]
            );
        } else {
            const config_id = await UNIQUE_RANDOM_STRING("sms_fast2sms_configs", "config_id", {
                prefix: "f2s",
            });
            await pool.query(
                `INSERT INTO sms_fast2sms_configs
                 (config_id, branch_id, auth_token_encrypted, sender_id, entity_id, route, status, create_by, modify_by, create_date, modify_date)
                 VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                [config_id, branch_id, encryptedToken, senderId || null, entityId || null, resolvedRoute, username, username]
            );
        }

        const saved = await getFast2SmsConfigRow(branch_id);
        return res.status(200).json({
            success: true,
            message: "Fast2SMS config saved successfully",
            data: serializeFast2SmsConfig(saved, { includeToken: true }),
        });
    } catch (error) {
        console.error("PUT FAST2SMS CONFIG ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to save Fast2SMS config",
        });
    }
});

/* ── Templates ─────────────────────────────────────────────── */

router.get("/fast2sms/template/list", auth, validateBranch, async (req, res) => {
    try {
        const result = await fast2smsService.listTemplates(req.branch_id, {
            page_no: req.query.page_no,
            limit: req.query.limit,
            search: req.query.search,
            status: req.query.status,
        });
        return res.status(200).json({
            success: true,
            message: "Templates retrieved successfully",
            data: result.data,
            pagination: result.pagination,
        });
    } catch (error) {
        console.error("GET FAST2SMS TEMPLATES ERROR:", error);
        return httpError(res, error, "Failed to list templates");
    }
});

router.post("/fast2sms/template/create", auth, validateBranch, async (req, res) => {
    try {
        const data = await fast2smsService.createTemplate(
            req.branch_id,
            usernameFromReq(req),
            req.body || {}
        );
        return res.status(200).json({
            success: true,
            message: "Template created successfully",
            data,
        });
    } catch (error) {
        console.error("POST FAST2SMS TEMPLATE ERROR:", error);
        return httpError(res, error, "Failed to create template");
    }
});

router.put("/fast2sms/template/update", auth, validateBranch, async (req, res) => {
    try {
        const data = await fast2smsService.updateTemplate(
            req.branch_id,
            usernameFromReq(req),
            req.body || {}
        );
        return res.status(200).json({
            success: true,
            message: "Template updated successfully",
            data,
        });
    } catch (error) {
        console.error("PUT FAST2SMS TEMPLATE ERROR:", error);
        return httpError(res, error, "Failed to update template");
    }
});

/* ── Template mapping ──────────────────────────────────────── */

router.get("/fast2sms/template-map-list", auth, validateBranch, async (req, res) => {
    try {
        const data = await fast2smsService.listTemplateMaps(req.branch_id);
        return res.status(200).json({
            success: true,
            message: "Template mappings retrieved successfully",
            data,
        });
    } catch (error) {
        console.error("GET FAST2SMS TEMPLATE MAP ERROR:", error);
        return httpError(res, error, "Failed to list template mappings");
    }
});

router.put("/fast2sms/template-map/set", auth, validateBranch, async (req, res) => {
    try {
        const data = await fast2smsService.setTemplateMap(
            req.branch_id,
            usernameFromReq(req),
            req.body || {}
        );
        return res.status(200).json({
            success: true,
            message: "Template mapping saved successfully",
            data,
        });
    } catch (error) {
        console.error("PUT FAST2SMS TEMPLATE MAP SET ERROR:", error);
        return httpError(res, error, "Failed to set template mapping");
    }
});

router.put("/fast2sms/template-map/unset", auth, validateBranch, async (req, res) => {
    try {
        const data = await fast2smsService.unsetTemplateMap(
            req.branch_id,
            usernameFromReq(req),
            req.body || {}
        );
        return res.status(200).json({
            success: true,
            message: "Template mapping removed successfully",
            data,
        });
    } catch (error) {
        console.error("PUT FAST2SMS TEMPLATE MAP UNSET ERROR:", error);
        return httpError(res, error, "Failed to unset template mapping");
    }
});

/* ── Campaigns ─────────────────────────────────────────────── */

router.post("/fast2sms/campaign/resolve-recipients", auth, validateBranch, async (req, res) => {
    try {
        const audience = req.body && typeof req.body === "object" ? req.body : {};
        const resolved = await fast2smsService.resolveSmsCampaignRecipients(
            req.branch_id,
            audience
        );
        if (!resolved.ok) {
            return res.status(resolved.status).json(resolved.data);
        }
        return res.status(200).json({
            success: true,
            count: resolved.count,
            data: resolved.data,
            meta: resolved.meta,
        });
    } catch (error) {
        console.error("POST FAST2SMS RESOLVE RECIPIENTS ERROR:", error);
        return httpError(res, error, "Failed to resolve recipients");
    }
});

router.post("/fast2sms/campaign/create", auth, validateBranch, async (req, res) => {
    try {
        const data = await fast2smsService.createCampaign(
            req.branch_id,
            usernameFromReq(req),
            req.body || {}
        );
        return res.status(200).json({
            success: true,
            message: "Campaign created successfully",
            data,
        });
    } catch (error) {
        console.error("POST FAST2SMS CAMPAIGN CREATE ERROR:", error);
        return httpError(res, error, "Failed to create campaign");
    }
});

router.get("/fast2sms/campaign/list", auth, validateBranch, async (req, res) => {
    try {
        const result = await fast2smsService.listCampaigns(req.branch_id, {
            page_no: req.query.page_no,
            limit: req.query.limit,
            status: req.query.status,
        });
        return res.status(200).json({
            success: true,
            message: "Campaigns retrieved successfully",
            data: result.data,
            pagination: result.pagination,
        });
    } catch (error) {
        console.error("GET FAST2SMS CAMPAIGN LIST ERROR:", error);
        return httpError(res, error, "Failed to list campaigns");
    }
});

router.get("/fast2sms/campaign/details", auth, validateBranch, async (req, res) => {
    try {
        const campaign_id = String(req.query.campaign_id || "").trim();
        if (!campaign_id) {
            return res.status(400).json({ success: false, message: "campaign_id is required" });
        }
        const data = await fast2smsService.getCampaignDetails(req.branch_id, campaign_id, {
            includePreview: true,
        });
        return res.status(200).json({
            success: true,
            message: "Campaign details retrieved successfully",
            data,
        });
    } catch (error) {
        console.error("GET FAST2SMS CAMPAIGN DETAILS ERROR:", error);
        return httpError(res, error, "Failed to fetch campaign details");
    }
});

router.get("/fast2sms/campaign/message-detail", auth, validateBranch, async (req, res) => {
    try {
        const campaign_id = String(req.query.campaign_id || "").trim();
        const message_id = String(req.query.message_id || "").trim();
        if (!campaign_id) {
            return res.status(400).json({ success: false, message: "campaign_id is required" });
        }
        if (!message_id) {
            return res.status(400).json({ success: false, message: "message_id is required" });
        }
        const data = await fast2smsService.getCampaignMessageDetail(
            req.branch_id,
            campaign_id,
            message_id
        );
        return res.status(200).json({
            success: true,
            message: "Message details retrieved successfully",
            data,
        });
    } catch (error) {
        console.error("GET FAST2SMS CAMPAIGN MESSAGE DETAIL ERROR:", error);
        return httpError(res, error, "Failed to fetch message details");
    }
});

router.post("/fast2sms/campaign/message-retry", auth, validateBranch, async (req, res) => {
    try {
        const campaign_id = String(req.body?.campaign_id || "").trim();
        const message_id = String(req.body?.message_id || "").trim();
        if (!campaign_id) {
            return res.status(400).json({ success: false, message: "campaign_id is required" });
        }
        if (!message_id) {
            return res.status(400).json({ success: false, message: "message_id is required" });
        }
        const data = await fast2smsService.retryCampaignMessage(
            req.branch_id,
            campaign_id,
            message_id
        );
        return res.status(200).json({
            success: true,
            message: "Message resent successfully",
            data,
        });
    } catch (error) {
        console.error("POST FAST2SMS CAMPAIGN MESSAGE RETRY ERROR:", error);
        return httpError(res, error, "Failed to retry message");
    }
});

router.get("/fast2sms/campaign/messages", auth, validateBranch, async (req, res) => {
    try {
        const campaign_id = String(req.query.campaign_id || "").trim();
        if (!campaign_id) {
            return res.status(400).json({ success: false, message: "campaign_id is required" });
        }
        const result = await fast2smsService.listCampaignMessages(req.branch_id, campaign_id, {
            page_no: req.query.page_no,
            limit: req.query.limit,
            status: req.query.status,
        });
        return res.status(200).json({
            success: true,
            message: "Campaign messages retrieved successfully",
            data: result.data,
            pagination: result.pagination,
        });
    } catch (error) {
        console.error("GET FAST2SMS CAMPAIGN MESSAGES ERROR:", error);
        return httpError(res, error, "Failed to list campaign messages");
    }
});

router.post("/fast2sms/campaign/delete", auth, validateBranch, async (req, res) => {
    try {
        const campaign_id = String(req.body?.campaign_id || "").trim();
        if (!campaign_id) {
            return res.status(400).json({ success: false, message: "campaign_id is required" });
        }
        const data = await fast2smsService.deleteCampaign(
            req.branch_id,
            usernameFromReq(req),
            campaign_id
        );
        return res.status(200).json({
            success: true,
            message: "Campaign deleted successfully",
            data,
        });
    } catch (error) {
        console.error("POST FAST2SMS CAMPAIGN DELETE ERROR:", error);
        return httpError(res, error, "Failed to delete campaign");
    }
});

router.post("/fast2sms/campaign/process", auth, validateBranch, async (req, res) => {
    try {
        const campaign_id = String(req.body?.campaign_id || "").trim();
        if (!campaign_id) {
            return res.status(400).json({ success: false, message: "campaign_id is required" });
        }
        const data = await fast2smsService.processCampaign(req.branch_id, campaign_id);
        return res.status(200).json({
            success: true,
            message: "Campaign processed",
            data,
        });
    } catch (error) {
        console.error("POST FAST2SMS CAMPAIGN PROCESS ERROR:", error);
        return httpError(res, error, "Failed to process campaign");
    }
});

export default router;
