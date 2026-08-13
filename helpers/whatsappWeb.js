import axios from "axios";
import pool from "../db.js";

/** WhatsApp Web V2 API — see WhatsAppWebV2/docs.md */
export const WHATSAPPWEB_BASE_URL = String(
    process.env.WHATSAPPWEB_BASE_URL || ""
).trim().replace(/\/$/, "");

/** Required on every upstream JSON call (`x-api-key`). */
export const WHATSAPPWEB_API_KEY = String(
    process.env.WHATSAPPWEB_API_KEY || ""
).trim();

function whatsappWebHeaders() {
    if (!WHATSAPPWEB_API_KEY) {
        throw new Error(
            "WHATSAPPWEB_API_KEY is not configured (required as x-api-key for WhatsApp Web V2)"
        );
    }
    return {
        "Content-Type": "application/json",
        "x-api-key": WHATSAPPWEB_API_KEY,
    };
}

export function generateWhatsappWebSessionId() {
    const random = Math.random().toString(36).slice(2, 12);
    return `ooms${Date.now()}${random}`.slice(0, 100);
}

export function encodeWhatsappWebSessionPath(sessionId) {
    return encodeURIComponent(String(sessionId || "").trim());
}

/**
 * V2 upstream uses status "ready" (with linked/socket) once the session can talk to WhatsApp.
 * Older docs/UI used "connected". Treat both as online.
 */
export function isWhatsappWebSessionConnected(sessionData = {}) {
    const status = String(sessionData?.status || sessionData?.currentStatus || "")
        .trim()
        .toLowerCase();
    if (status === "connected" || status === "ready") {
        return true;
    }
    if (sessionData?.connected === true) {
        return true;
    }
    if (
        sessionData?.linked === true &&
        status !== "disconnected" &&
        status !== "destroyed" &&
        status !== "needs_qr" &&
        status !== "unreachable"
    ) {
        return true;
    }
    if (
        String(sessionData?.socket || "").trim().toLowerCase() === "connected" &&
        (status === "ready" || status === "connected" || sessionData?.linked === true)
    ) {
        return true;
    }
    return false;
}

/** Normalize upstream payload for OOMS clients (connected flag + stable status label). */
export function normalizeWhatsappWebSessionPayload(sessionData = {}, sessionId = null) {
    const connected = isWhatsappWebSessionConnected(sessionData);
    const rawStatus = String(sessionData?.status || "").trim().toLowerCase();
    let status = rawStatus || (sessionId ? "disconnected" : "not_configured");

    if (connected) {
        status = "connected";
    } else if (rawStatus === "needs_qr") {
        status = "needs_qr";
    } else if (rawStatus === "unreachable") {
        status = "unreachable";
    } else if (rawStatus === "connecting") {
        status = "connecting";
    }

    return {
        ...sessionData,
        sessionId: sessionId || sessionData?.sessionId || sessionData?.session || null,
        connected,
        status,
    };
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

export async function whatsappWebRequest(method, path, { data, params, validateStatus, timeout } = {}) {
    if (!WHATSAPPWEB_BASE_URL) {
        throw new Error("WHATSAPPWEB_BASE_URL is not configured");
    }

    const config = {
        method,
        url: `${WHATSAPPWEB_BASE_URL}${path}`,
        headers: whatsappWebHeaders(),
        params,
        timeout: timeout != null ? timeout : 30000,
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

export async function startWhatsappWebSession() {
    // V2: server generates session id — do not send `session` in the body.
    return whatsappWebRequest("post", "/sessions", {
        data: {},
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
    // Docs: send anytime for a linked session — no status probe first.
    return resolveBranchSessionId(branch_id);
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
 * Send via V2. On transient connect failures, try reconnect once then retry.
 * NEEDS_QR / SESSION_NOT_FOUND require a new QR — do not reconnect.
 */
export async function executeWhatsappWebSend({ sessionId, number, template_type, content }) {
    const { kind, payload } = buildWhatsappWebSendPayload(template_type, content, number);

    try {
        return await postWhatsappWebSend(sessionId, kind, payload);
    } catch (error) {
        const code = extractWhatsappWebErrorCode(error);
        if (code === "NEEDS_QR" || code === "SESSION_NOT_FOUND") {
            const err = new Error(
                extractWhatsappWebErrorMessage(
                    error,
                    "WhatsApp Web session needs QR linking again"
                )
            );
            err.code = code;
            err.response = error.response;
            throw err;
        }

        const status = error.response?.status;
        const transient =
            status === 504 ||
            code === "CONNECT_TIMEOUT" ||
            code === "RECONNECT_FAILED" ||
            code === "SESSION_NOT_CONNECTED" ||
            status === 409;

        if (!transient) {
            throw error;
        }

        try {
            await reconnectWhatsappWebSession(sessionId);
            await sleep(1500);
            return await postWhatsappWebSend(sessionId, kind, payload);
        } catch (retryError) {
            const retryCode = extractWhatsappWebErrorCode(retryError);
            if (retryCode === "NEEDS_QR" || retryCode === "SESSION_NOT_FOUND") {
                const err = new Error(
                    extractWhatsappWebErrorMessage(
                        retryError,
                        "WhatsApp Web session needs QR linking again"
                    )
                );
                err.code = retryCode;
                err.response = retryError.response;
                throw err;
            }
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
