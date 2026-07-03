import express from "express";
import axios from "axios";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { TEMPLATELIST } from "../utils/WhatsAppTemplates.js";
import {
    WHATSAPPWEB_BASE_URL,
    generateWhatsappWebSessionId,
    clearBranchWhatsappWebSession,
    getBranchWhatsappWebSession,
    handleWhatsappWebAxiosError,
    proxyWhatsappWebResponse,
    resolveBranchSessionId,
    setBranchWhatsappWebSession,
    whatsappWebRequest,
} from "../helpers/whatsappWeb.js";
import {
    createTemplate as createWhatsappWebTemplate,
    updateTemplate as updateWhatsappWebTemplate,
    listTemplates as listWhatsappWebTemplates,
    getTemplateDetails as getWhatsappWebTemplateDetails,
} from "../services/whatsappWebTemplateService.js";
import {
    setStaticTemplate as setWhatsappWebStaticTemplate,
    unsetStaticTemplate as unsetWhatsappWebStaticTemplate,
    listBranchTemplates as listWhatsappWebStaticTemplates,
} from "../services/whatsappWebTemplateMappingService.js";
import { sendWhatsappWebMessages } from "../services/whatsappWebSendMessageService.js";
import {
    listTemplatesByType,
    listBranchMappings,
    setTemplateMapping,
    unsetTemplateMapping,
    getActiveMapping,
} from "../services/wpSystemTemplateService.js";

const ONECHATTING_BASE_URL = process.env.ONECHATTING_BASE_URL || "https://server.onechatting.com";
const ONECHATTING_CHAT_LIST_URL = `${ONECHATTING_BASE_URL}/developer/message/chat-list`;
const ONECHATTING_CHAT_HISTORY_URL = `${ONECHATTING_BASE_URL}/developer/message/chat-history`;
const ONECHATTING_MARK_AS_READ_URL = `${ONECHATTING_BASE_URL}/developer/message/mark-as-read`;
const ONECHATTING_SEND_TEXT_URL = `${ONECHATTING_BASE_URL}/developer/message/send-text-message`;
const ONECHATTING_SEND_IMAGE_URL = `${ONECHATTING_BASE_URL}/developer/message/send-image-message`;
const ONECHATTING_SEND_VIDEO_URL = `${ONECHATTING_BASE_URL}/developer/message/send-video-message`;
const ONECHATTING_SEND_DOCUMENT_URL = `${ONECHATTING_BASE_URL}/developer/message/send-document-message`;
const ONECHATTING_SEND_AUDIO_URL = `${ONECHATTING_BASE_URL}/developer/message/send-audio-message`;
const ONECHATTING_SEND_TEMPLATE_URL = `${ONECHATTING_BASE_URL}/developer/message/send-template`;
const ONECHATTING_TEMPLATE_LIST_URL = `${ONECHATTING_BASE_URL}/developer/template/template-list`;
const ONECHATTING_TEMPLATE_DETAILS_URL = `${ONECHATTING_BASE_URL}/developer/template/template-details`;

const router = express.Router();

import { checkSubscription, requirePlan } from "../middleware/auth.js";
router.use(checkSubscription, requirePlan(['BusinessPro']));

async function resolveOneChattingToken(username, branch_id) {
    const [rows] = await pool.query(
        `SELECT onechatting_token, onechatting_enabled
         FROM branch_mapping
         WHERE username = ?
           AND branch_id = ?
           AND is_deleted = '0'
         LIMIT 1`,
        [username, branch_id]
    );

    if (!rows.length) {
        return {
            ok: false,
            status: 404,
            data: { success: false, message: "Branch mapping not found" },
        };
    }

    const mapping = rows[0];
    if (mapping.onechatting_enabled !== "1" || !mapping.onechatting_token) {
        return {
            ok: false,
            status: 400,
            data: {
                success: false,
                message: "OneChatting developer token is not configured or enabled",
            },
        };
    }

    return { ok: true, token: mapping.onechatting_token };
}

async function resolveOneChattingBranchDeveloperToken(branch_id) {
    const [rows] = await pool.query(
        `SELECT onechatting_developer_token
         FROM branch_list
         WHERE branch_id = ?
           AND is_deleted = '0'
         LIMIT 1`,
        [branch_id]
    );

    if (!rows.length) {
        return {
            ok: false,
            status: 404,
            data: { success: false, message: "Branch not found" },
        };
    }

    const developer_token = rows[0].onechatting_developer_token
        ? String(rows[0].onechatting_developer_token).trim()
        : "";

    if (!developer_token) {
        return {
            ok: false,
            status: 400,
            data: {
                success: false,
                message: "OneChatting developer token is not configured for this branch",
            },
        };
    }

    return { ok: true, developer_token };
}

function handleOneChattingAxiosError(error, res, fallbackMessage) {
    if (error.response) {
        const status = error.response.status === 401 ? 400 : error.response.status;
        return res.status(status).json(error.response.data);
    }

    console.error(fallbackMessage, error);
    return res.status(500).json({
        success: false,
        message: fallbackMessage,
    });
}

async function proxyOneChattingPost(url, token, body, res) {
    const response = await axios.post(url, body, {
        headers: {
            token,
            "Content-Type": "application/json",
        },
    });

    if (response.status === 401) {
        return res.status(400).json(response.data);
    }

    return res.status(response.status).json(response.data);
}

async function proxyOneChattingGet(url, token, params, res) {
    const response = await axios.get(url, {
        headers: {
            token,
        },
        params,
    });

    if (response.status === 401) {
        return res.status(400).json(response.data);
    }

    return res.status(response.status).json(response.data);
}

async function proxyOneChattingTemplateGet(url, developer_token, params, res) {
    const response = await axios.get(url, {
        headers: {
            token: developer_token,
        },
        params: {
            ...params,
            developer_token,
        },
    });

    if (response.status === 401) {
        return res.status(400).json(response.data);
    }

    return res.status(response.status).json(response.data);
}

const VALID_WHATSAPP_CHANNELS = ["disabled", "ooms system", "ooms web", "onechatting"];

function parseTemplateComponent(component) {
    if (component == null) {
        return { ok: false, message: "component is required" };
    }

    let parsed = component;
    if (typeof component === "string") {
        try {
            parsed = JSON.parse(component);
        } catch {
            return { ok: false, message: "component must be valid JSON" };
        }
    }

    if (typeof parsed !== "object" || parsed === null) {
        return { ok: false, message: "component must be a JSON object or array" };
    }

    return { ok: true, value: parsed };
}

function parseStoredComponent(value) {
    if (value == null) {
        return null;
    }

    if (typeof value === "object") {
        return value;
    }

    try {
        return JSON.parse(String(value));
    } catch {
        return null;
    }
}

router.get("/channel", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;

        const [rows] = await pool.query(
            `SELECT branch_id, whatsapp_channel
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

        return res.status(200).json({
            success: true,
            message: "WhatsApp channel retrieved successfully",
            data: {
                channel: rows[0].whatsapp_channel,
            },
        });
    } catch (error) {
        console.error("GET WHATSAPP CHANNEL ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch WhatsApp channel",
        });
    }
});

router.put("/channel", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.headers["username"] || req.headers["Username"] || "";
        const { channel } = req.body || {};

        if (channel == null || String(channel).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "channel is required",
            });
        }

        const channelValue = String(channel).trim();

        if (!VALID_WHATSAPP_CHANNELS.includes(channelValue)) {
            return res.status(400).json({
                success: false,
                message: "channel must be one of: disabled, ooms system, ooms web, onechatting",
            });
        }

        const [result] = await pool.query(
            `UPDATE branch_list
             SET whatsapp_channel = ?, modify_by = ?, modify_date = CURRENT_TIMESTAMP
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
            message: "WhatsApp channel updated successfully",
            data: {
                branch_id,
                channel: channelValue,
            },
        });
    } catch (error) {
        console.error("PUT WHATSAPP CHANNEL ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update WhatsApp channel",
        });
    }
});

// ENDPOINTS FOR ONECHATTING
router.get("/onechatting/developer-tokens", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const page_no = Math.max(1, Number(req.query.page_no) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
        const offset = (page_no - 1) * limit;
        const search = req.query.search ? String(req.query.search).trim() : "";

        const filterParams = [branch_id];
        let searchSql = "";

        if (search) {
            const sp = `%${search}%`;
            searchSql = ` AND (
                bm.username LIKE ?
                OR bm.designation LIKE ?
                OR bm.onechatting_token LIKE ?
                OR p.name LIKE ?
                OR p.email LIKE ?
                OR p.mobile LIKE ?
                OR p.pan_number LIKE ?
            )`;
            filterParams.push(sp, sp, sp, sp, sp, sp, sp);
        }

        const baseFrom = `
            FROM branch_mapping bm
            LEFT JOIN profile p ON p.username = bm.username
                AND p.status = '1'
                AND p.id = (
                    SELECT MAX(p2.id)
                    FROM profile p2
                    WHERE p2.username = bm.username
                      AND p2.status = '1'
                )
            WHERE bm.branch_id = ?
              AND bm.is_deleted = '0'
              AND bm.type IN ('admin', 'staff')
            ${searchSql}
        `;

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total ${baseFrom}`,
            filterParams
        );

        const [rows] = await pool.query(
            `SELECT
                bm.map_id,
                bm.username,
                bm.designation,
                bm.type,
                bm.onechatting_enabled,
                bm.onechatting_token,
                p.name,
                p.email,
                p.mobile,
                p.country_code,
                p.pan_number,
                p.city,
                p.state
             ${baseFrom}
             ORDER BY FIELD(bm.type, 'admin', 'staff'), bm.id DESC
             LIMIT ? OFFSET ?`,
            [...filterParams, limit, offset]
        );

        const data = rows.map((row) => {
            const onechatting_enabled = row.onechatting_enabled === "1";
            const item = {
                map_id: row.map_id,
                username: row.username,
                designation: row.designation,
                type: row.type,
                onechatting_enabled,
                profile: {
                    name: row.name,
                    email: row.email,
                    mobile: row.mobile,
                    country_code: row.country_code,
                    pan_number: row.pan_number,
                    city: row.city,
                    state: row.state,
                },
            };

            if (onechatting_enabled) {
                item.developer_token = row.onechatting_token;
            }

            return item;
        });

        const totalCount = Number(total) || 0;

        return res.status(200).json({
            success: true,
            message: "Developer tokens retrieved successfully",
            filters: {
                search: search || null,
            },
            data,
            pagination: {
                page_no,
                limit,
                total: totalCount,
                total_pages: Math.ceil(totalCount / limit) || 0,
                has_more: offset + rows.length < totalCount,
            },
        });
    } catch (error) {
        console.error("GET DEVELOPER TOKENS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch developer tokens",
        });
    }
});

router.put("/onechatting/developer-token", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const modifyBy = req.headers["username"] || req.headers["Username"] || "";
        const { map_id, developer_token, enabled } = req.body || {};

        if (!map_id || String(map_id).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "map_id is required",
            });
        }

        if (enabled !== true && enabled !== false) {
            return res.status(400).json({
                success: false,
                message: "enabled must be true or false",
            });
        }

        const mapId = String(map_id).trim();

        if (enabled) {
            if (developer_token == null || String(developer_token).trim() === "") {
                return res.status(400).json({
                    success: false,
                    message: "developer_token is required when enabled is true",
                });
            }
        }

        const [existing] = await pool.query(
            `SELECT map_id, username, designation, type, onechatting_enabled, onechatting_token
             FROM branch_mapping
             WHERE map_id = ?
               AND branch_id = ?
               AND is_deleted = '0'
             LIMIT 1`,
            [mapId, branch_id]
        );

        if (!existing.length) {
            return res.status(404).json({
                success: false,
                message: "Mapping not found",
            });
        }

        const enabledValue = enabled ? "1" : "0";
        const tokenValue = enabled ? String(developer_token).trim() : null;

        await pool.query(
            `UPDATE branch_mapping
             SET onechatting_enabled = ?,
                 onechatting_token = ?,
                 modify_by = ?,
                 modify_date = CURRENT_TIMESTAMP
             WHERE map_id = ?
               AND branch_id = ?
               AND is_deleted = '0'`,
            [enabledValue, tokenValue, modifyBy, mapId, branch_id]
        );

        const row = existing[0];
        const response = {
            map_id: row.map_id,
            username: row.username,
            designation: row.designation,
            type: row.type,
            onechatting_enabled: enabled,
        };

        if (enabled) {
            response.developer_token = tokenValue;
        }

        return res.status(200).json({
            success: true,
            message: enabled
                ? "Developer token enabled successfully"
                : "Developer token disabled successfully",
            data: response,
        });
    } catch (error) {
        console.error("PUT DEVELOPER TOKEN ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update developer token",
        });
    }
});

router.get("/onechatting/chat-list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.headers["username"] || req.headers["Username"] || "";
        const page_no = Math.max(1, Number(req.query.page_no) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
        const search = req.query.search ? String(req.query.search).trim() : "";

        const [rows] = await pool.query(
            `SELECT onechatting_token, onechatting_enabled
             FROM branch_mapping
             WHERE username = ?
               AND branch_id = ?
               AND is_deleted = '0'
             LIMIT 1`,
            [username, branch_id]
        );

        if (!rows.length) {
            return res.status(404).json({
                success: false,
                message: "Branch mapping not found",
            });
        }

        const mapping = rows[0];
        if (mapping.onechatting_enabled !== "1" || !mapping.onechatting_token) {
            return res.status(400).json({
                success: false,
                message: "OneChatting developer token is not configured or enabled",
            });
        }

        const params = {
            page_no,
            limit,
        };

        if (search) {
            params.search = search;
        }

        const response = await axios.get(ONECHATTING_CHAT_LIST_URL, {
            headers: {
                token: mapping.onechatting_token,
            },
            params,
        });

        if (response.status === 401) {
            return res.status(400).json(response.data);
        }

        return res.status(response.status).json({
            ...response.data,
            developer_token: mapping.onechatting_token,
        });
    } catch (error) {
        if (error.response) {
            const status = error.response.status === 401 ? 400 : error.response.status;
            return res.status(status).json(error.response.data);
        }

        console.error("GET ONECHATTING CHAT LIST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch chat list",
        });
    }
});

router.get("/onechatting/chat-history", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.headers["username"] || req.headers["Username"] || "";
        const number = req.query.number ? String(req.query.number).trim() : "";
        const last_id =
            req.query.last_id != null && String(req.query.last_id).trim() !== ""
                ? String(req.query.last_id).trim()
                : "0";
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 100));

        if (!number) {
            return res.status(400).json({
                success: false,
                message: "number is required",
            });
        }

        const [rows] = await pool.query(
            `SELECT onechatting_token, onechatting_enabled
             FROM branch_mapping
             WHERE username = ?
               AND branch_id = ?
               AND is_deleted = '0'
             LIMIT 1`,
            [username, branch_id]
        );

        if (!rows.length) {
            return res.status(404).json({
                success: false,
                message: "Branch mapping not found",
            });
        }

        const mapping = rows[0];
        if (mapping.onechatting_enabled !== "1" || !mapping.onechatting_token) {
            return res.status(400).json({
                success: false,
                message: "OneChatting developer token is not configured or enabled",
            });
        }

        const response = await axios.get(ONECHATTING_CHAT_HISTORY_URL, {
            headers: {
                token: mapping.onechatting_token,
            },
            params: {
                number,
                last_id,
                limit,
            },
        });

        if (response.status === 401) {
            return res.status(400).json(response.data);
        }

        const body = response.data || {};
        const assignedToken = body.assigned;
        let assigned = false;

        if (assignedToken) {
            if (assignedToken === mapping.onechatting_token) {
                assigned = { is_me: true };
            } else {
                const [assigneeRows] = await pool.query(
                    `SELECT bm.username, p.name, p.email, p.mobile
                     FROM branch_mapping bm
                     LEFT JOIN profile p ON p.username = bm.username
                         AND p.status = '1'
                         AND p.id = (
                             SELECT MAX(p2.id)
                             FROM profile p2
                             WHERE p2.username = bm.username
                               AND p2.status = '1'
                         )
                     WHERE bm.branch_id = ?
                       AND bm.onechatting_token = ?
                       AND bm.is_deleted = '0'
                     LIMIT 1`,
                    [branch_id, assignedToken]
                );

                if (assigneeRows.length) {
                    const assignee = assigneeRows[0];
                    assigned = {
                        is_me: false,
                        staff: {
                            username: assignee.username,
                            name: assignee.name,
                            mobile: assignee.mobile,
                            email: assignee.email,
                        },
                    };
                }
            }
        }

        return res.status(response.status).json({
            ...body,
            assigned,
            developer_token: mapping.onechatting_token,
        });
    } catch (error) {
        if (error.response) {
            const status = error.response.status === 401 ? 400 : error.response.status;
            return res.status(status).json(error.response.data);
        }

        console.error("GET ONECHATTING CHAT HISTORY ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch chat history",
        });
    }
});

router.post("/onechatting/mark-as-read", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.headers["username"] || req.headers["Username"] || "";
        const resolved = await resolveOneChattingToken(username, branch_id);
        if (!resolved.ok) {
            return res.status(resolved.status).json(resolved.data);
        }

        return await proxyOneChattingPost(
            ONECHATTING_MARK_AS_READ_URL,
            resolved.token,
            req.body,
            res
        );
    } catch (error) {
        return handleOneChattingAxiosError(error, res, "Failed to mark as read");
    }
});

router.post("/onechatting/send-text-message", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.headers["username"] || req.headers["Username"] || "";
        const resolved = await resolveOneChattingToken(username, branch_id);
        if (!resolved.ok) {
            return res.status(resolved.status).json(resolved.data);
        }

        return await proxyOneChattingPost(
            ONECHATTING_SEND_TEXT_URL,
            resolved.token,
            req.body,
            res
        );
    } catch (error) {
        return handleOneChattingAxiosError(error, res, "Failed to send text message");
    }
});

router.post("/onechatting/send-image-message", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.headers["username"] || req.headers["Username"] || "";
        const resolved = await resolveOneChattingToken(username, branch_id);
        if (!resolved.ok) {
            return res.status(resolved.status).json(resolved.data);
        }

        return await proxyOneChattingPost(
            ONECHATTING_SEND_IMAGE_URL,
            resolved.token,
            req.body,
            res
        );
    } catch (error) {
        return handleOneChattingAxiosError(error, res, "Failed to send image message");
    }
});

router.post("/onechatting/send-video-message", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.headers["username"] || req.headers["Username"] || "";
        const resolved = await resolveOneChattingToken(username, branch_id);
        if (!resolved.ok) {
            return res.status(resolved.status).json(resolved.data);
        }

        return await proxyOneChattingPost(
            ONECHATTING_SEND_VIDEO_URL,
            resolved.token,
            req.body,
            res
        );
    } catch (error) {
        return handleOneChattingAxiosError(error, res, "Failed to send video message");
    }
});

router.post("/onechatting/send-document-message", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.headers["username"] || req.headers["Username"] || "";
        const resolved = await resolveOneChattingToken(username, branch_id);
        if (!resolved.ok) {
            return res.status(resolved.status).json(resolved.data);
        }

        return await proxyOneChattingPost(
            ONECHATTING_SEND_DOCUMENT_URL,
            resolved.token,
            req.body,
            res
        );
    } catch (error) {
        return handleOneChattingAxiosError(error, res, "Failed to send document message");
    }
});

router.post("/onechatting/send-audio-message", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.headers["username"] || req.headers["Username"] || "";
        const resolved = await resolveOneChattingToken(username, branch_id);
        if (!resolved.ok) {
            return res.status(resolved.status).json(resolved.data);
        }

        return await proxyOneChattingPost(
            ONECHATTING_SEND_AUDIO_URL,
            resolved.token,
            req.body,
            res
        );
    } catch (error) {
        return handleOneChattingAxiosError(error, res, "Failed to send audio message");
    }
});

router.post("/onechatting/send-template", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.headers["username"] || req.headers["Username"] || "";
        const resolved = await resolveOneChattingToken(username, branch_id);
        if (!resolved.ok) {
            return res.status(resolved.status).json(resolved.data);
        }

        return await proxyOneChattingPost(
            ONECHATTING_SEND_TEMPLATE_URL,
            resolved.token,
            req.body,
            res
        );
    } catch (error) {
        return handleOneChattingAxiosError(error, res, "Failed to send template message");
    }
});

router.get("/onechatting/template-list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const page_no = Math.max(1, Number(req.query.page_no) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
        const status = req.query.status != null ? String(req.query.status) : "";

        const resolved = await resolveOneChattingBranchDeveloperToken(branch_id);
        if (!resolved.ok) {
            return res.status(resolved.status).json(resolved.data);
        }

        const params = { page_no, limit };
        if (status) {
            params.status = status;
        }

        return await proxyOneChattingTemplateGet(
            ONECHATTING_TEMPLATE_LIST_URL,
            resolved.developer_token,
            params,
            res
        );
    } catch (error) {
        return handleOneChattingAxiosError(error, res, "Failed to fetch template list");
    }
});

router.get("/onechatting/template-details", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const template_id = req.query.template_id ? String(req.query.template_id).trim() : "";

        if (!template_id) {
            return res.status(400).json({
                error: "template_id is required",
            });
        }

        const resolved = await resolveOneChattingBranchDeveloperToken(branch_id);
        if (!resolved.ok) {
            return res.status(resolved.status).json(resolved.data);
        }

        return await proxyOneChattingTemplateGet(
            ONECHATTING_TEMPLATE_DETAILS_URL,
            resolved.developer_token,
            { template_id },
            res
        );
    } catch (error) {
        return handleOneChattingAxiosError(error, res, "Failed to fetch template details");
    }
});

router.get("/onechatting/template-map-list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;

        const [rows] = await pool.query(
            `SELECT map_id, template, onechatting_template_name, component, status
             FROM onechatting_template_mapping
             WHERE branch_id = ?`,
            [branch_id]
        );

        const mappingByTemplate = new Map();
        for (const row of rows) {
            const key = row.template ? String(row.template).trim() : "";
            if (key) {
                mappingByTemplate.set(key, row);
            }
        }

        const data = TEMPLATELIST.map((item) => {
            const mapping = mappingByTemplate.get(item.name);
            const isActive = mapping && Number(mapping.status) === 1;
            if (isActive) {
                return {
                    name: item.name,
                    description: item.description,
                    available_variables: item.available_variables ?? [],
                    is_set: true,
                    map_id: mapping.map_id,
                    onechatting_template_name: mapping.onechatting_template_name,
                    component: parseStoredComponent(mapping.component),
                    status: mapping.status,
                };
            }

            return {
                name: item.name,
                description: item.description,
                available_variables: item.available_variables ?? [],
                is_set: false,
                onechatting_template_name: mapping?.onechatting_template_name ?? null,
                component: mapping ? parseStoredComponent(mapping.component) : null,
                status: mapping?.status ?? 0,
            };
        });

        return res.status(200).json({
            success: true,
            message: "Template mapping list retrieved successfully",
            data,
        });
    } catch (error) {
        console.error("GET ONECHATTING TEMPLATE MAP LIST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch template mapping list",
        });
    }
});

router.put("/onechatting/template-map/set", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { name, template_name, component } = req.body || {};
        const templateName = name != null ? String(name).trim() : "";
        const onechattingTemplateName =
            template_name != null ? String(template_name).trim() : "";

        if (!templateName) {
            return res.status(400).json({
                success: false,
                message: "name is required",
            });
        }

        if (!onechattingTemplateName) {
            return res.status(400).json({
                success: false,
                message: "template_name is required",
            });
        }

        const parsedComponent = parseTemplateComponent(component);
        if (!parsedComponent.ok) {
            return res.status(400).json({
                success: false,
                message: parsedComponent.message,
            });
        }

        const componentJson = JSON.stringify(parsedComponent.value);

        const systemTemplate = TEMPLATELIST.find((item) => item.name === templateName);
        if (!systemTemplate) {
            return res.status(400).json({
                success: false,
                message: "Invalid system template name",
            });
        }

        const [existing] = await pool.query(
            `SELECT id, map_id
             FROM onechatting_template_mapping
             WHERE branch_id = ?
               AND template = ?
             LIMIT 1`,
            [branch_id, templateName]
        );

        if (existing.length) {
            await pool.query(
                `UPDATE onechatting_template_mapping
                 SET onechatting_template_name = ?,
                     component = ?,
                     status = 1
                 WHERE id = ?`,
                [onechattingTemplateName, componentJson, existing[0].id]
            );

            return res.status(200).json({
                success: true,
                message: "Template mapping set successfully",
                data: {
                    map_id: existing[0].map_id,
                    name: templateName,
                    template_name: onechattingTemplateName,
                    component: parsedComponent.value,
                    status: 1,
                },
            });
        }

        const map_id = `OTM_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;

        await pool.query(
            `INSERT INTO onechatting_template_mapping
             (map_id, branch_id, template, onechatting_template_name, component, status)
             VALUES (?, ?, ?, ?, ?, 1)`,
            [map_id, branch_id, templateName, onechattingTemplateName, componentJson]
        );

        return res.status(200).json({
            success: true,
            message: "Template mapping set successfully",
            data: {
                map_id,
                name: templateName,
                template_name: onechattingTemplateName,
                component: parsedComponent.value,
                status: 1,
            },
        });
    } catch (error) {
        console.error("PUT ONECHATTING TEMPLATE MAP SET ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to set template mapping",
        });
    }
});

router.put("/onechatting/template-map/unset", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { name } = req.body || {};
        const templateName = name != null ? String(name).trim() : "";

        if (!templateName) {
            return res.status(400).json({
                success: false,
                message: "name is required",
            });
        }

        const systemTemplate = TEMPLATELIST.find((item) => item.name === templateName);
        if (!systemTemplate) {
            return res.status(400).json({
                success: false,
                message: "Invalid system template name",
            });
        }

        const [existing] = await pool.query(
            `SELECT id, map_id, onechatting_template_name
             FROM onechatting_template_mapping
             WHERE branch_id = ?
               AND template = ?
             LIMIT 1`,
            [branch_id, templateName]
        );

        if (!existing.length) {
            return res.status(404).json({
                success: false,
                message: "Template mapping not found",
            });
        }

        await pool.query(
            `UPDATE onechatting_template_mapping
             SET status = 0
             WHERE id = ?`,
            [existing[0].id]
        );

        return res.status(200).json({
            success: true,
            message: "Template mapping unset successfully",
            data: {
                map_id: existing[0].map_id,
                name: templateName,
                template_name: existing[0].onechatting_template_name,
                status: 0,
            },
        });
    } catch (error) {
        console.error("PUT ONECHATTING TEMPLATE MAP UNSET ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to unset template mapping",
        });
    }
});


// ENDPOINTS FOR OOMS SYSTEM WHATSAPP (BUILT-IN TEMPLATES VIA ONECHATTING)

function wpSystemTemplateUsername(req) {
    return req.headers["username"] || req.headers["Username"] || null;
}

router.get("/wp-system/templates", auth, validateBranch, async (req, res) => {
    try {
        const type = req.query.type != null ? String(req.query.type).trim() : "";
        if (!type) {
            return res.status(400).json({
                success: false,
                message: "type is required",
            });
        }

        const templates = listTemplatesByType(type);
        const activeMapping = await getActiveMapping(req.branch_id, type);

        return res.status(200).json({
            success: true,
            message: "OOMS system templates fetched successfully",
            data: {
                type,
                active_template_name: activeMapping?.template_name ?? null,
                templates,
            },
        });
    } catch (error) {
        console.error("GET WP SYSTEM TEMPLATES ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error?.message || "Failed to fetch OOMS system templates",
        });
    }
});

router.get("/wp-system/template-map-list", auth, validateBranch, async (req, res) => {
    try {
        const data = await listBranchMappings(req.branch_id);
        return res.status(200).json({
            success: true,
            message: "OOMS system template mappings fetched successfully",
            data,
        });
    } catch (error) {
        console.error("GET WP SYSTEM TEMPLATE MAP LIST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch OOMS system template mappings",
        });
    }
});

router.put("/wp-system/template-map/set", auth, validateBranch, async (req, res) => {
    try {
        const { type, template_name } = req.body || {};
        const data = await setTemplateMapping({
            branch_id: req.branch_id,
            username: wpSystemTemplateUsername(req),
            type,
            template_name,
        });

        return res.status(200).json({
            success: true,
            message: "OOMS system template mapping set successfully",
            data,
        });
    } catch (error) {
        console.error("PUT WP SYSTEM TEMPLATE MAP SET ERROR:", error);
        const message = error?.message || "Failed to set OOMS system template mapping";
        const status =
            message.includes("required") || message.includes("Invalid")
                ? 400
                : 500;
        return res.status(status).json({ success: false, message });
    }
});

router.put("/wp-system/template-map/unset", auth, validateBranch, async (req, res) => {
    try {
        const { type } = req.body || {};
        const data = await unsetTemplateMapping({
            branch_id: req.branch_id,
            username: wpSystemTemplateUsername(req),
            type,
        });

        return res.status(200).json({
            success: true,
            message: "OOMS system template mapping unset successfully",
            data,
        });
    } catch (error) {
        console.error("PUT WP SYSTEM TEMPLATE MAP UNSET ERROR:", error);
        const message = error?.message || "Failed to unset OOMS system template mapping";
        const status =
            message === "Template mapping not found"
                ? 404
                : message.includes("required")
                    ? 400
                    : 500;
        return res.status(status).json({ success: false, message });
    }
});

// ENDPOINTS FOR UNOFFICIAL WHATSAPP WEB AUTOMATION

router.get("/whatsappweb/health", auth, validateBranch, async (req, res) => {
    try {
        const response = await axios.get(`${WHATSAPPWEB_BASE_URL}/health`);
        return res.status(response.status).json(response.data);
    } catch (error) {
        return handleWhatsappWebAxiosError(error, res, "Failed to fetch WhatsApp Web health");
    }
});

router.get("/whatsappweb/status", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const branchSession = await getBranchWhatsappWebSession(branch_id);
        if (!branchSession.ok) {
            return res.status(branchSession.status).json(branchSession.data);
        }

        if (!branchSession.sessionId) {
            return res.status(200).json({
                success: true,
                message: "WhatsApp Web session is not configured",
                data: {
                    sessionId: null,
                    status: "not_configured",
                    connected: false,
                },
            });
        }

        const response = await whatsappWebRequest(
            "get",
            `/api/sessions/${encodeURIComponent(branchSession.sessionId)}`
        );

        const sessionData = response.data?.data || {};
        return res.status(response.status).json({
            ...response.data,
            data: {
                ...sessionData,
                sessionId: branchSession.sessionId,
                connected: sessionData.status === "connected",
            },
        });
    } catch (error) {
        if (error.response?.status === 404) {
            await clearBranchWhatsappWebSession(req.branch_id);
            return res.status(200).json({
                success: true,
                message: "WhatsApp Web session not found on server",
                data: {
                    sessionId: null,
                    status: "not_configured",
                    connected: false,
                },
            });
        }
        return handleWhatsappWebAxiosError(error, res, "Failed to fetch WhatsApp Web status");
    }
});

router.post("/whatsappweb/session/create", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { webhookUrl, pairingCodeEnabled } = req.body || {};
        const sessionId = generateWhatsappWebSessionId();

        const payload = { sessionId };
        if (webhookUrl != null && String(webhookUrl).trim() !== "") {
            payload.webhookUrl = String(webhookUrl).trim();
        }
        if (pairingCodeEnabled === true) {
            payload.pairingCodeEnabled = true;
        }

        let response;
        try {
            response = await whatsappWebRequest("post", "/api/sessions/create", { data: payload });
        } catch (error) {
            if (error.response?.status === 409) {
                response = await whatsappWebRequest(
                    "get",
                    `/api/sessions/${encodeURIComponent(sessionId)}`
                );
            } else {
                throw error;
            }
        }

        await setBranchWhatsappWebSession(branch_id, sessionId);

        return res.status(response.status).json({
            ...response.data,
            data: {
                ...(response.data?.data || {}),
                sessionId,
            },
        });
    } catch (error) {
        return handleWhatsappWebAxiosError(error, res, "Failed to create WhatsApp Web session");
    }
});

router.get("/whatsappweb/qr", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const resolved = await resolveBranchSessionId(branch_id);
        if (!resolved.ok) {
            return res.status(resolved.status).json(resolved.data);
        }

        const response = await whatsappWebRequest(
            "get",
            `/api/sessions/${encodeURIComponent(resolved.sessionId)}/qr`,
            { validateStatus: (status) => status >= 200 && status < 500 }
        );

        if (response.data?.data) {
            return res.status(response.status).json({
                ...response.data,
                data: {
                    ...response.data.data,
                    sessionId: resolved.sessionId,
                },
            });
        }

        return proxyWhatsappWebResponse(res, response);
    } catch (error) {
        return handleWhatsappWebAxiosError(error, res, "Failed to fetch WhatsApp Web QR code");
    }
});

router.post("/whatsappweb/pairing-code", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const phone = req.body?.phone != null ? String(req.body.phone).trim() : "";

        if (!phone) {
            return res.status(400).json({
                success: false,
                message: "phone is required",
            });
        }

        const resolved = await resolveBranchSessionId(branch_id);
        if (!resolved.ok) {
            return res.status(resolved.status).json(resolved.data);
        }

        const response = await whatsappWebRequest(
            "post",
            `/api/sessions/${encodeURIComponent(resolved.sessionId)}/pairing-code`,
            { data: { phone } }
        );

        return proxyWhatsappWebResponse(res, response);
    } catch (error) {
        return handleWhatsappWebAxiosError(error, res, "Failed to generate pairing code");
    }
});

router.delete("/whatsappweb/session", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const resolved = await resolveBranchSessionId(branch_id);
        if (!resolved.ok) {
            return res.status(resolved.status).json(resolved.data);
        }

        const response = await whatsappWebRequest(
            "delete",
            `/api/sessions/${encodeURIComponent(resolved.sessionId)}`,
            { validateStatus: (status) => status >= 200 && status < 500 }
        );

        await clearBranchWhatsappWebSession(branch_id);
        return proxyWhatsappWebResponse(res, response);
    } catch (error) {
        if (error.response?.status === 404) {
            await clearBranchWhatsappWebSession(req.branch_id);
            return res.status(200).json({
                success: true,
                message: "Session already removed",
            });
        }
        return handleWhatsappWebAxiosError(error, res, "Failed to delete WhatsApp Web session");
    }
});

router.get("/whatsappweb/messages", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const resolved = await resolveBranchSessionId(branch_id);
        if (!resolved.ok) {
            return res.status(resolved.status).json(resolved.data);
        }

        const response = await whatsappWebRequest(
            "get",
            `/api/sessions/${encodeURIComponent(resolved.sessionId)}/messages`,
            { params: req.query }
        );

        return proxyWhatsappWebResponse(res, response);
    } catch (error) {
        return handleWhatsappWebAxiosError(error, res, "Failed to fetch WhatsApp Web messages");
    }
});

router.post("/whatsappweb/send-text", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const resolved = await resolveBranchSessionId(branch_id);
        if (!resolved.ok) {
            return res.status(resolved.status).json(resolved.data);
        }

        const response = await whatsappWebRequest("post", "/api/messages/send-text", {
            data: {
                ...req.body,
                sessionId: resolved.sessionId,
            },
        });

        return proxyWhatsappWebResponse(res, response);
    } catch (error) {
        return handleWhatsappWebAxiosError(error, res, "Failed to send WhatsApp Web text message");
    }
});

router.post("/whatsappweb/send-image", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const resolved = await resolveBranchSessionId(branch_id);
        if (!resolved.ok) {
            return res.status(resolved.status).json(resolved.data);
        }

        const response = await whatsappWebRequest("post", "/api/messages/send-image", {
            data: {
                ...req.body,
                sessionId: resolved.sessionId,
            },
        });

        return proxyWhatsappWebResponse(res, response);
    } catch (error) {
        return handleWhatsappWebAxiosError(error, res, "Failed to send WhatsApp Web image message");
    }
});

router.post("/whatsappweb/send-video", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const resolved = await resolveBranchSessionId(branch_id);
        if (!resolved.ok) {
            return res.status(resolved.status).json(resolved.data);
        }

        const response = await whatsappWebRequest("post", "/api/messages/send-video", {
            data: {
                ...req.body,
                sessionId: resolved.sessionId,
            },
        });

        return proxyWhatsappWebResponse(res, response);
    } catch (error) {
        return handleWhatsappWebAxiosError(error, res, "Failed to send WhatsApp Web video message");
    }
});

router.post("/whatsappweb/send-document", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const resolved = await resolveBranchSessionId(branch_id);
        if (!resolved.ok) {
            return res.status(resolved.status).json(resolved.data);
        }

        const response = await whatsappWebRequest("post", "/api/messages/send-document", {
            data: {
                ...req.body,
                sessionId: resolved.sessionId,
            },
        });

        return proxyWhatsappWebResponse(res, response);
    } catch (error) {
        return handleWhatsappWebAxiosError(error, res, "Failed to send WhatsApp Web document message");
    }
});

router.post("/whatsappweb/send-audio", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const resolved = await resolveBranchSessionId(branch_id);
        if (!resolved.ok) {
            return res.status(resolved.status).json(resolved.data);
        }

        const response = await whatsappWebRequest("post", "/api/messages/send-audio", {
            data: {
                ...req.body,
                sessionId: resolved.sessionId,
            },
        });

        return proxyWhatsappWebResponse(res, response);
    } catch (error) {
        return handleWhatsappWebAxiosError(error, res, "Failed to send WhatsApp Web audio message");
    }
});

function whatsappWebTemplateUsername(req) {
    return req.headers["username"] || req.headers["Username"] || null;
}

router.post("/whatsappweb/template/create", auth, validateBranch, async (req, res) => {
    try {
        const data = await createWhatsappWebTemplate({
            branch_id: req.branch_id,
            username: whatsappWebTemplateUsername(req),
            payload: req.body || {},
        });
        return res.status(201).json({
            success: true,
            message: "WhatsApp Web template created successfully",
            data,
        });
    } catch (error) {
        const message = error?.message || "Failed to create WhatsApp Web template";
        const status = message.includes("required") || message.includes("must be") || message.includes("cannot be empty") || message.includes("must be one of") || message.includes("must be a") ? 400 : 500;
        return res.status(status).json({ success: false, message });
    }
});

router.put("/whatsappweb/template/edit", auth, validateBranch, async (req, res) => {
    try {
        const data = await updateWhatsappWebTemplate({
            branch_id: req.branch_id,
            username: whatsappWebTemplateUsername(req),
            payload: req.body || {},
        });
        return res.status(200).json({
            success: true,
            message: "WhatsApp Web template updated successfully",
            data,
        });
    } catch (error) {
        const message = error?.message || "Failed to update WhatsApp Web template";
        const status = message === "Template not found" ? 404 : message.includes("required") || message.includes("must be") || message.includes("cannot be empty") || message.includes("must be one of") || message.includes("must be a") || message.includes("when changing") ? 400 : 500;
        return res.status(status).json({ success: false, message });
    }
});

router.get("/whatsappweb/template/list", auth, validateBranch, async (req, res) => {
    try {
        const { page_no, limit, status, template_type } = req.query || {};
        const result = await listWhatsappWebTemplates({
            branch_id: req.branch_id,
            page_no,
            limit,
            status: status || null,
            template_type: template_type || null,
        });
        return res.status(200).json({
            success: true,
            message: "WhatsApp Web templates retrieved successfully",
            data: result.data,
            pagination: result.pagination,
        });
    } catch (error) {
        const message = error?.message || "Failed to list WhatsApp Web templates";
        const status = message.includes("must be") || message.includes("must be one of") ? 400 : 500;
        return res.status(status).json({ success: false, message });
    }
});

router.get("/whatsappweb/template/details/:template_id", auth, validateBranch, async (req, res) => {
    try {
        const data = await getWhatsappWebTemplateDetails({
            branch_id: req.branch_id,
            template_id: req.params.template_id,
        });
        return res.status(200).json({
            success: true,
            message: "WhatsApp Web template details retrieved successfully",
            data,
        });
    } catch (error) {
        const message = error?.message || "Failed to fetch WhatsApp Web template details";
        const status = message === "Template not found" ? 404 : 500;
        return res.status(status).json({ success: false, message });
    }
});

router.post("/whatsappweb/send-message", auth, validateBranch, async (req, res) => {
    try {
        const result = await sendWhatsappWebMessages({
            branch_id: req.branch_id,
            payload: req.body || {},
        });

        const status = result.success ? 200 : 207;
        return res.status(status).json(result);
    } catch (error) {
        const message = error?.message || "Failed to send WhatsApp Web message";
        const status = error.status || (
            message.includes("required") ||
                message.includes("must be") ||
                message.includes("Provide template_id") ||
                message.includes("not active") ||
                message.includes("not ready") ||
                message.includes("not connected") ||
                message.includes("not configured") ||
                message.includes("No valid recipients")
                ? 400
                : 500
        );

        if (error.data) {
            return res.status(status).json({
                success: false,
                message,
                data: error.data,
            });
        }

        return res.status(status).json({ success: false, message });
    }
});

router.get("/whatsappweb/template-map-list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const storedTemplates = await listWhatsappWebStaticTemplates({ branch_id });

        const mappingByTemplate = new Map();
        for (const row of storedTemplates) {
            const key = row.template_name ? String(row.template_name).trim() : "";
            if (key) {
                mappingByTemplate.set(key, row);
            }
        }

        const data = TEMPLATELIST.map((item) => {
            const mapping = mappingByTemplate.get(item.name);
            const isActive = mapping && mapping.status === "active";

            if (isActive) {
                return {
                    name: item.name,
                    description: item.description,
                    available_variables: item.available_variables ?? [],
                    is_set: true,
                    template_id: mapping.template_id,
                    template_type: mapping.template_type,
                    content: mapping.content,
                    variables_json: mapping.variables_json,
                    status: mapping.status,
                };
            }

            return {
                name: item.name,
                description: item.description,
                available_variables: item.available_variables ?? [],
                is_set: false,
                template_id: mapping?.template_id ?? null,
                template_type: mapping?.template_type ?? null,
                content: mapping?.content ?? null,
                variables_json: mapping?.variables_json ?? [],
                status: mapping?.status ?? "inactive",
            };
        });

        return res.status(200).json({
            success: true,
            message: "Template mapping list retrieved successfully",
            data,
        });
    } catch (error) {
        console.error("GET WHATSAPPWEB TEMPLATE MAP LIST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch template mapping list",
        });
    }
});

router.put("/whatsappweb/template-map/set", auth, validateBranch, async (req, res) => {
    try {
        const data = await setWhatsappWebStaticTemplate({
            branch_id: req.branch_id,
            username: whatsappWebTemplateUsername(req),
            payload: req.body || {},
        });

        return res.status(200).json({
            success: true,
            message: "Template mapping set successfully",
            data: {
                name: data.template_name,
                template_id: data.template_id,
                template_type: data.template_type,
                content: data.content,
                variables_json: data.variables_json,
                status: data.status,
            },
        });
    } catch (error) {
        console.error("PUT WHATSAPPWEB TEMPLATE MAP SET ERROR:", error);
        const message = error?.message || "Failed to set template mapping";
        const status =
            message.includes("required") ||
                message.includes("must be") ||
                message.includes("Invalid system template name") ||
                message.includes("must be a")
                ? 400
                : 500;
        return res.status(status).json({ success: false, message });
    }
});

router.put("/whatsappweb/template-map/unset", auth, validateBranch, async (req, res) => {
    try {
        const { name } = req.body || {};
        const data = await unsetWhatsappWebStaticTemplate({
            branch_id: req.branch_id,
            systemTemplateName: name,
        });

        return res.status(200).json({
            success: true,
            message: "Template mapping unset successfully",
            data: {
                name: data.template_name,
                template_id: data.template_id,
                status: data.status,
            },
        });
    } catch (error) {
        console.error("PUT WHATSAPPWEB TEMPLATE MAP UNSET ERROR:", error);
        const message = error?.message || "Failed to unset template mapping";
        const status =
            message === "Template not found"
                ? 404
                : message.includes("required") || message.includes("Invalid system template name")
                    ? 400
                    : 500;
        return res.status(status).json({ success: false, message });
    }
});

router.get("/whatsappweb/socket-config", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const branchSession = await getBranchWhatsappWebSession(branch_id);
        if (!branchSession.ok) {
            return res.status(branchSession.status).json(branchSession.data);
        }

        return res.status(200).json({
            success: true,
            message: "WhatsApp Web socket configuration retrieved successfully",
            data: {
                url: WHATSAPPWEB_BASE_URL,
                sessionId: branchSession.sessionId,
                events: {
                    listen: [
                        "qr.updated",
                        "pairing.code",
                        "session.connected",
                        "session.disconnected",
                        "message.received",
                        "message.sent",
                    ],
                },
            },
        });
    } catch (error) {
        console.error("GET WHATSAPP WEB SOCKET CONFIG ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch WhatsApp Web socket configuration",
        });
    }
});

export default router;
