import crypto from "crypto";

/**
 * Pending write actions (table ai_pending_actions). The AI only ever creates a PENDING
 * action; a person must confirm it before anything is sent. Every query is scoped by
 * branch_id + the user who asked, so nobody can confirm someone else's action.
 */

export const ACTION_TTL_MINUTES = 15;

function parse(value, fallback) {
    if (value === null || value === undefined) return fallback;
    if (typeof value === "object") return value;
    try {
        return JSON.parse(value);
    } catch (_) {
        return fallback;
    }
}

function toAction(row) {
    if (!row) return null;
    const expired = row.status === "pending" && row.expires_at && new Date(row.expires_at).getTime() <= Date.now();
    return {
        id: row.action_id,
        branchId: row.branch_id,
        username: row.username,
        source: row.source,
        type: row.action_type,
        payload: parse(row.payload, {}),
        preview: parse(row.preview, {}),
        status: expired ? "expired" : row.status,
        result: parse(row.result, null),
        expiresAt: row.expires_at,
        decidedAt: row.decided_at || null,
    };
}

export async function createPendingAction(db, { branchId, username, source, type, payload, preview }) {
    const id = crypto.randomUUID();
    await db.query(
        `INSERT INTO ai_pending_actions (action_id, branch_id, username, source, action_type, payload, preview, status, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', DATE_ADD(NOW(), INTERVAL ${ACTION_TTL_MINUTES} MINUTE))`,
        [id, branchId, username, String(source).slice(0, 60), type, JSON.stringify(payload), JSON.stringify(preview)]
    );
    return id;
}

export async function getPendingAction(db, { actionId, branchId, username }) {
    const [rows] = await db.query(
        `SELECT * FROM ai_pending_actions WHERE action_id = ? AND branch_id = ? AND username = ? LIMIT 1`,
        [actionId, branchId, username]
    );
    return toAction(rows?.[0]);
}

/** Current state of several actions (for chat cards when a conversation is reopened). */
export async function getActionStates(db, { branchId, username, actionIds }) {
    if (!actionIds.length) return new Map();
    const [rows] = await db.query(
        `SELECT * FROM ai_pending_actions WHERE branch_id = ? AND username = ? AND action_id IN (${actionIds.map(() => "?").join(", ")})`,
        [branchId, username, ...actionIds]
    );
    return new Map((rows || []).map((r) => {
        const a = toAction(r);
        return [a.id, { status: a.status, result: a.result }];
    }));
}

/**
 * Atomically move pending → executing. Only one confirm can ever win, and only while the
 * action is unexpired and belongs to this user + branch.
 */
export async function claimPendingAction(db, { actionId, branchId, username }) {
    const [result] = await db.query(
        `UPDATE ai_pending_actions SET status = 'executing', decided_at = NOW(), decided_by = ?
         WHERE action_id = ? AND branch_id = ? AND username = ? AND status = 'pending' AND expires_at > NOW()`,
        [username, actionId, branchId, username]
    );
    return Number(result?.affectedRows) === 1;
}

export async function finishPendingAction(db, { actionId, status, result }) {
    await db.query("UPDATE ai_pending_actions SET status = ?, result = ? WHERE action_id = ?", [status, JSON.stringify(result ?? null), actionId]);
}

export async function cancelPendingAction(db, { actionId, branchId, username }) {
    const [result] = await db.query(
        `UPDATE ai_pending_actions SET status = 'cancelled', decided_at = NOW(), decided_by = ?
         WHERE action_id = ? AND branch_id = ? AND username = ? AND status = 'pending'`,
        [username, actionId, branchId, username]
    );
    return Number(result?.affectedRows) === 1;
}
