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
import { UNIQUE_RANDOM_STRING } from "../helpers/function.js";
import {
    createsLedgerGroupCycle,
    normalizeLedgerGroupInput,
} from "../helpers/ledgerGroupValidation.js";

const router = express.Router();
const baseGuards = [auth, validateBranch, checkSubscription, requireFeature("core")];
const mutationGuards = [...baseGuards, requirePermission("ledger_group_manage")];

function usernameFromRequest(req) {
    return String(req.headers["username"] || req.headers["Username"] || "").trim();
}

function errorResponse(res, error, fallback = "Ledger group operation failed") {
    if (error?.code === "ER_DUP_ENTRY") {
        return res.status(409).json({
            success: false,
            code: "LEDGER_GROUP_DUPLICATE",
            message: "A ledger group with this name already exists in this branch",
        });
    }

    console.error("Ledger group error:", error?.message || error);
    return res.status(error?.statusCode || 500).json({
        success: false,
        code: error?.code || "LEDGER_GROUP_ERROR",
        message: error?.publicMessage || fallback,
    });
}

async function recordAudit(conn, { branchId, username, eventType, entityId, metadata }) {
    await conn.query(
        `INSERT INTO audit_events
            (event_id, branch_id, actor_username, event_type, entity_type, entity_id, metadata)
         VALUES (?, ?, ?, ?, 'ledger_group', ?, ?)` ,
        [
            crypto.randomUUID(),
            branchId,
            username,
            eventType,
            entityId,
            JSON.stringify(metadata || {}),
        ]
    );
}

async function assertParent(conn, branchId, groupId, parentGroupId) {
    if (!parentGroupId) return;
    if (groupId && String(groupId) === String(parentGroupId)) {
        const error = new Error("A ledger group cannot be its own parent");
        error.statusCode = 400;
        error.publicMessage = error.message;
        error.code = "LEDGER_GROUP_SELF_PARENT";
        throw error;
    }

    const [rows] = await conn.query(
        `SELECT ledger_group_id, parent_group_id, status, is_deleted
         FROM ledger_groups
         WHERE ledger_group_id = ? AND branch_id = ?
         LIMIT 1`,
        [parentGroupId, branchId]
    );
    if (!rows.length || rows[0].is_deleted !== "0" || rows[0].status !== "1") {
        const error = new Error("Parent ledger group is invalid, inactive, or not in this branch");
        error.statusCode = 400;
        error.publicMessage = error.message;
        error.code = "LEDGER_GROUP_INVALID_PARENT";
        throw error;
    }

    if (!groupId) return;

    const [allGroups] = await conn.query(
        `SELECT ledger_group_id, parent_group_id
         FROM ledger_groups
         WHERE branch_id = ? AND is_deleted = '0'`,
        [branchId]
    );
    const groupMap = new Map(allGroups.map((row) => [row.ledger_group_id, row]));
    if (createsLedgerGroupCycle(groupMap, groupId, parentGroupId)) {
        const error = new Error("Parent ledger group would create a cycle");
        error.statusCode = 400;
        error.publicMessage = error.message;
        error.code = "LEDGER_GROUP_CYCLE";
        throw error;
    }
}

router.get("/list", ...baseGuards, requirePermission("finance_report"), async (req, res) => {
    try {
        const branchId = req.branch_id;
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
        const search = String(req.query.search || "").trim();
        const offset = (page - 1) * limit;
        const filters = ["branch_id = ?", "is_deleted = '0'"];
        const params = [branchId];

        if (search) {
            filters.push("(name LIKE ? OR ledger_group_id LIKE ?)");
            params.push(`%${search}%`, `%${search}%`);
        }

        const where = filters.join(" AND ");
        const [[countRow]] = await pool.query(
            `SELECT COUNT(*) AS total FROM ledger_groups WHERE ${where}`,
            params
        );
        const [rows] = await pool.query(
            `SELECT ledger_group_id, branch_id, parent_group_id, name, group_type,
                    normal_balance, status, is_system, create_by, modify_by,
                    create_date, modify_date
             FROM ledger_groups
             WHERE ${where}
             ORDER BY name ASC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        return res.json({
            success: true,
            data: rows,
            pagination: {
                page,
                limit,
                total: Number(countRow?.total || 0),
                total_pages: Math.ceil(Number(countRow?.total || 0) / limit),
            },
        });
    } catch (error) {
        return errorResponse(res, error, "Failed to fetch ledger groups");
    }
});

router.post("/create", ...mutationGuards, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const normalized = normalizeLedgerGroupInput(req.body);
        if (normalized.error) {
            return res.status(400).json({ success: false, code: "INVALID_LEDGER_GROUP", message: normalized.error });
        }

        const branchId = req.branch_id;
        const username = usernameFromRequest(req);
        const value = normalized.value;

        await conn.beginTransaction();
        await assertParent(conn, branchId, null, value.parent_group_id);
        const ledgerGroupId = await UNIQUE_RANDOM_STRING("ledger_groups", "ledger_group_id", {
            conn,
            prefix: "LG_",
        });
        await conn.query(
            `INSERT INTO ledger_groups
                (ledger_group_id, branch_id, parent_group_id, name, group_type,
                 normal_balance, create_by, modify_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [ledgerGroupId, branchId, value.parent_group_id, value.name, value.group_type, value.normal_balance, username, username]
        );
        await recordAudit(conn, {
            branchId,
            username,
            eventType: "ledger_group.created",
            entityId: ledgerGroupId,
            metadata: value,
        });
        await conn.commit();

        return res.status(201).json({ success: true, data: { ledger_group_id: ledgerGroupId, branch_id: branchId, ...value } });
    } catch (error) {
        await conn.rollback();
        return errorResponse(res, error, "Failed to create ledger group");
    } finally {
        conn.release();
    }
});

router.put("/update/:ledger_group_id", ...mutationGuards, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const ledgerGroupId = String(req.params.ledger_group_id || "").trim();
        if (!ledgerGroupId) return res.status(400).json({ success: false, message: "ledger_group_id is required" });
        const normalized = normalizeLedgerGroupInput(req.body);
        if (normalized.error) {
            return res.status(400).json({ success: false, code: "INVALID_LEDGER_GROUP", message: normalized.error });
        }

        const branchId = req.branch_id;
        const username = usernameFromRequest(req);
        const value = normalized.value;
        await conn.beginTransaction();
        const [existing] = await conn.query(
            `SELECT ledger_group_id, branch_id, parent_group_id, name, group_type, normal_balance, is_system
             FROM ledger_groups
             WHERE ledger_group_id = ? AND branch_id = ? AND is_deleted = '0'
             FOR UPDATE`,
            [ledgerGroupId, branchId]
        );
        if (!existing.length) {
            const error = new Error("Ledger group not found");
            error.statusCode = 404;
            error.publicMessage = error.message;
            error.code = "LEDGER_GROUP_NOT_FOUND";
            throw error;
        }
        if (existing[0].is_system === "1") {
            const error = new Error("System ledger groups cannot be edited");
            error.statusCode = 403;
            error.publicMessage = error.message;
            error.code = "LEDGER_GROUP_SYSTEM_LOCKED";
            throw error;
        }
        await assertParent(conn, branchId, ledgerGroupId, value.parent_group_id);
        await conn.query(
            `UPDATE ledger_groups
             SET parent_group_id = ?, name = ?, group_type = ?, normal_balance = ?, modify_by = ?
             WHERE ledger_group_id = ? AND branch_id = ? AND is_deleted = '0'`,
            [value.parent_group_id, value.name, value.group_type, value.normal_balance, username, ledgerGroupId, branchId]
        );
        await recordAudit(conn, {
            branchId,
            username,
            eventType: "ledger_group.updated",
            entityId: ledgerGroupId,
            metadata: { before: existing[0], after: value },
        });
        await conn.commit();

        return res.json({ success: true, data: { ledger_group_id: ledgerGroupId, branch_id: branchId, ...value } });
    } catch (error) {
        await conn.rollback();
        return errorResponse(res, error, "Failed to update ledger group");
    } finally {
        conn.release();
    }
});

router.delete("/delete/:ledger_group_id", ...mutationGuards, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const ledgerGroupId = String(req.params.ledger_group_id || "").trim();
        const branchId = req.branch_id;
        const username = usernameFromRequest(req);
        if (!ledgerGroupId) return res.status(400).json({ success: false, message: "ledger_group_id is required" });

        await conn.beginTransaction();
        const [existing] = await conn.query(
            `SELECT ledger_group_id, name, is_system
             FROM ledger_groups
             WHERE ledger_group_id = ? AND branch_id = ? AND is_deleted = '0'
             FOR UPDATE`,
            [ledgerGroupId, branchId]
        );
        if (!existing.length) {
            const error = new Error("Ledger group not found");
            error.statusCode = 404;
            error.publicMessage = error.message;
            error.code = "LEDGER_GROUP_NOT_FOUND";
            throw error;
        }
        if (existing[0].is_system === "1") {
            const error = new Error("System ledger groups cannot be deleted");
            error.statusCode = 403;
            error.publicMessage = error.message;
            error.code = "LEDGER_GROUP_SYSTEM_LOCKED";
            throw error;
        }

        const [children] = await conn.query(
            `SELECT ledger_group_id FROM ledger_groups
             WHERE parent_group_id = ? AND branch_id = ? AND is_deleted = '0'
             LIMIT 1`,
            [ledgerGroupId, branchId]
        );
        if (children.length) {
            const error = new Error("Ledger group cannot be deleted while it has child groups");
            error.statusCode = 409;
            error.publicMessage = error.message;
            error.code = "LEDGER_GROUP_HAS_CHILDREN";
            throw error;
        }

        await conn.query(
            `UPDATE ledger_groups
             SET is_deleted = '1', status = '0', modify_by = ?
             WHERE ledger_group_id = ? AND branch_id = ?`,
            [username, ledgerGroupId, branchId]
        );
        await recordAudit(conn, {
            branchId,
            username,
            eventType: "ledger_group.deleted",
            entityId: ledgerGroupId,
            metadata: { name: existing[0].name },
        });
        await conn.commit();

        return res.json({ success: true, data: { ledger_group_id: ledgerGroupId } });
    } catch (error) {
        await conn.rollback();
        return errorResponse(res, error, "Failed to delete ledger group");
    } finally {
        conn.release();
    }
});

export default router;
