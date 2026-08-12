import axios from "axios";
import pool from "../db.js";

/** WhatsApp Web V2 API — see WhatsAppWebV2/docs.md */
export const WHATSAPPWEB_BASE_URL = String(
    process.env.WHATSAPPWEB_BASE_URL || ""
).trim().replace(/\/$/, "");

/** Unused by V2 (no auth). Kept for env compatibility. */
export const WHATSAPPWEB_API_KEY = String(
    process.env.WHATSAPPWEB_API_KEY || ""
).trim();

function whatsappWebHeaders() {
    return {
        "Content-Type": "application/json",
    };
}

export function generateWhatsappWebSessionId() {
    const random = Math.random().toString(36).slice(2, 12);
    return `ooms${Date.now()}${random}`.slice(0, 100);
}

export function encodeWhatsappWebSessionPath(sessionId) {
    return encodeURIComponent(String(sessionId || "").trim());
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
        timeout: 30000,
    };

    if (validateStatus !== undefined) {
        config.validateStatus = validateStatus;
    }

    if (data !== undefined) {
        config.data = data;
    }

    return axios(config);
}

export function extractWhatsappWebErrorMessage(error, fallbackMessage) {
    const body = error?.response?.data;
    if (body?.error?.message) {
        return String(body.error.message);
    }
    if (body?.message) {
        return String(body.message);
    }
    if (error?.message) {
        return String(error.message);
    }
    return fallbackMessage;
}

export function extractWhatsappWebErrorCode(error) {
    const code = error?.response?.data?.error?.code;
    return code != null ? String(code) : null;
}

export function handleWhatsappWebAxiosError(error, res, fallbackMessage) {
    if (error.response) {
        const body = error.response.data;
        const message = extractWhatsappWebErrorMessage(error, fallbackMessage);
        const code = extractWhatsappWebErrorCode(error);

        if (body && typeof body === "object") {
            return res.status(error.response.status).json({
                ...body,
                success: false,
                message: body.message || message,
                ...(code ? { error_code: code } : {}),
            });
        }

        return res.status(error.response.status).json({
            success: false,
            message,
            ...(code ? { error_code: code } : {}),
        });
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
    return whatsappWebRequest(
        "get",
        `/sessions/${encodeWhatsappWebSessionPath(sessionId)}`
    );
}

export async function startWhatsappWebSession(sessionId) {
    return whatsappWebRequest("post", "/sessions", {
        data: { session: String(sessionId).trim() },
    });
}

export async function getWhatsappWebQr(sessionId) {
    return whatsappWebRequest(
        "get",
        `/sessions/${encodeWhatsappWebSessionPath(sessionId)}/qr`,
        { validateStatus: (status) => status >= 200 && status < 500 }
    );
}

export async function deleteWhatsappWebSession(sessionId) {
    return whatsappWebRequest(
        "delete",
        `/sessions/${encodeWhatsappWebSessionPath(sessionId)}`,
        { validateStatus: (status) => status >= 200 && status < 500 }
    );
}

export async function reconnectWhatsappWebSession(sessionId) {
    return whatsappWebRequest(
        "post",
        `/sessions/${encodeWhatsappWebSessionPath(sessionId)}/reconnect`
    );
}

function resolveMediaCaption(content) {
    const caption = content?.caption ?? content?.message;
    if (caption == null) return undefined;
    const text = String(caption);
    return text.trim() ? text : undefined;
}

function normalizeRecipientPhone(number) {
    return String(number || "")
        .replace(/[^\d@.]/g, "")
        .trim();
}

export async function assertWhatsappWebSessionReady(branch_id) {
    const resolved = await resolveBranchSessionId(branch_id);
    if (!resolved.ok) {
        return resolved;
    }

    let sessionStatus;
    try {
        sessionStatus = await getSessionStatus(resolved.sessionId);
    } catch (error) {
        return {
            ok: false,
            status: error.response?.status || 500,
            data: {
                success: false,
                message: extractWhatsappWebErrorMessage(
                    error,
                    "WhatsApp Web session is not connected"
                ),
            },
        };
    }

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

/**
 * Build V2 send body (session is in the URL path, not the body).
 * @returns {{ kind: 'text'|'media', payload: object }}
 */
export function buildWhatsappWebSendPayload(template_type, content, number) {
    const phone = normalizeRecipientPhone(number);
    if (!phone) {
        throw new Error("Recipient phone number is required");
    }

    switch (template_type) {
        case "text":
            return {
                kind: "text",
                payload: {
                    phone,
                    message: content?.message != null ? String(content.message) : "",
                },
            };
        case "image":
        case "video":
        case "document":
        case "audio": {
            const file = content?.url != null ? String(content.url).trim() : "";
            if (!file) {
                throw new Error("Media url is required");
            }
            const payload = { phone, file };
            const caption = resolveMediaCaption(content);
            if (caption !== undefined) {
                payload.caption = caption;
            }
            const fileName =
                content?.filename != null
                    ? String(content.filename).trim()
                    : content?.fileName != null
                      ? String(content.fileName).trim()
                      : "";
            if (fileName) {
                payload.fileName = fileName;
            }
            return { kind: "media", payload };
        }
        default:
            throw new Error(`Unsupported template_type: ${template_type}`);
    }
}

async function postWhatsappWebSend(sessionId, kind, payload) {
    const encoded = encodeWhatsappWebSessionPath(sessionId);
    const path =
        kind === "text"
            ? `/sessions/${encoded}/messages`
            : `/sessions/${encoded}/messages/media`;
    return whatsappWebRequest("post", path, { data: payload });
}

async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send via V2. On 409 SESSION_NOT_CONNECTED, try reconnect once then retry.
 */
export async function executeWhatsappWebSend({ sessionId, number, template_type, content }) {
    const { kind, payload } = buildWhatsappWebSendPayload(template_type, content, number);

    try {
        return await postWhatsappWebSend(sessionId, kind, payload);
    } catch (error) {
        const code = extractWhatsappWebErrorCode(error);
        const status = error.response?.status;
        if (status !== 409 && code !== "SESSION_NOT_CONNECTED") {
            throw error;
        }

        try {
            await reconnectWhatsappWebSession(sessionId);
            await sleep(1500);
            const statusRes = await getSessionStatus(sessionId);
            if (statusRes.data?.data?.status !== "connected") {
                throw error;
            }
            return await postWhatsappWebSend(sessionId, kind, payload);
        } catch (retryError) {
            throw retryError?.response ? retryError : error;
        }
    }
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

/** Map proxy send-* body fields to V2 media payload. */
export function buildWhatsappWebMediaProxyPayload(body = {}) {
    const phone = normalizeRecipientPhone(body.phone ?? body.number);
    const file = String(body.file ?? body.url ?? "").trim();
    const payload = { phone, file };
    const caption = resolveMediaCaption(body);
    if (caption !== undefined) {
        payload.caption = caption;
    }
    const fileName = String(body.fileName ?? body.filename ?? "").trim();
    if (fileName) {
        payload.fileName = fileName;
    }
    return payload;
}

export function buildWhatsappWebTextProxyPayload(body = {}) {
    return {
        phone: normalizeRecipientPhone(body.phone ?? body.number),
        message: body.message != null ? String(body.message) : "",
    };
}
