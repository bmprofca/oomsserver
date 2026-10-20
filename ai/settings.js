import { migrateLegacyKey } from "./connections.js";

/**
 * Branch-level AI settings (table branch_ai_settings): the assistant on/off switch and
 * per-user rate limits. Providers, keys and models live in branch_ai_connections
 * (ai/connections.js) — a branch can keep several and they fail over in priority order.
 */

export const AI_EFFORTS = ["low", "medium", "high"];
/** read = answers only; read_write = may also propose sends that a person confirms. */
export const AI_ACCESS_MODES = ["read", "read_write"];

export const DEFAULT_BRANCH_AI_SETTINGS = Object.freeze({
    enabled: false,
    rate_per_min: 6,
    rate_per_day: 200,
    access_mode: "read",
});

function normalize(row) {
    if (!row) return { ...DEFAULT_BRANCH_AI_SETTINGS, modify_date: null, modify_by: null };
    return {
        enabled: String(row.enabled) === "1",
        rate_per_min: Number(row.rate_per_min) || DEFAULT_BRANCH_AI_SETTINGS.rate_per_min,
        rate_per_day: Number(row.rate_per_day) || DEFAULT_BRANCH_AI_SETTINGS.rate_per_day,
        access_mode: AI_ACCESS_MODES.includes(row.access_mode) ? row.access_mode : "read",
        modify_date: row.modify_date || null,
        modify_by: row.modify_by || null,
    };
}

async function loadRow(db, branchId) {
    const [rows] = await db.query(
        `SELECT enabled, rate_per_min, rate_per_day, access_mode, modify_date, modify_by,
                provider, model, effort, api_key_enc, api_key_hint, create_by
         FROM branch_ai_settings WHERE branch_id = ? LIMIT 1`,
        [branchId]
    );
    return rows?.[0] || null;
}

/** Branch settings (no secrets). Moves a legacy single key into a connection on first read. */
export async function getBranchAiSettings(db, branchId) {
    const row = await loadRow(db, branchId);
    if (row?.api_key_enc) await migrateLegacyKey(db, branchId, row);
    return normalize(row);
}

/** `accessMode` undefined keeps the current mode. */
export async function saveBranchAiSettings(db, branchId, username, { enabled, ratePerMin, ratePerDay, accessMode }) {
    const current = await loadRow(db, branchId);
    const mode = AI_ACCESS_MODES.includes(accessMode) ? accessMode : normalize(current).access_mode;
    if (current) {
        await db.query(
            `UPDATE branch_ai_settings
             SET enabled = ?, rate_per_min = ?, rate_per_day = ?, access_mode = ?, modify_by = ?, modify_date = NOW()
             WHERE branch_id = ?`,
            [enabled ? "1" : "0", ratePerMin, ratePerDay, mode, username, branchId]
        );
    } else {
        await db.query(
            `INSERT INTO branch_ai_settings (enabled, rate_per_min, rate_per_day, access_mode, modify_by, modify_date, branch_id, create_by)
             VALUES (?, ?, ?, ?, ?, NOW(), ?, ?)`,
            [enabled ? "1" : "0", ratePerMin, ratePerDay, mode, username, branchId, username]
        );
    }
    return normalize(await loadRow(db, branchId));
}
