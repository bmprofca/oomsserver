import axios from "axios";
import pool from "../db.js";

export const WHATSAPPWEB_BASE_URL =
    process.env.WHATSAPPWEB_BASE_URL || "https://whatsappweb.onesaasbackend.com";
export const WHATSAPPWEB_API_KEY = process.env.WHATSAPPWEB_API_KEY || "onedevelopers";

function whatsappWebHeaders() {
    return {
        "X-API-Key": WHATSAPPWEB_API_KEY,
        "Content-Type": "application/json",
    };
}

export function generateWhatsappWebSessionId() {
    const random = Math.random().toString(36).slice(2, 12);
    return `ooms${Date.now()}${random}`.slice(0, 100);
}

export async function getBranchWhatsappWebSession(branch_id) {
    const [rows] = await pool.query(
        `SELECT whatsappweb_session
         FROM branch_list
         WHERE branch_id = ?
           AND is_deleted = '0'
         LIMIT 1`,
        [branch_id]
    );

    if (!rows.length) {
        return { ok: false, status: 404, data: { success: false, message: "Branch not found" } };
    }

    const sessionId = rows[0].whatsappweb_session
        ? String(rows[0].whatsappweb_session).trim()
        : "";

    return { ok: true, sessionId: sessionId || null };
}

export async function setBranchWhatsappWebSession(branch_id, sessionId) {
    await pool.query(
        `UPDATE branch_list
         SET whatsappweb_session = ?
         WHERE branch_id = ?
           AND is_deleted = '0'`,
        [sessionId, branch_id]
    );
}

export async function clearBranchWhatsappWebSession(branch_id) {
    await pool.query(
        `UPDATE branch_list
         SET whatsappweb_session = NULL
         WHERE branch_id = ?
           AND is_deleted = '0'`,
        [branch_id]
    );
}

export async function resolveBranchSessionId(branch_id) {
    const branchSession = await getBranchWhatsappWebSession(branch_id);
    if (!branchSession.ok) {
        return branchSession;
    }

    if (!branchSession.sessionId) {
        return {
            ok: false,
            status: 400,
            data: {
                success: false,
                message: "WhatsApp Web session is not configured for this branch",
            },
        };
    }

    return { ok: true, sessionId: branchSession.sessionId };
}

export async function whatsappWebRequest(method, path, { data, params, validateStatus } = {}) {
    const config = {
        method,
        url: `${WHATSAPPWEB_BASE_URL}${path}`,
        headers: whatsappWebHeaders(),
        params,
        validateStatus,
    };

    if (data !== undefined) {
        config.data = data;
    }

    return axios(config);
}

export function handleWhatsappWebAxiosError(error, res, fallbackMessage) {
    if (error.response) {
        return res.status(error.response.status).json(error.response.data);
    }

    console.error(fallbackMessage, error);
    return res.status(500).json({
        success: false,
        message: fallbackMessage,
    });
}

export function proxyWhatsappWebResponse(res, response) {
    return res.status(response.status).json(response.data);
}

export async function getSessionStatus(sessionId) {
    return whatsappWebRequest("get", `/api/sessions/${encodeURIComponent(sessionId)}`);
}

const WHATSAPPWEB_SEND_PATHS = {
    text: "/api/messages/send-text",
    image: "/api/messages/send-image",
    video: "/api/messages/send-video",
    document: "/api/messages/send-document",
    audio: "/api/messages/send-audio",
};

function resolveMediaCaption(content) {
    const caption = content?.caption ?? content?.message;
    if (caption == null) return undefined;
    const text = String(caption);
    return text.trim() ? text : undefined;
}

export async function assertWhatsappWebSessionReady(branch_id) {
    const resolved = await resolveBranchSessionId(branch_id);
    if (!resolved.ok) {
        return resolved;
    }

    const sessionStatus = await getSessionStatus(resolved.sessionId);
    const status = sessionStatus.data?.data?.status;
    if (status !== "connected") {
        return {
            ok: false,
            status: 400,
            data: {
                success: false,
                message: "WhatsApp Web session is not connected",
            },
        };
    }

    return { ok: true, sessionId: resolved.sessionId };
}

export function buildWhatsappWebSendPayload(template_type, content, sessionId, number) {
    const base = { sessionId, number };

    switch (template_type) {
        case "text":
            return { ...base, message: content.message };
        case "image":
        case "video": {
            const payload = { ...base, url: content.url };
            const caption = resolveMediaCaption(content);
            if (caption !== undefined) {
                payload.caption = caption;
            }
            return payload;
        }
        case "document": {
            const payload = { ...base, url: content.url };
            if (content.filename) {
                payload.filename = content.filename;
            }
            const caption = resolveMediaCaption(content);
            if (caption !== undefined) {
                payload.caption = caption;
            }
            return payload;
        }
        case "audio":
            return {
                ...base,
                url: content.url,
                ...(content.is_voice !== undefined ? { is_voice: content.is_voice } : {}),
            };
        default:
            throw new Error(`Unsupported template_type: ${template_type}`);
    }
}

export async function executeWhatsappWebSend({ sessionId, number, template_type, content }) {
    const path = WHATSAPPWEB_SEND_PATHS[template_type];
    if (!path) {
        throw new Error(`Unsupported template_type: ${template_type}`);
    }

    const payload = buildWhatsappWebSendPayload(template_type, content, sessionId, number);
    return whatsappWebRequest("post", path, { data: payload });
}

export async function sendWhatsappWebMessage({ branch_id, number, template_type, content }) {
    const session = await assertWhatsappWebSessionReady(branch_id);
    if (!session.ok) {
        throw new Error(session.data?.message || "WhatsApp Web session is not configured");
    }

    await executeWhatsappWebSend({
        sessionId: session.sessionId,
        number,
        template_type,
        content,
    });
}
