import crypto from "crypto";
import express from "express";
import pool from "../db.js";
import {
    auth,
    validateBranch,
    checkSubscription,
    requireFeature,
} from "../middleware/auth.js";
import { requirePermission } from "../middleware/requirePermission.js";
import {
    AUTOMATION_POLICY_KEYS,
    DEFAULT_AUTOMATION_POLICIES,
    normalizeAutomationPolicies,
    normalizeAutomationScope,
} from "../helpers/automationPolicies.js";

const router = express.Router();
const baseGuards = [auth, validateBranch, checkSubscription, requireFeature("core")];
const readGuards = [...baseGuards, requirePermission("setting_view_edit")];
const writeGuards = [...baseGuards, requirePermission("automation_manage")];

function currentUsername(req) {
    return String(req.headers["username"] || req.headers["Username"] || "").trim();
}

function respondError(res, error, fallback) {
    console.error("Automation policy error:", error?.message || error);
    return res.status(error?.statusCode || 500).json({
        success: false,
        code: error?.code || "AUTOMATION_POLICY_ERROR",
        message: error?.publicMessage || fallback,
    });
}

async function resolveScope(conn, req) {
    const scope = normalizeAutomationScope({
        scopeType: req.body?.scope_type || req.query?.scope_type,
        scopeId: req.body?.scope_id || req.query?.scope_id,
        branchId: req.branch_id,
    });
    if (scope.error) {
        const error = new Error(scope.error);
        error.statusCode = 400;
        error.publicMessage = scope.error;
        error.code = "INVALID_AUTOMATION_SCOPE";
        throw error;
    }

    if (scope.value.scopeType === "client") {
        const [clients] = await conn.query(
            `SELECT username FROM clients
             WHERE username = ? AND branch_id = ? AND user_type = 'client'
               AND is_deleted = '0' AND status = '1'
             LIMIT 1`,
            [scope.value.scopeId, req.branch_id]
        );
        if (!clients.length) {
            const error = new Error("Client is not active in this branch");
            error.statusCode = 404;
            error.publicMessage = error.message;
            error.code = "AUTOMATION_CLIENT_NOT_FOUND";
            throw error;
        }
    }

    return scope.value;
}

async function recordAudit(conn, req, scope, before, after) {
    await conn.query(
        `INSERT INTO audit_events
            (event_id, branch_id, actor_username, event_type, entity_type, entity_id, metadata)
         VALUES (?, ?, ?, 'automation_policies.updated', 'automation_policy', ?, ?)`,
        [
            crypto.randomUUID(),
            req.branch_id,
            currentUsername(req),
            `${scope.scopeType}:${scope.scopeId}`,
            JSON.stringify({ before, after }),
        ]
    );
}

router.get("/", ...readGuards, async (req, res) => {
    try {
        const scope = await resolveScope(pool, req);
        const [rows] = await pool.query(
            `SELECT policy_key, enabled, config, modify_by, modify_date
             FROM automation_policies
             WHERE branch_id = ? AND scope_type = ? AND scope_id = ?`,
            [req.branch_id, scope.scopeType, scope.scopeId]
        );
        const policies = { ...DEFAULT_AUTOMATION_POLICIES };
        for (const row of rows) {
            if (AUTOMATION_POLICY_KEYS.includes(row.policy_key)) {
                policies[row.policy_key] = row.enabled === "1";
            }
        }
        return res.json({
            success: true,
            data: { scope_type: scope.scopeType, scope_id: scope.scopeId, policies },
        });
    } catch (error) {
        return respondError(res, error, "Failed to fetch automation policies");
    }
});

router.get("/clients", ...readGuards, async (req, res) => {
    try {
        const policyKey = String(req.query.policy_key || "").trim();
        if (!AUTOMATION_POLICY_KEYS.includes(policyKey)) {
            return res.status(400).json({
                success: false,
                code: "INVALID_AUTOMATION_POLICY",
                message: "A valid policy_key is required",
            });
        }

        const requestedPage = Number(req.query.page);
        const requestedLimit = Number(req.query.limit);
        const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
        const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
            ? Math.min(100, requestedLimit)
            : 50;
        const offset = (page - 1) * limit;
        const [countRows] = await pool.query(
            `SELECT COUNT(*) AS total
             FROM clients c
             WHERE c.branch_id = ? AND c.user_type = 'client'
               AND c.is_deleted = '0' AND c.status = '1'
               AND COALESCE((
                   SELECT ap.enabled FROM automation_policies ap
                   WHERE ap.branch_id = c.branch_id AND ap.scope_type = 'client'
                     AND ap.scope_id = c.username AND ap.policy_key = ?
                   LIMIT 1
               ), ?) = '1'`,
            [req.branch_id, policyKey, DEFAULT_AUTOMATION_POLICIES[policyKey] ? "1" : "0"]
        );
        const total = Number(countRows[0]?.total) || 0;
        const [clients] = await pool.query(
            `SELECT c.username, p.name, p.mobile, p.email
             FROM clients c
             LEFT JOIN profile p
               ON p.username = c.username
              AND p.id = (
                  SELECT MAX(p2.id) FROM profile p2 WHERE p2.username = c.username
              )
             WHERE c.branch_id = ? AND c.user_type = 'client'
               AND c.is_deleted = '0' AND c.status = '1'
               AND COALESCE((
                   SELECT ap.enabled FROM automation_policies ap
                   WHERE ap.branch_id = c.branch_id AND ap.scope_type = 'client'
                     AND ap.scope_id = c.username AND ap.policy_key = ?
                   LIMIT 1
               ), ?) = '1'
             ORDER BY p.name ASC, c.username ASC
             LIMIT ? OFFSET ?`,
            [req.branch_id, policyKey, DEFAULT_AUTOMATION_POLICIES[policyKey] ? "1" : "0", limit, offset]
        );

        return res.json({
            success: true,
            data: {
                clients,
                pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
            },
        });
    } catch (error) {
        return respondError(res, error, "Failed to fetch enabled automation clients");
    }
});

router.put("/", ...writeGuards, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const scope = await resolveScope(conn, req);
        const normalized = normalizeAutomationPolicies(req.body?.policies);
        if (normalized.error) {
            return res.status(400).json({
                success: false,
                code: "INVALID_AUTOMATION_POLICIES",
                message: normalized.error,
            });
        }

        await conn.beginTransaction();
        const [existing] = await conn.query(
            `SELECT policy_key, enabled
             FROM automation_policies
             WHERE branch_id = ? AND scope_type = ? AND scope_id = ?`,
            [req.branch_id, scope.scopeType, scope.scopeId]
        );
        const before = Object.fromEntries(existing.map((row) => [row.policy_key, row.enabled === "1"]));
        for (const [key, enabled] of Object.entries(normalized.value)) {
            await conn.query(
                `INSERT INTO automation_policies
                    (branch_id, scope_type, scope_id, policy_key, enabled, create_by, modify_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), modify_by = VALUES(modify_by), modify_date = CURRENT_TIMESTAMP`,
                [req.branch_id, scope.scopeType, scope.scopeId, key, enabled ? "1" : "0", currentUsername(req), currentUsername(req)]
            );
        }
        const after = { ...before, ...normalized.value };
        await recordAudit(conn, req, scope, before, after);
        await conn.commit();

        return res.json({
            success: true,
            data: { scope_type: scope.scopeType, scope_id: scope.scopeId, policies: after },
        });
    } catch (error) {
        await conn.rollback();
        return respondError(res, error, "Failed to save automation policies");
    } finally {
        conn.release();
    }
});

export default router;
