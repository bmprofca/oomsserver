import crypto from "crypto";

/**
 * Remote MCP connectors of a branch (table branch_mcp_connectors).
 *
 * A connector is a secret URL — https://<server>/api/v1/mcp/<token> — that an MCP client
 * such as Claude ("Add custom connector") uses to read this branch's data through the
 * same read-only tools as the in-app assistant. Requests run with the permissions of the
 * connector's `run_as_username` (checked again on every request).
 *
 * The token is shown once when created or regenerated; only its SHA-256 hash is stored.
 */

export const MAX_MCP_CONNECTORS = 20;
export const MCP_TOKEN_PREFIX = "ooms_mcp_";
export const MCP_TOKEN_RE = /^ooms_mcp_[A-Za-z0-9_-]{43}$/;
export const MCP_PATH = "/api/v1/mcp";

export function hashToken(token) {
    return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function newToken() {
    return `${MCP_TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
}

const COLUMNS = `c.connector_id, c.label, c.token_hint, c.run_as_username, c.enabled, c.access_mode, c.last_used_at, c.last_client,
    c.create_by, c.create_date, c.modify_date,
    (SELECT p.name FROM profile p WHERE p.username = c.run_as_username ORDER BY p.id DESC LIMIT 1) AS run_as_name`;

function toPublic(row) {
    return {
        id: row.connector_id,
        label: row.label || null,
        token_hint: row.token_hint || null,
        run_as: row.run_as_username,
        run_as_name: row.run_as_name || null,
        enabled: String(row.enabled) === "1",
        access_mode: row.access_mode === "read_write" ? "read_write" : "read",
        last_used_at: row.last_used_at || null,
        last_client: row.last_client || null,
        create_date: row.create_date || null,
        modify_date: row.modify_date || null,
    };
}

export async function listMcpConnectors(db, branchId) {
    const [rows] = await db.query(
        `SELECT ${COLUMNS} FROM branch_mcp_connectors c WHERE c.branch_id = ? ORDER BY c.id ASC`,
        [branchId]
    );
    return (rows || []).map(toPublic);
}

export async function getMcpConnector(db, branchId, connectorId) {
    const [rows] = await db.query(
        `SELECT ${COLUMNS} FROM branch_mcp_connectors c WHERE c.branch_id = ? AND c.connector_id = ? LIMIT 1`,
        [branchId, connectorId]
    );
    return rows?.[0] ? toPublic(rows[0]) : null;
}

/** Resolve a presented token to its enabled connector (server-side use only). */
export async function findConnectorByToken(db, token) {
    if (!MCP_TOKEN_RE.test(String(token || ""))) return null;
    const [rows] = await db.query(
        `SELECT connector_id, branch_id, run_as_username, enabled, access_mode, last_used_at
         FROM branch_mcp_connectors WHERE token_hash = ? LIMIT 1`,
        [hashToken(token)]
    );
    const row = rows?.[0];
    if (!row || String(row.enabled) !== "1") return null;
    return {
        id: row.connector_id,
        branchId: row.branch_id,
        runAs: row.run_as_username,
        accessMode: row.access_mode === "read_write" ? "read_write" : "read",
        lastUsedAt: row.last_used_at,
    };
}

export class ConnectorLimitError extends Error {
    constructor() {
        super(`A branch can have at most ${MAX_MCP_CONNECTORS} connectors`);
        this.code = "CONNECTOR_LIMIT";
    }
}

/** @returns {Promise<{id: string, token: string}>} the plain token — show it once */
export async function createMcpConnector(db, branchId, username, { label, runAs }) {
    const [[count]] = await db.query("SELECT COUNT(*) AS n FROM branch_mcp_connectors WHERE branch_id = ?", [branchId]);
    if (Number(count?.n) >= MAX_MCP_CONNECTORS) throw new ConnectorLimitError();
    const id = crypto.randomUUID();
    const token = newToken();
    await db.query(
        `INSERT INTO branch_mcp_connectors
            (connector_id, branch_id, label, token_hash, token_hint, run_as_username, enabled, create_by, modify_by, modify_date)
         VALUES (?, ?, ?, ?, ?, ?, '1', ?, ?, NOW())`,
        [id, branchId, label || null, hashToken(token), `…${token.slice(-4)}`, runAs, username, username]
    );
    return { id, token };
}

export async function updateMcpConnector(db, branchId, username, connectorId, { label, enabled, runAs, accessMode }) {
    const sets = [];
    const params = [];
    if (label !== undefined) {
        sets.push("label = ?");
        params.push(label || null);
    }
    if (enabled !== undefined) {
        sets.push("enabled = ?");
        params.push(enabled ? "1" : "0");
    }
    if (runAs !== undefined) {
        sets.push("run_as_username = ?");
        params.push(runAs);
    }
    if (accessMode !== undefined) {
        sets.push("access_mode = ?");
        params.push(accessMode === "read_write" ? "read_write" : "read");
    }
    if (!sets.length) return true;
    const [result] = await db.query(
        `UPDATE branch_mcp_connectors SET ${sets.join(", ")}, modify_by = ?, modify_date = NOW()
         WHERE branch_id = ? AND connector_id = ?`,
        [...params, username, branchId, connectorId]
    );
    return Number(result?.affectedRows ?? 1) > 0;
}

/** New secret; the old URL stops working immediately. */
export async function rotateMcpConnector(db, branchId, username, connectorId) {
    const token = newToken();
    const [result] = await db.query(
        `UPDATE branch_mcp_connectors SET token_hash = ?, token_hint = ?, modify_by = ?, modify_date = NOW()
         WHERE branch_id = ? AND connector_id = ?`,
        [hashToken(token), `…${token.slice(-4)}`, username, branchId, connectorId]
    );
    return Number(result?.affectedRows ?? 1) > 0 ? token : null;
}

export async function deleteMcpConnector(db, branchId, connectorId) {
    const [result] = await db.query("DELETE FROM branch_mcp_connectors WHERE branch_id = ? AND connector_id = ?", [branchId, connectorId]);
    return Number(result?.affectedRows ?? 1) > 0;
}

export async function touchMcpConnector(db, connectorId, client) {
    await db.query("UPDATE branch_mcp_connectors SET last_used_at = NOW(), last_client = COALESCE(?, last_client) WHERE connector_id = ?", [
        client ? String(client).slice(0, 120) : null,
        connectorId,
    ]);
}

/** Active members a connector may run as (admins and staff of the branch). */
export async function listConnectorMembers(db, branchId) {
    const [rows] = await db.query(
        `SELECT bm.username, bm.type, bm.designation,
                (SELECT p.name FROM profile p WHERE p.username = bm.username ORDER BY p.id DESC LIMIT 1) AS name
         FROM branch_mapping bm
         WHERE bm.branch_id = ? AND bm.type IN ('admin', 'staff')
           AND bm.is_deleted = '0' AND bm.status = '1' AND bm.is_accepted = '1'
         ORDER BY (bm.type = 'admin') DESC, name ASC
         LIMIT 500`,
        [branchId]
    );
    return (rows || []).map((r) => ({ username: r.username, name: r.name || "Unnamed member", role: r.type, designation: r.designation || null }));
}

/**
 * Public base URL for connector links: BASE_DOMAIN (production) or the request's host.
 * `public` is false for localhost / private addresses, where Claude cannot reach it.
 */
export function connectorBaseUrl(req) {
    const fromEnv = String(process.env.BASE_DOMAIN || "").trim().replace(/\/+$/, "");
    let base = fromEnv;
    if (!base) {
        const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
        const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
        base = host ? `${proto}://${host}` : "";
    }
    let isPublic = false;
    try {
        const u = new URL(base);
        const h = u.hostname;
        const privateHost = h === "localhost" || h.endsWith(".local") || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1\]?$)/.test(h);
        isPublic = u.protocol === "https:" && !privateHost;
    } catch (_) {
        isPublic = false;
    }
    return { base, endpoint: `${base}${MCP_PATH}`, public: isPublic };
}
