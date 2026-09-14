import express from "express";
import crypto from "crypto";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { fetchPermissionRoleById } from "../helpers/permissionRole.js";
import { CLIENT_LAST_PAYMENT_SQL } from "../helpers/clientBalanceSql.js";

const router = express.Router();

const MANAGE_PERM = "client_followup_manage";
const VIEW_PERM = "client_followup_view";

function requestUsername(req) {
    return String(req.headers["username"] || req.headers["Username"] || "").trim();
}

function parseUserPermissions(permissionsAssigned) {
    if (!permissionsAssigned) return [];
    try {
        const parsed =
            typeof permissionsAssigned === "string"
                ? JSON.parse(permissionsAssigned)
                : permissionsAssigned;
        if (parsed?.permissions && Array.isArray(parsed.permissions)) {
            return parsed.permissions;
        }
        if (Array.isArray(parsed)) return parsed;
    } catch (_) {}
    return [];
}

async function isBranchAdmin(username, branchId) {
    const [rows] = await pool.query(
        `SELECT id, type, permission_role_id FROM branch_mapping
         WHERE username = ? AND branch_id = ? AND is_deleted = '0'
         LIMIT 1`,
        [username, branchId]
    );
    if (!rows.length) return false;
    const row = rows[0];
    return row.type === "admin" || row.permission_role_id === "admin";
}

async function checkUserPermission(username, branchId, permissionKey) {
    if (!username || !branchId || !permissionKey) return false;
    try {
        const [mappings] = await pool.query(
            `SELECT type, permission_role_id, custom_permissions
             FROM branch_mapping
             WHERE username = ? AND branch_id = ? AND is_deleted = '0'
             LIMIT 1`,
            [username, branchId]
        );
        if (!mappings.length) return false;
        if (
            mappings[0].type === "admin" ||
            mappings[0].permission_role_id === "admin"
        ) {
            return true;
        }

        const [optCheck] = await pool.query(
            "SELECT id FROM permission_option WHERE p_option_id = ? AND status = '1' LIMIT 1",
            [permissionKey]
        );
        if (!optCheck.length) return false;

        const userMap = mappings[0];
        if (userMap.custom_permissions) {
            const customPerms = parseUserPermissions(userMap.custom_permissions);
            if (customPerms.includes(permissionKey)) return true;
        }
        if (userMap.permission_role_id) {
            const role = await fetchPermissionRoleById(
                pool,
                userMap.permission_role_id,
                branchId
            );
            if (role) {
                const rolePerms = parseUserPermissions(role.permissions_assigned);
                if (rolePerms.includes(permissionKey)) return true;
            }
        }
        return false;
    } catch (_) {
        return false;
    }
}

async function getFollowupAccess(username, branchId) {
    const admin = await isBranchAdmin(username, branchId);
    if (admin) {
        return { canView: true, canManage: true, isAdmin: true };
    }
    const [canManage, canView, hasOA] = await Promise.all([
        checkUserPermission(username, branchId, MANAGE_PERM),
        checkUserPermission(username, branchId, VIEW_PERM),
        checkUserPermission(username, branchId, "office_assistance_access"),
    ]);
    return {
        canView: Boolean(canView || canManage || hasOA),
        canManage: Boolean(canManage),
        isAdmin: false,
    };
}

function makeId(prefix) {
    return `${prefix}${crypto.randomBytes(8).toString("hex")}`;
}

function profileJoin(alias = "p") {
    return `LEFT JOIN profile ${alias}
              ON ${alias}.username = c.username
             AND ${alias}.status = '1'
             AND ${alias}.id = (
                  SELECT MAX(p2.id) FROM profile p2
                  WHERE p2.username = c.username AND p2.status = '1'
             )`;
}

function staffProfileJoin(alias = "sp", staffCol = "a.staff_username") {
    return `LEFT JOIN profile ${alias}
              ON ${alias}.username = ${staffCol}
             AND ${alias}.status = '1'
             AND ${alias}.id = (
                  SELECT MAX(p3.id) FROM profile p3
                  WHERE p3.username = ${staffCol} AND p3.status = '1'
             )`;
}

/** Clients with positive outstanding balance (debtors). */
function debtorJoinSql() {
    return `INNER JOIN (
        SELECT party_id AS username,
               COALESCE(SUM(debit), 0) - COALESCE(SUM(credit), 0) AS balance
        FROM (
            SELECT party2_id AS party_id, ABS(amount) AS debit, 0 AS credit
            FROM transactions
            WHERE branch_id = ?
              AND party2_type = 'client'
            UNION ALL
            SELECT party1_id AS party_id, 0 AS debit, ABS(amount) AS credit
            FROM transactions
            WHERE branch_id = ?
              AND party1_type = 'client'
        ) t
        GROUP BY party_id
        HAVING balance > 0
    ) debtor ON debtor.username = c.username`;
}

function lastPaymentJoinSql() {
    return `LEFT JOIN (${CLIENT_LAST_PAYMENT_SQL}) lp ON lp.party_id = c.username`;
}

/** Param order: debtor×2, lastPayment×1, c.branch_id, then filters. */
function buildDebtorFollowupScope({
    branch_id,
    viewerUsername,
    canManage,
    filter: rawFilter,
    search,
    staffFilter,
    reminderFrom,
    reminderTo,
}) {
    let filter = String(rawFilter || "all").trim().toLowerCase();
    if (!canManage) filter = "mine";

    const whereParts = [
        "c.user_type = 'client'",
        "c.is_deleted = '0'",
        "c.branch_id = ?",
        "c.status = '1'",
    ];
    const params = [branch_id, branch_id, branch_id, branch_id];

    if (filter === "mine") {
        whereParts.push("a.staff_username = ?");
        params.push(viewerUsername);
    } else if (filter === "assigned") {
        whereParts.push("a.staff_username IS NOT NULL");
    } else if (filter === "unassigned") {
        whereParts.push("a.staff_username IS NULL");
    }

    if (canManage && staffFilter) {
        whereParts.push("a.staff_username = ?");
        params.push(staffFilter);
    }

    const fromDate =
        reminderFrom != null && String(reminderFrom).trim()
            ? String(reminderFrom).trim().slice(0, 10)
            : "";
    const toDate =
        reminderTo != null && String(reminderTo).trim()
            ? String(reminderTo).trim().slice(0, 10)
            : "";
    if (fromDate || toDate) {
        whereParts.push(`EXISTS (
            SELECT 1
            FROM client_followup_notes nr
            WHERE nr.branch_id = c.branch_id
              AND nr.client_username = c.username
              AND nr.is_deleted = '0'
              AND nr.reminder_at IS NOT NULL
              ${fromDate ? "AND DATE(nr.reminder_at) >= ?" : ""}
              ${toDate ? "AND DATE(nr.reminder_at) <= ?" : ""}
        )`);
        if (fromDate) params.push(fromDate);
        if (toDate) params.push(toDate);
    }

    const searchTerm = search != null ? String(search).trim() : "";
    if (searchTerm) {
        const like = `%${searchTerm}%`;
        whereParts.push(`(
            c.username LIKE ?
            OR p.name LIKE ?
            OR p.mobile LIKE ?
            OR p.email LIKE ?
            OR p.pan_number LIKE ?
            OR a.staff_username LIKE ?
            OR sp.name LIKE ?
            OR sp.mobile LIKE ?
            OR EXISTS (
                SELECT 1 FROM firms f
                WHERE f.username = c.username
                  AND f.branch_id = c.branch_id
                  AND f.is_deleted = '0'
                  AND IFNULL(f.firm_name, '') LIKE ?
            )
        )`);
        params.push(like, like, like, like, like, like, like, like, like);
    }

    const fromSql = `
        FROM clients c
        ${profileJoin("p")}
        ${debtorJoinSql()}
        ${lastPaymentJoinSql()}
        LEFT JOIN client_followup_assignments a
          ON a.branch_id = c.branch_id
         AND a.client_username = c.username
        ${staffProfileJoin("sp", "a.staff_username")}
        WHERE ${whereParts.join(" AND ")}
    `;

    return { fromSql, params, filter };
}

async function resolveFollowupClientUsernames(branch_id, viewerUsername, access, body) {
    const isAll = Boolean(body?.is_all);
    if (isAll) {
        if (!access.canManage) {
            const err = new Error("Permission denied for bulk selection");
            err.status = 403;
            throw err;
        }
        const { fromSql, params } = buildDebtorFollowupScope({
            branch_id,
            viewerUsername,
            canManage: true,
            filter: body?.filter || "all",
            search: body?.search || "",
            staffFilter: body?.scope_staff_username || "",
            reminderFrom: body?.reminder_from || "",
            reminderTo: body?.reminder_to || "",
        });
        const [rows] = await pool.query(
            `SELECT c.username AS client_username ${fromSql}`,
            params
        );
        return rows.map((r) => r.client_username).filter(Boolean);
    }

    let clients = body?.client_usernames;
    if (typeof clients === "string") clients = [clients];
    if (!Array.isArray(clients) || !clients.length) {
        const err = new Error("Select at least one client");
        err.status = 400;
        throw err;
    }
    return [...new Set(clients.map((c) => String(c || "").trim()).filter(Boolean))];
}

function mapFollowupClientRow(row) {
    const lastDate = row.last_payment_date || null;
    let period = "No payment";
    let daysAgo = null;
    if (lastDate) {
        daysAgo = Number(row.days_since_last_payment);
        if (Number.isNaN(daysAgo)) daysAgo = null;
        if (daysAgo != null) {
            if (daysAgo <= 1) period = "Today";
            else if (daysAgo <= 7) period = "Last 7 days";
            else if (daysAgo <= 30) period = "Last 30 days";
            else if (daysAgo <= 90) period = "Last 90 days";
            else period = "90+ days";
        }
    }

    return {
        client_username: row.client_username,
        username: row.client_username,
        client_status: row.client_status,
        client_name: row.client_name,
        name: row.client_name,
        guardian_name: row.guardian_name || "",
        mobile: row.mobile || "",
        country_code: row.country_code || "",
        email: row.email || "",
        pan_number: row.pan_number || "",
        balance: Number(row.balance) || 0,
        assignment_id: row.assignment_id || null,
        staff_username: row.staff_username || null,
        staff_name: row.staff_name || null,
        staff_mobile: row.staff_mobile || null,
        staff_country_code: row.staff_country_code || null,
        assignment_remark: row.assignment_remark || null,
        assigned_at: row.assigned_at || null,
        notes_count: Number(row.notes_count) || 0,
        last_note_id: row.last_note_id || null,
        last_note_text: row.last_note_text || "",
        last_note_reminder_at: row.last_note_reminder_at || null,
        last_note_status: row.last_note_status || null,
        next_reminder_at: row.next_reminder_at || null,
        overdue_reminders: Number(row.overdue_reminders) || 0,
        last_transaction: {
            date: lastDate,
            days_ago: daysAgo,
            period,
        },
    };
}

/**
 * GET /assistance/followup/access
 */
router.get("/followup/access", auth, validateBranch, async (req, res) => {
    try {
        const access = await getFollowupAccess(requestUsername(req), req.branch_id);
        return res.json({ success: true, data: access });
    } catch (error) {
        console.error("followup access error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to resolve follow-up access",
        });
    }
});

/**
 * GET /assistance/followup/clients
 * Query: search, page, limit, filter=all|assigned|unassigned|mine, staff_username
 */
router.get("/followup/clients", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = requestUsername(req);
        const access = await getFollowupAccess(username, branch_id);
        if (!access.canView) {
            return res.status(403).json({
                success: false,
                message: "You do not have permission to view follow-up clients",
            });
        }

        const pageNum = Math.max(1, Number(req.query.page) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
        const offset = (pageNum - 1) * limitNum;
        const searchTerm = req.query.search != null ? String(req.query.search).trim() : "";
        const staffFilter =
            req.query.staff_username != null
                ? String(req.query.staff_username).trim()
                : "";
        const reminderFrom =
            req.query.reminder_from != null
                ? String(req.query.reminder_from).trim()
                : "";
        const reminderTo =
            req.query.reminder_to != null
                ? String(req.query.reminder_to).trim()
                : "";

        const { fromSql, params, filter } = buildDebtorFollowupScope({
            branch_id,
            viewerUsername: username,
            canManage: access.canManage,
            filter: req.query.filter || "all",
            search: searchTerm,
            staffFilter,
            reminderFrom,
            reminderTo,
        });

        const [countRows] = await pool.query(
            `SELECT COUNT(*) AS total ${fromSql}`,
            params
        );
        const total = Number(countRows[0]?.total) || 0;

        const [rows] = await pool.query(
            `SELECT
                c.username AS client_username,
                c.status AS client_status,
                COALESCE(
                  NULLIF(TRIM(p.name), ''),
                  (
                    SELECT f.firm_name
                    FROM firms f
                    WHERE f.username = c.username
                      AND f.branch_id = c.branch_id
                      AND (f.is_deleted = '0' OR f.is_deleted = 0)
                    ORDER BY f.id DESC
                    LIMIT 1
                  ),
                  c.username
                ) AS client_name,
                p.guardian_name,
                p.mobile,
                p.country_code,
                p.email,
                p.pan_number,
                debtor.balance AS balance,
                a.assignment_id,
                a.staff_username,
                sp.name AS staff_name,
                sp.mobile AS staff_mobile,
                sp.country_code AS staff_country_code,
                a.remark AS assignment_remark,
                a.modify_date AS assigned_at,
                lp.last_payment_date,
                DATEDIFF(CURDATE(), lp.last_payment_date) AS days_since_last_payment,
                (
                  SELECT COUNT(*)
                  FROM client_followup_notes n
                  WHERE n.branch_id = c.branch_id
                    AND n.client_username = c.username
                    AND n.is_deleted = '0'
                ) AS notes_count,
                (
                  SELECT n0.note_id
                  FROM client_followup_notes n0
                  WHERE n0.branch_id = c.branch_id
                    AND n0.client_username = c.username
                    AND n0.is_deleted = '0'
                  ORDER BY n0.modify_date DESC, n0.id DESC
                  LIMIT 1
                ) AS last_note_id,
                (
                  SELECT COALESCE(NULLIF(TRIM(n0.subject), ''), NULLIF(TRIM(n0.note), ''), '')
                  FROM client_followup_notes n0
                  WHERE n0.branch_id = c.branch_id
                    AND n0.client_username = c.username
                    AND n0.is_deleted = '0'
                  ORDER BY n0.modify_date DESC, n0.id DESC
                  LIMIT 1
                ) AS last_note_text,
                (
                  SELECT n0.reminder_at
                  FROM client_followup_notes n0
                  WHERE n0.branch_id = c.branch_id
                    AND n0.client_username = c.username
                    AND n0.is_deleted = '0'
                  ORDER BY n0.modify_date DESC, n0.id DESC
                  LIMIT 1
                ) AS last_note_reminder_at,
                (
                  SELECT n0.status
                  FROM client_followup_notes n0
                  WHERE n0.branch_id = c.branch_id
                    AND n0.client_username = c.username
                    AND n0.is_deleted = '0'
                  ORDER BY n0.modify_date DESC, n0.id DESC
                  LIMIT 1
                ) AS last_note_status,
                (
                  SELECT MIN(n2.reminder_at)
                  FROM client_followup_notes n2
                  WHERE n2.branch_id = c.branch_id
                    AND n2.client_username = c.username
                    AND n2.is_deleted = '0'
                    AND n2.status = 'open'
                    AND n2.reminder_at IS NOT NULL
                    AND n2.reminder_at >= NOW()
                ) AS next_reminder_at,
                (
                  SELECT COUNT(*)
                  FROM client_followup_notes n3
                  WHERE n3.branch_id = c.branch_id
                    AND n3.client_username = c.username
                    AND n3.is_deleted = '0'
                    AND n3.status = 'open'
                    AND n3.reminder_at IS NOT NULL
                    AND n3.reminder_at < NOW()
                ) AS overdue_reminders
             ${fromSql}
             ORDER BY
                CASE WHEN a.staff_username IS NULL THEN 0 ELSE 1 END ASC,
                debtor.balance DESC,
                client_name ASC,
                c.username ASC
             LIMIT ? OFFSET ?`,
            [...params, limitNum, offset]
        );

        const debtorSummaryFrom = `
            FROM clients c
            ${debtorJoinSql()}
            LEFT JOIN client_followup_assignments a
              ON a.branch_id = c.branch_id AND a.client_username = c.username
            WHERE c.user_type = 'client'
              AND c.is_deleted = '0'
              AND c.branch_id = ?
              AND c.status = '1'
        `;

        const [summaryRows] = access.canManage
            ? await pool.query(
                  `SELECT
                      COUNT(*) AS total_clients,
                      SUM(CASE WHEN a.staff_username IS NULL THEN 1 ELSE 0 END) AS unassigned,
                      SUM(CASE WHEN a.staff_username IS NOT NULL THEN 1 ELSE 0 END) AS assigned,
                      SUM(CASE WHEN a.staff_username = ? THEN 1 ELSE 0 END) AS mine
                   ${debtorSummaryFrom}`,
                  [username, branch_id, branch_id, branch_id]
              )
            : await pool.query(
                  `SELECT
                      COUNT(*) AS total_clients,
                      0 AS unassigned,
                      COUNT(*) AS assigned,
                      COUNT(*) AS mine
                   ${debtorSummaryFrom}
                     AND a.staff_username = ?`,
                  [branch_id, branch_id, branch_id, username]
              );

        return res.json({
            success: true,
            data: rows.map(mapFollowupClientRow),
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                total_pages: Math.max(1, Math.ceil(total / limitNum) || 1),
                is_last_page: pageNum * limitNum >= total,
            },
            meta: {
                can_manage: access.canManage,
                filter,
                summary: {
                    total_clients: Number(summaryRows[0]?.total_clients) || 0,
                    unassigned: Number(summaryRows[0]?.unassigned) || 0,
                    assigned: Number(summaryRows[0]?.assigned) || 0,
                    mine: Number(summaryRows[0]?.mine) || 0,
                },
            },
        });
    } catch (error) {
        console.error("followup clients list error:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to load follow-up clients",
        });
    }
});

/**
 * GET /assistance/followup/assignees?search=
 * Active branch staff + admin for assign modal.
 */
router.get("/followup/assignees", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = requestUsername(req);
        const access = await getFollowupAccess(username, branch_id);
        if (!access.canManage) {
            return res.status(403).json({
                success: false,
                message: "You do not have permission to manage follow-up assignments",
            });
        }

        const searchTerm = req.query.search != null ? String(req.query.search).trim() : "";
        const params = [branch_id];
        let searchSql = "";
        if (searchTerm) {
            const like = `%${searchTerm}%`;
            searchSql = ` AND (
                bm.username LIKE ?
                OR p.name LIKE ?
                OR p.mobile LIKE ?
            )`;
            params.push(like, like, like);
        }

        const [rows] = await pool.query(
            `SELECT
                bm.username,
                bm.type,
                COALESCE(NULLIF(TRIM(p.name), ''), bm.username) AS name,
                p.mobile,
                p.country_code
             FROM branch_mapping bm
             INNER JOIN users u
               ON u.username = bm.username
              AND (u.status = '1' OR u.status = 1)
             INNER JOIN profile p
               ON p.username = bm.username
              AND (p.status = '1' OR p.status = 1)
              AND p.id = (
                    SELECT MAX(p2.id) FROM profile p2
                    WHERE p2.username = bm.username
                      AND (p2.status = '1' OR p2.status = 1)
              )
             WHERE bm.branch_id = ?
               AND (bm.is_deleted = '0' OR bm.is_deleted = 0)
               AND (bm.status = '1' OR bm.status = 1)
               AND bm.type IN ('staff', 'admin')
               ${searchSql}
             ORDER BY
               CASE WHEN bm.type = 'admin' THEN 0 ELSE 1 END ASC,
               name ASC,
               bm.username ASC
             LIMIT 100`,
            params
        );

        return res.json({
            success: true,
            data: rows.map((row) => ({
                username: row.username,
                name: row.name,
                mobile: row.mobile || "",
                country_code: row.country_code || "",
                type: row.type,
            })),
        });
    } catch (error) {
        console.error("followup assignees error:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to load assignees",
        });
    }
});

/**
 * POST /assistance/followup/assign
 * Body: { client_usernames?: string[], is_all?, filter?, search?, staff_username, remark? }
 */
router.post("/followup/assign", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = requestUsername(req);
        const access = await getFollowupAccess(username, branch_id);
        if (!access.canManage) {
            return res.status(403).json({
                success: false,
                message: "You do not have permission to manage follow-up assignments",
            });
        }

        const staff_username = String(req.body?.staff_username || "").trim();
        const remark =
            req.body?.remark != null ? String(req.body.remark).trim().slice(0, 255) : null;
        if (!staff_username) {
            return res.status(400).json({
                success: false,
                message: "Select a staff member",
            });
        }

        let clientList;
        try {
            clientList = await resolveFollowupClientUsernames(
                branch_id,
                username,
                access,
                req.body || {}
            );
        } catch (resolveErr) {
            return res.status(resolveErr.status || 400).json({
                success: false,
                message: resolveErr.message || "Select at least one client",
            });
        }
        if (!clientList.length) {
            return res.status(400).json({
                success: false,
                message: "Select at least one client",
            });
        }

        const [staffRows] = await pool.query(
            `SELECT bm.username, bm.type
             FROM branch_mapping bm
             INNER JOIN users u
               ON u.username = bm.username
              AND (u.status = '1' OR u.status = 1)
             WHERE bm.username = ? AND bm.branch_id = ?
               AND (bm.is_deleted = '0' OR bm.is_deleted = 0)
               AND (bm.status = '1' OR bm.status = 1)
               AND bm.type IN ('staff', 'admin')
             LIMIT 1`,
            [staff_username, branch_id]
        );
        if (!staffRows.length) {
            return res.status(404).json({
                success: false,
                message: "Active assignee not found in this branch",
            });
        }

        const placeholders = clientList.map(() => "?").join(",");
        const [validClients] = await pool.query(
            `SELECT username FROM clients
             WHERE branch_id = ? AND user_type = 'client' AND is_deleted = '0'
               AND username IN (${placeholders})`,
            [branch_id, ...clientList]
        );
        const validSet = new Set(validClients.map((r) => r.username));
        const toAssign = clientList.filter((c) => validSet.has(c));
        if (!toAssign.length) {
            return res.status(404).json({
                success: false,
                message: "No valid clients found",
            });
        }

        let assigned = 0;
        for (const client_username of toAssign) {
            const assignment_id = makeId("CFA");
            await pool.query(
                `INSERT INTO client_followup_assignments
                   (assignment_id, branch_id, client_username, staff_username, remark, create_by, modify_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                   staff_username = VALUES(staff_username),
                   remark = VALUES(remark),
                   modify_by = VALUES(modify_by),
                   modify_date = NOW()`,
                [
                    assignment_id,
                    branch_id,
                    client_username,
                    staff_username,
                    remark,
                    username,
                    username,
                ]
            );
            assigned += 1;
        }

        return res.json({
            success: true,
            message: `Assigned ${assigned} client${assigned === 1 ? "" : "s"}`,
            data: { assigned, staff_username },
        });
    } catch (error) {
        console.error("followup assign error:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to assign clients",
        });
    }
});

/**
 * POST /assistance/followup/unassign
 * Body: { client_usernames?: string[], is_all?, filter?, search? }
 */
router.post("/followup/unassign", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = requestUsername(req);
        const access = await getFollowupAccess(username, branch_id);
        if (!access.canManage) {
            return res.status(403).json({
                success: false,
                message: "You do not have permission to manage follow-up assignments",
            });
        }

        let clientList;
        try {
            clientList = await resolveFollowupClientUsernames(
                branch_id,
                username,
                access,
                req.body || {}
            );
        } catch (resolveErr) {
            return res.status(resolveErr.status || 400).json({
                success: false,
                message: resolveErr.message || "Select at least one client",
            });
        }
        if (!clientList.length) {
            return res.status(400).json({
                success: false,
                message: "Select at least one client",
            });
        }

        const placeholders = clientList.map(() => "?").join(",");
        const [result] = await pool.query(
            `DELETE FROM client_followup_assignments
             WHERE branch_id = ? AND client_username IN (${placeholders})`,
            [branch_id, ...clientList]
        );

        return res.json({
            success: true,
            message: "Assignment cleared",
            data: { removed: result.affectedRows || 0 },
        });
    } catch (error) {
        console.error("followup unassign error:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to unassign clients",
        });
    }
});

async function assertClientNoteAccess(username, branch_id, client_username, access) {
    const [clientRows] = await pool.query(
        `SELECT username FROM clients
         WHERE username = ? AND branch_id = ? AND user_type = 'client' AND is_deleted = '0'
         LIMIT 1`,
        [client_username, branch_id]
    );
    if (!clientRows.length) {
        const err = new Error("Client not found");
        err.status = 404;
        throw err;
    }
    if (access.canManage) return true;

    const [asg] = await pool.query(
        `SELECT id FROM client_followup_assignments
         WHERE branch_id = ? AND client_username = ? AND staff_username = ?
         LIMIT 1`,
        [branch_id, client_username, username]
    );
    if (!asg.length) {
        const err = new Error("You are not assigned to this client");
        err.status = 403;
        throw err;
    }
    return true;
}

/**
 * GET /assistance/followup/notes?client_username=
 */
router.get("/followup/notes", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = requestUsername(req);
        const access = await getFollowupAccess(username, branch_id);
        if (!access.canView) {
            return res.status(403).json({ success: false, message: "Permission denied" });
        }
        const client_username = String(req.query.client_username || "").trim();
        if (!client_username) {
            return res.status(400).json({
                success: false,
                message: "client_username is required",
            });
        }
        await assertClientNoteAccess(username, branch_id, client_username, access);

        const [rows] = await pool.query(
            `SELECT
                n.note_id,
                n.client_username,
                n.subject,
                n.note,
                n.priority,
                n.status,
                n.reminder_at,
                n.create_by,
                n.create_date,
                n.modify_by,
                n.modify_date,
                cp.name AS create_by_name
             FROM client_followup_notes n
             LEFT JOIN profile cp
               ON cp.username = n.create_by
              AND cp.id = (SELECT MAX(p2.id) FROM profile p2 WHERE p2.username = n.create_by)
             WHERE n.branch_id = ?
               AND n.client_username = ?
               AND n.is_deleted = '0'
             ORDER BY
               CASE WHEN n.status = 'open' THEN 0 ELSE 1 END,
               CASE WHEN n.reminder_at IS NULL THEN 1 ELSE 0 END,
               n.reminder_at ASC,
               n.id DESC`,
            [branch_id, client_username]
        );

        return res.json({ success: true, data: rows });
    } catch (error) {
        console.error("followup notes list error:", error);
        return res.status(error.status || 500).json({
            success: false,
            message: error.message || "Failed to load notes",
        });
    }
});

/**
 * POST /assistance/followup/notes
 */
router.post("/followup/notes", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = requestUsername(req);
        const access = await getFollowupAccess(username, branch_id);
        if (!access.canView) {
            return res.status(403).json({ success: false, message: "Permission denied" });
        }

        const client_username = String(req.body?.client_username || "").trim();
        const subject = String(req.body?.subject || "").trim().slice(0, 255);
        const note = String(req.body?.note || "").trim();
        const priority = ["low", "medium", "high"].includes(
            String(req.body?.priority || "").toLowerCase()
        )
            ? String(req.body.priority).toLowerCase()
            : "medium";
        const status = ["open", "done", "cancelled"].includes(
            String(req.body?.status || "").toLowerCase()
        )
            ? String(req.body.status).toLowerCase()
            : "open";
        let reminder_at = req.body?.reminder_at || null;
        if (reminder_at) {
            const d = new Date(reminder_at);
            reminder_at = Number.isNaN(d.getTime()) ? null : d;
        }

        if (!client_username) {
            return res.status(400).json({
                success: false,
                message: "client_username is required",
            });
        }
        if (!subject && !note) {
            return res.status(400).json({
                success: false,
                message: "Enter a subject or note",
            });
        }

        await assertClientNoteAccess(username, branch_id, client_username, access);

        const note_id = makeId("CFN");
        await pool.query(
            `INSERT INTO client_followup_notes
               (note_id, branch_id, client_username, subject, note, priority, status, reminder_at, create_by, modify_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                note_id,
                branch_id,
                client_username,
                subject || null,
                note || null,
                priority,
                status,
                reminder_at,
                username,
                username,
            ]
        );

        const [rows] = await pool.query(
            `SELECT * FROM client_followup_notes WHERE note_id = ? LIMIT 1`,
            [note_id]
        );

        return res.json({
            success: true,
            message: "Note added",
            data: rows[0] || { note_id },
        });
    } catch (error) {
        console.error("followup note create error:", error);
        return res.status(error.status || 500).json({
            success: false,
            message: error.message || "Failed to create note",
        });
    }
});

/**
 * PUT /assistance/followup/notes/:note_id
 */
router.put("/followup/notes/:note_id", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = requestUsername(req);
        const access = await getFollowupAccess(username, branch_id);
        if (!access.canView) {
            return res.status(403).json({ success: false, message: "Permission denied" });
        }
        const note_id = String(req.params.note_id || "").trim();
        const [existing] = await pool.query(
            `SELECT * FROM client_followup_notes
             WHERE note_id = ? AND branch_id = ? AND is_deleted = '0' LIMIT 1`,
            [note_id, branch_id]
        );
        if (!existing.length) {
            return res.status(404).json({ success: false, message: "Note not found" });
        }
        await assertClientNoteAccess(
            username,
            branch_id,
            existing[0].client_username,
            access
        );

        const subject =
            req.body?.subject != null
                ? String(req.body.subject).trim().slice(0, 255)
                : existing[0].subject;
        const note =
            req.body?.note != null ? String(req.body.note).trim() : existing[0].note;
        const priority = ["low", "medium", "high"].includes(
            String(req.body?.priority || "").toLowerCase()
        )
            ? String(req.body.priority).toLowerCase()
            : existing[0].priority;
        const status = ["open", "done", "cancelled"].includes(
            String(req.body?.status || "").toLowerCase()
        )
            ? String(req.body.status).toLowerCase()
            : existing[0].status;

        let reminder_at = existing[0].reminder_at;
        if (Object.prototype.hasOwnProperty.call(req.body || {}, "reminder_at")) {
            if (!req.body.reminder_at) {
                reminder_at = null;
            } else {
                const d = new Date(req.body.reminder_at);
                reminder_at = Number.isNaN(d.getTime()) ? null : d;
            }
        }

        await pool.query(
            `UPDATE client_followup_notes
             SET subject = ?, note = ?, priority = ?, status = ?, reminder_at = ?,
                 modify_by = ?, modify_date = NOW()
             WHERE note_id = ? AND branch_id = ?`,
            [
                subject || null,
                note || null,
                priority,
                status,
                reminder_at,
                username,
                note_id,
                branch_id,
            ]
        );

        return res.json({ success: true, message: "Note updated" });
    } catch (error) {
        console.error("followup note update error:", error);
        return res.status(error.status || 500).json({
            success: false,
            message: error.message || "Failed to update note",
        });
    }
});

/**
 * DELETE /assistance/followup/notes/:note_id
 */
router.delete("/followup/notes/:note_id", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = requestUsername(req);
        const access = await getFollowupAccess(username, branch_id);
        if (!access.canView) {
            return res.status(403).json({ success: false, message: "Permission denied" });
        }
        const note_id = String(req.params.note_id || "").trim();
        const [existing] = await pool.query(
            `SELECT * FROM client_followup_notes
             WHERE note_id = ? AND branch_id = ? AND is_deleted = '0' LIMIT 1`,
            [note_id, branch_id]
        );
        if (!existing.length) {
            return res.status(404).json({ success: false, message: "Note not found" });
        }
        await assertClientNoteAccess(
            username,
            branch_id,
            existing[0].client_username,
            access
        );

        await pool.query(
            `UPDATE client_followup_notes
             SET is_deleted = '1', modify_by = ?, modify_date = NOW()
             WHERE note_id = ? AND branch_id = ?`,
            [username, note_id, branch_id]
        );

        return res.json({ success: true, message: "Note deleted" });
    } catch (error) {
        console.error("followup note delete error:", error);
        return res.status(error.status || 500).json({
            success: false,
            message: error.message || "Failed to delete note",
        });
    }
});

export default router;
