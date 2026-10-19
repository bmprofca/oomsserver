import crypto from "crypto";
import { decryptSecret, encryptSecret, maskSecret } from "../helpers/secretBox.js";
import { AI_PROVIDER_IDS } from "./providers/catalog.js";

/**
 * AI connections of a branch (table branch_ai_connections). Each connection = provider +
 * encrypted API key + model + effort. Enabled connections are tried in `priority` order
 * (1 = first); when one fails on the provider side the next answers (ai/failover.js).
 *
 * Keys are AES-256-GCM encrypted and never leave the server — public rows carry only a
 * masked hint. Every query is scoped by branch_id.
 */

export const MAX_CONNECTIONS = 10;
const EFFORTS = ["low", "medium", "high"];

const PUBLIC_COLUMNS = `connection_id, label, provider, model, effort, api_key_hint, enabled, priority,
    last_status, last_checked_at, last_used_at, create_date, modify_date, modify_by`;

function toPublic(row) {
    return {
        id: row.connection_id,
        label: row.label || null,
        provider: row.provider,
        model: row.model,
        effort: EFFORTS.includes(row.effort) ? row.effort : "medium",
        api_key_hint: row.api_key_hint || null,
        enabled: String(row.enabled) === "1",
        priority: Number(row.priority) || 0,
        last_status: row.last_status || null,
        last_checked_at: row.last_checked_at || null,
        last_used_at: row.last_used_at || null,
        modify_date: row.modify_date || row.create_date || null,
        modify_by: row.modify_by || null,
    };
}

/** All connections of the branch, in priority order (no keys). */
export async function listConnections(db, branchId) {
    const [rows] = await db.query(
        `SELECT ${PUBLIC_COLUMNS} FROM branch_ai_connections WHERE branch_id = ? ORDER BY priority ASC, id ASC`,
        [branchId]
    );
    return (rows || []).filter((r) => AI_PROVIDER_IDS.includes(r.provider)).map(toPublic);
}

/** Enabled connections with decrypted keys, in priority order — server-side use only. */
export async function getRuntimeConnections(db, branchId) {
    const [rows] = await db.query(
        `SELECT ${PUBLIC_COLUMNS}, api_key_enc FROM branch_ai_connections
         WHERE branch_id = ? AND enabled = '1' ORDER BY priority ASC, id ASC`,
        [branchId]
    );
    return (rows || [])
        .filter((r) => AI_PROVIDER_IDS.includes(r.provider))
        .map((r) => ({ ...toPublic(r), apiKey: r.api_key_enc ? decryptSecret(r.api_key_enc) : "" }))
        .filter((c) => c.apiKey); // unreadable keys (e.g. encryption key changed) are skipped
}

/** One connection with its decrypted key (for "test saved connection"). */
export async function getConnectionWithKey(db, branchId, connectionId) {
    const [rows] = await db.query(
        `SELECT ${PUBLIC_COLUMNS}, api_key_enc FROM branch_ai_connections WHERE branch_id = ? AND connection_id = ? LIMIT 1`,
        [branchId, connectionId]
    );
    const row = rows?.[0];
    if (!row) return null;
    return { ...toPublic(row), apiKey: row.api_key_enc ? decryptSecret(row.api_key_enc) : "" };
}

async function countConnections(db, branchId) {
    const [[row]] = await db.query("SELECT COUNT(*) AS n, COALESCE(MAX(priority), 0) AS maxp FROM branch_ai_connections WHERE branch_id = ?", [branchId]);
    return { count: Number(row?.n) || 0, maxPriority: Number(row?.maxp) || 0 };
}

export class ConnectionLimitError extends Error {
    constructor() {
        super(`A branch can have at most ${MAX_CONNECTIONS} AI connections`);
        this.code = "CONNECTION_LIMIT";
    }
}

export async function createConnection(db, branchId, username, { label, provider, model, effort, apiKey, enabled = true }) {
    const { count, maxPriority } = await countConnections(db, branchId);
    if (count >= MAX_CONNECTIONS) throw new ConnectionLimitError();
    const connectionId = crypto.randomUUID();
    const key = apiKey.trim();
    await db.query(
        `INSERT INTO branch_ai_connections
            (connection_id, branch_id, label, provider, model, effort, api_key_enc, api_key_hint, enabled, priority,
             create_by, modify_by, modify_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [connectionId, branchId, label || null, provider, model, effort, encryptSecret(key), maskSecret(key), enabled ? "1" : "0", maxPriority + 1, username, username]
    );
    return connectionId;
}

/** Partial update. A new key may be given; the provider can only change together with a new key. */
export async function updateConnection(db, branchId, username, connectionId, patch) {
    const sets = [];
    const params = [];
    const put = (col, value) => {
        sets.push(`${col} = ?`);
        params.push(value);
    };
    if (patch.label !== undefined) put("label", patch.label || null);
    if (patch.provider !== undefined) put("provider", patch.provider);
    if (patch.model !== undefined) put("model", patch.model);
    if (patch.effort !== undefined) put("effort", patch.effort);
    if (patch.enabled !== undefined) put("enabled", patch.enabled ? "1" : "0");
    if (typeof patch.apiKey === "string" && patch.apiKey.trim()) {
        put("api_key_enc", encryptSecret(patch.apiKey.trim()));
        put("api_key_hint", maskSecret(patch.apiKey.trim()));
        // A new key starts with a clean bill of health.
        put("last_status", null);
    }
    if (!sets.length) return true;
    put("modify_by", username);
    const [result] = await db.query(
        `UPDATE branch_ai_connections SET ${sets.join(", ")}, modify_date = NOW() WHERE branch_id = ? AND connection_id = ?`,
        [...params, branchId, connectionId]
    );
    return Number(result?.affectedRows ?? 1) > 0;
}

/** Hard delete: the encrypted key is removed from the database. */
export async function deleteConnection(db, branchId, connectionId) {
    const [result] = await db.query("DELETE FROM branch_ai_connections WHERE branch_id = ? AND connection_id = ?", [branchId, connectionId]);
    return Number(result?.affectedRows ?? 1) > 0;
}

/** Set priorities from an ordered list of connection ids (must be exactly the branch's set). */
export async function reorderConnections(db, branchId, username, orderedIds) {
    const current = await listConnections(db, branchId);
    const known = new Set(current.map((c) => c.id));
    if (orderedIds.length !== known.size || new Set(orderedIds).size !== orderedIds.length || !orderedIds.every((id) => known.has(id))) {
        return false;
    }
    for (let i = 0; i < orderedIds.length; i++) {
        await db.query(
            "UPDATE branch_ai_connections SET priority = ?, modify_by = ?, modify_date = NOW() WHERE branch_id = ? AND connection_id = ?",
            [i + 1, username, branchId, orderedIds[i]]
        );
    }
    return true;
}

/** Health shown on the settings page: "ok" or a provider error code (BILLING, INVALID_KEY …). */
export async function recordConnectionStatus(db, branchId, connectionId, status, { used = false } = {}) {
    await db.query(
        `UPDATE branch_ai_connections
         SET last_status = ?, last_checked_at = NOW()${used ? ", last_used_at = NOW()" : ""}
         WHERE branch_id = ? AND connection_id = ?`,
        [String(status).slice(0, 40), branchId, connectionId]
    );
}

/**
 * Single-key era → connections: copy the legacy key from branch_ai_settings into a
 * connection (only when the branch has none yet), then clear the legacy key columns.
 */
export async function migrateLegacyKey(db, branchId, legacyRow) {
    if (!legacyRow?.api_key_enc) return;
    const { count } = await countConnections(db, branchId);
    if (count === 0 && AI_PROVIDER_IDS.includes(legacyRow.provider || "anthropic")) {
        await db.query(
            `INSERT INTO branch_ai_connections
                (connection_id, branch_id, label, provider, model, effort, api_key_enc, api_key_hint, enabled, priority,
                 create_by, modify_by, modify_date)
             VALUES (?, ?, NULL, ?, ?, ?, ?, ?, '1', 1, ?, ?, NOW())`,
            [
                crypto.randomUUID(),
                branchId,
                legacyRow.provider || "anthropic",
                legacyRow.model || "claude-sonnet-5-5",
                EFFORTS.includes(legacyRow.effort) ? legacyRow.effort : "medium",
                legacyRow.api_key_enc,
                legacyRow.api_key_hint || null,
                legacyRow.create_by || null,
                legacyRow.create_by || null,
            ]
        );
    }
    await db.query("UPDATE branch_ai_settings SET api_key_enc = NULL, api_key_hint = NULL WHERE branch_id = ?", [branchId]);
}
