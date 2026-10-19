import crypto from "crypto";
import { isValidBlock } from "./blocks.js";

/**
 * Persistence for AI conversations. Every query filters by branch_id AND username so a
 * user can never read or delete another user's (or another branch's) conversation.
 */

const CONVERSATION_ID_RE = /^[0-9a-f-]{36}$/;

export function isConversationId(value) {
    return typeof value === "string" && CONVERSATION_ID_RE.test(value);
}

function parseJson(value, fallback) {
    if (value == null) return fallback;
    if (typeof value === "object") return value;
    try {
        return JSON.parse(value);
    } catch (_) {
        return fallback;
    }
}

/** Audit-safe copy of tool arguments: short strings only, no nested blobs. */
export function sanitizeArgs(args) {
    const out = {};
    for (const [k, v] of Object.entries(args || {}).slice(0, 15)) {
        if (typeof v === "string") out[k] = v.slice(0, 80);
        else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
        else if (Array.isArray(v)) out[k] = v.slice(0, 10).map((x) => String(x).slice(0, 40));
    }
    return out;
}

export async function getConversation(db, { conversationId, branchId, username }) {
    if (!isConversationId(conversationId)) return null;
    const [rows] = await db.query(
        `SELECT conversation_id, title, message_count, last_message_at, create_date
         FROM ai_conversations
         WHERE conversation_id = ? AND branch_id = ? AND username = ? AND is_deleted = '0'
         LIMIT 1`,
        [conversationId, branchId, username]
    );
    return rows?.[0] || null;
}

export async function createConversation(db, { branchId, username, title }) {
    const conversationId = crypto.randomUUID();
    await db.query(
        `INSERT INTO ai_conversations (conversation_id, branch_id, username, title, message_count, last_message_at)
         VALUES (?, ?, ?, ?, 0, NOW())`,
        [conversationId, branchId, username, String(title || "New chat").slice(0, 200)]
    );
    return conversationId;
}

export async function listConversations(db, { branchId, username, limit = 20, offset = 0 }) {
    const [rows] = await db.query(
        `SELECT conversation_id, title, message_count, last_message_at, create_date
         FROM ai_conversations
         WHERE branch_id = ? AND username = ? AND is_deleted = '0'
         ORDER BY last_message_at DESC, id DESC
         LIMIT ? OFFSET ?`,
        [branchId, username, limit, offset]
    );
    return rows;
}

export async function getMessages(db, { conversationId, branchId, username, limit = 100 }) {
    const [rows] = await db.query(
        `SELECT message_id, role, content, blocks, tool_calls, status, create_date
         FROM (
            SELECT id, message_id, role, content, blocks, tool_calls, status, create_date
            FROM ai_messages
            WHERE conversation_id = ? AND branch_id = ? AND username = ?
            ORDER BY id DESC
            LIMIT ?
         ) recent
         ORDER BY id ASC`,
        [conversationId, branchId, username, limit]
    );
    return rows.map((r) => ({
        message_id: r.message_id,
        role: r.role,
        content: r.content || "",
        blocks: parseJson(r.blocks, []).filter(isValidBlock),
        tool_calls: parseJson(r.tool_calls, []),
        status: r.status,
        create_date: r.create_date,
    }));
}

export async function addMessage(db, m) {
    const messageId = crypto.randomUUID();
    await db.query(
        `INSERT INTO ai_messages
            (message_id, conversation_id, branch_id, username, role, content, blocks, tool_calls,
             status, model, input_tokens, output_tokens, correlation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            messageId,
            m.conversationId,
            m.branchId,
            m.username,
            m.role,
            m.content ?? "",
            m.blocks ? JSON.stringify(m.blocks) : null,
            m.toolCalls ? JSON.stringify(m.toolCalls.map((c) => ({ name: c.name, args: sanitizeArgs(c.args), ok: c.ok }))) : null,
            m.status || "ok",
            m.model || null,
            m.usage?.input_tokens ?? null,
            m.usage?.output_tokens ?? null,
            m.correlationId || null,
        ]
    );
    await db.query(
        `UPDATE ai_conversations
         SET message_count = message_count + 1, last_message_at = NOW(), modify_date = NOW()
         WHERE conversation_id = ? AND branch_id = ? AND username = ?`,
        [m.conversationId, m.branchId, m.username]
    );
    return messageId;
}

export async function deleteConversation(db, { conversationId, branchId, username }) {
    if (!isConversationId(conversationId)) return false;
    const [result] = await db.query(
        `UPDATE ai_conversations SET is_deleted = '1', modify_date = NOW()
         WHERE conversation_id = ? AND branch_id = ? AND username = ? AND is_deleted = '0'`,
        [conversationId, branchId, username]
    );
    return Number(result?.affectedRows) > 0;
}

export async function addToolCallAudit(db, rows) {
    if (!rows.length) return;
    const values = rows.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = rows.flatMap((r) => [
        r.conversationId,
        r.branchId,
        r.username,
        r.tool,
        JSON.stringify(sanitizeArgs(r.args)),
        r.status,
        r.rowCount ?? null,
        r.durationMs ?? null,
        r.errorCode ?? null,
        r.correlationId ?? null,
    ]);
    await db.query(
        `INSERT INTO ai_tool_calls
            (conversation_id, branch_id, username, tool_name, args, status, row_count, duration_ms, error_code, correlation_id)
         VALUES ${values}`,
        params
    );
}
