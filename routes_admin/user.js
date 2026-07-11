import express from "express";
import pool from "../db.js";
import { authAdmin } from "../middleware/authAdmin.js";
import { FORMAT_DATE } from "../helpers/function.js";
import { buildProfileImageUrl } from "../helpers/mediaUrl.js";

const router = express.Router();

const num = (value) => Number(value) || 0;

function emptyStatistics() {
    return {
        branches: { total: 0, active: 0 },
        clients: { total: 0, active: 0 },
        ca: { total: 0, active: 0 },
        agent: { total: 0, active: 0 },
        employees: { total: 0, active: 0, accepted: 0, pending: 0 },
        tasks: {
            total: 0,
            complete: 0,
            cancel: 0,
            pending_from_department: 0,
            pending_from_client: 0,
            in_process: 0,
        },
        firms: { total: 0, active: 0 },
    };
}

async function fetchUserStatistics(branchIds, branchCount = 0, activeBranchCount = 0) {
    if (!branchIds.length) {
        return emptyStatistics();
    }

    const placeholders = branchIds.map(() => "?").join(", ");

    const [[clientStats]] = await pool.query(
        `SELECT
            COALESCE(SUM(CASE WHEN user_type = 'client' THEN 1 ELSE 0 END), 0) AS clients_total,
            COALESCE(SUM(CASE WHEN user_type = 'client' AND status = '1' THEN 1 ELSE 0 END), 0) AS clients_active,
            COALESCE(SUM(CASE WHEN user_type = 'ca' THEN 1 ELSE 0 END), 0) AS ca_total,
            COALESCE(SUM(CASE WHEN user_type = 'ca' AND status = '1' THEN 1 ELSE 0 END), 0) AS ca_active,
            COALESCE(SUM(CASE WHEN user_type = 'agent' THEN 1 ELSE 0 END), 0) AS agent_total,
            COALESCE(SUM(CASE WHEN user_type = 'agent' AND status = '1' THEN 1 ELSE 0 END), 0) AS agent_active
        FROM clients
        WHERE branch_id IN (${placeholders})
          AND is_deleted = '0'`,
        branchIds
    );

    const [[employeeStats]] = await pool.query(
        `SELECT
            COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = '1' THEN 1 ELSE 0 END), 0) AS active,
            COALESCE(SUM(CASE WHEN is_accepted = '1' THEN 1 ELSE 0 END), 0) AS accepted,
            COALESCE(SUM(CASE WHEN is_accepted = '0' THEN 1 ELSE 0 END), 0) AS pending
        FROM branch_mapping
        WHERE branch_id IN (${placeholders})
          AND type = 'staff'
          AND is_deleted = '0'`,
        branchIds
    );

    const [[taskStats]] = await pool.query(
        `SELECT
            COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END), 0) AS complete_cnt,
            COALESCE(SUM(CASE WHEN status = 'cancel' THEN 1 ELSE 0 END), 0) AS cancel_cnt,
            COALESCE(SUM(CASE WHEN status = 'pending from department' THEN 1 ELSE 0 END), 0) AS pending_from_department_cnt,
            COALESCE(SUM(CASE WHEN status = 'pending from client' THEN 1 ELSE 0 END), 0) AS pending_from_client_cnt,
            COALESCE(SUM(CASE WHEN status = 'in process' THEN 1 ELSE 0 END), 0) AS in_process_cnt
        FROM tasks
        WHERE branch_id IN (${placeholders})`,
        branchIds
    );

    const [[firmStats]] = await pool.query(
        `SELECT
            COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = '1' THEN 1 ELSE 0 END), 0) AS active
        FROM firms
        WHERE branch_id IN (${placeholders})
          AND is_deleted = '0'`,
        branchIds
    );

    return {
        branches: {
            total: branchCount,
            active: activeBranchCount,
        },
        clients: {
            total: num(clientStats?.clients_total),
            active: num(clientStats?.clients_active),
        },
        ca: {
            total: num(clientStats?.ca_total),
            active: num(clientStats?.ca_active),
        },
        agent: {
            total: num(clientStats?.agent_total),
            active: num(clientStats?.agent_active),
        },
        employees: {
            total: num(employeeStats?.total),
            active: num(employeeStats?.active),
            accepted: num(employeeStats?.accepted),
            pending: num(employeeStats?.pending),
        },
        tasks: {
            total: num(taskStats?.total),
            complete: num(taskStats?.complete_cnt),
            cancel: num(taskStats?.cancel_cnt),
            pending_from_department: num(taskStats?.pending_from_department_cnt),
            pending_from_client: num(taskStats?.pending_from_client_cnt),
            in_process: num(taskStats?.in_process_cnt),
        },
        firms: {
            total: num(firmStats?.total),
            active: num(firmStats?.active),
        },
    };
}

function buildSearchClause(search) {
    if (!search) {
        return { sql: "", params: [] };
    }

    const sp = `%${search}%`;

    const sql = ` AND (
        u.username LIKE ?
        OR u.login_id LIKE ?
        OR u.remark LIKE ?
        OR p.name LIKE ?
        OR p.mobile LIKE ?
        OR p.email LIKE ?
        OR p.pan_number LIKE ?
        OR p.city LIKE ?
        OR p.state LIKE ?
        OR EXISTS (
            SELECT 1
            FROM branch_list bl
            WHERE bl.username = u.username
              AND bl.is_deleted = '0'
              AND (
                  bl.name LIKE ?
                  OR bl.branch_id LIKE ?
                  OR bl.pan LIKE ?
                  OR bl.gst LIKE ?
                  OR bl.mobile_1 LIKE ?
                  OR bl.mobile_2 LIKE ?
                  OR bl.email_1 LIKE ?
                  OR bl.email_2 LIKE ?
                  OR bl.city LIKE ?
                  OR bl.state LIKE ?
                  OR bl.pincode LIKE ?
                  OR bl.address_line_1 LIKE ?
                  OR bl.address_line_2 LIKE ?
              )
        )
        OR EXISTS (
            SELECT 1
            FROM branch_list bl
            INNER JOIN firms f ON f.branch_id = bl.branch_id
            WHERE bl.username = u.username
              AND bl.is_deleted = '0'
              AND f.is_deleted = '0'
              AND (
                  f.firm_name LIKE ?
                  OR f.firm_type LIKE ?
                  OR f.gst_no LIKE ?
                  OR f.pan_no LIKE ?
                  OR f.tan_no LIKE ?
                  OR f.cin_no LIKE ?
                  OR f.file_no LIKE ?
                  OR f.city LIKE ?
                  OR f.district LIKE ?
              )
        )
    )`;

    const params = [
        sp, sp, sp, sp, sp, sp, sp, sp, sp,
        sp, sp, sp, sp, sp, sp, sp, sp, sp, sp, sp, sp, sp,
        sp, sp, sp, sp, sp, sp, sp, sp, sp,
    ];

    return { sql, params };
}

router.get("/list", authAdmin, async (req, res) => {
    try {
        const page_no = Math.max(1, Number(req.query.page_no) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
        const offset = (page_no - 1) * limit;
        const search = req.query.search ? String(req.query.search).trim() : "";

        const { sql: searchSql, params: searchParams } = buildSearchClause(search);

        const baseFrom = `
            FROM users u
            LEFT JOIN profile p ON p.username = u.username
                AND p.id = (
                    SELECT MAX(p2.id)
                    FROM profile p2
                    WHERE p2.username = u.username
                )
            WHERE u.type = 'user'
            ${searchSql}
        `;

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total ${baseFrom}`,
            searchParams
        );

        const [rows] = await pool.query(
            `SELECT
                u.id,
                u.username,
                u.login_id,
                u.status,
                u.remark,
                u.create_date,
                p.name,
                p.mobile,
                p.country_code,
                p.email,
                p.pan_number,
                p.city,
                p.state,
                p.district,
                p.address_line_1,
                p.address_line_2,
                p.pincode
            ${baseFrom}
            ORDER BY u.id DESC
            LIMIT ? OFFSET ?`,
            [...searchParams, limit, offset]
        );

        const usernames = rows.map((row) => row.username).filter(Boolean);
        const branchesByUser = {};

        if (usernames.length > 0) {
            const placeholders = usernames.map(() => "?").join(", ");
            const [branchRows] = await pool.query(
                `SELECT
                    bl.username,
                    bl.branch_id,
                    bl.name,
                    bl.pan,
                    bl.gst,
                    bl.city,
                    bl.state,
                    bl.status,
                    bl.create_date
                FROM branch_list bl
                WHERE bl.username IN (${placeholders})
                  AND bl.is_deleted = '0'
                ORDER BY bl.create_date DESC`,
                usernames
            );

            for (const branch of branchRows) {
                if (!branchesByUser[branch.username]) {
                    branchesByUser[branch.username] = [];
                }
                branchesByUser[branch.username].push({
                    branch_id: branch.branch_id,
                    name: branch.name,
                    pan: branch.pan,
                    gst: branch.gst,
                    city: branch.city,
                    state: branch.state,
                    status: branch.status === "1",
                    create_date: FORMAT_DATE(branch.create_date),
                });
            }
        }

        const data = rows.map((row) => ({
            username: row.username,
            login_id: row.login_id,
            status: row.status === "1",
            remark: row.remark,
            create_date: FORMAT_DATE(row.create_date),
            profile: {
                name: row.name,
                mobile: row.mobile,
                country_code: row.country_code,
                email: row.email,
                pan_number: row.pan_number,
                city: row.city,
                state: row.state,
                district: row.district,
                address_line_1: row.address_line_1,
                address_line_2: row.address_line_2,
                pincode: row.pincode,
            },
            branches: branchesByUser[row.username] || [],
            branch_count: (branchesByUser[row.username] || []).length,
        }));

        const totalCount = Number(total) || 0;

        return res.status(200).json({
            success: true,
            message: "User list retrieved successfully",
            filters: {
                search: search || null,
            },
            data,
            pagination: {
                page_no,
                limit,
                total: totalCount,
                total_pages: Math.ceil(totalCount / limit) || 0,
                has_more: offset + rows.length < totalCount,
            },
        });
    } catch (err) {
        console.error("ADMIN USER LIST ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch user list",
        });
    }
});

router.get("/profile/:username", authAdmin, async (req, res) => {
    try {
        const username = String(req.params.username || "").trim();

        if (!username) {
            return res.status(400).json({
                success: false,
                message: "Username is required",
            });
        }

        const [users] = await pool.query(
            `SELECT id, username, login_id, status, remark, create_date, create_by, type
             FROM users
             WHERE username = ? AND type = 'user'
             LIMIT 1`,
            [username]
        );

        if (!users.length) {
            return res.status(404).json({
                success: false,
                message: "User not found",
            });
        }

        const user = users[0];

        const [profiles] = await pool.query(
            `SELECT
                profile_id,
                user_type,
                name,
                care_of,
                guardian_name,
                date_of_birth,
                gender,
                mobile,
                country_code,
                email,
                pan_number,
                country,
                state,
                district,
                city,
                village_town,
                address_line_1,
                address_line_2,
                pincode,
                image,
                status,
                create_date
             FROM profile
             WHERE username = ?
             ORDER BY id DESC
             LIMIT 1`,
            [username]
        );

        const profileRow = profiles[0] || null;

        const [branchRows] = await pool.query(
            `SELECT branch_id, status
             FROM branch_list
             WHERE username = ?
               AND is_deleted = '0'`,
            [username]
        );

        const branchIds = branchRows.map((row) => row.branch_id).filter(Boolean);
        const activeBranchCount = branchRows.filter((row) => row.status === "1").length;
        const statistics = await fetchUserStatistics(branchIds, branchRows.length, activeBranchCount);

        const profile = profileRow
            ? {
                profile_id: profileRow.profile_id,
                user_type: profileRow.user_type,
                name: profileRow.name,
                care_of: profileRow.care_of,
                guardian_name: profileRow.guardian_name,
                date_of_birth: profileRow.date_of_birth,
                gender: profileRow.gender,
                mobile: profileRow.mobile,
                country_code: profileRow.country_code,
                email: profileRow.email,
                pan_number: profileRow.pan_number,
                image: buildProfileImageUrl(profileRow.image),
                status: profileRow.status === "1",
                create_date: FORMAT_DATE(profileRow.create_date),
                address: {
                    country: profileRow.country,
                    state: profileRow.state,
                    district: profileRow.district,
                    city: profileRow.city,
                    village_town: profileRow.village_town,
                    address_line_1: profileRow.address_line_1,
                    address_line_2: profileRow.address_line_2,
                    pincode: profileRow.pincode,
                },
            }
            : null;

        return res.status(200).json({
            success: true,
            message: "User profile retrieved successfully",
            data: {
                user: {
                    username: user.username,
                    login_id: user.login_id,
                    status: user.status === "1",
                    remark: user.remark,
                    create_date: FORMAT_DATE(user.create_date),
                    create_by: user.create_by,
                },
                profile,
                statistics,
            },
        });
    } catch (err) {
        console.error("ADMIN USER PROFILE ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch user profile",
        });
    }
});

router.get("/sessions", authAdmin, async (req, res) => {
    try {
        const page_no = Math.max(1, Number(req.query.page_no) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
        const offset = (page_no - 1) * limit;
        const username = req.query.username ? String(req.query.username).trim() : "";
        const search = req.query.search ? String(req.query.search).trim() : "";

        const filters = [];
        const filterParams = [];

        filters.push("u.type = 'user'");

        if (username) {
            filters.push("t.username = ?");
            filterParams.push(username);
        }

        if (search) {
            const sp = `%${search}%`;
            filters.push(`(
                t.token_id LIKE ?
                OR t.username LIKE ?
                OR t.create_ip LIKE ?
                OR t.last_ip LIKE ?
                OR t.remark LIKE ?
                OR u.login_id LIKE ?
                OR u.remark LIKE ?
                OR p.name LIKE ?
                OR p.mobile LIKE ?
                OR p.email LIKE ?
            )`);
            filterParams.push(sp, sp, sp, sp, sp, sp, sp, sp, sp, sp);
        }

        const whereSql = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

        const baseFrom = `
            FROM tokens t
            INNER JOIN users u ON u.username = t.username
            LEFT JOIN profile p ON p.username = u.username
                AND p.id = (
                    SELECT MAX(p2.id)
                    FROM profile p2
                    WHERE p2.username = u.username
                )
            ${whereSql}
        `;

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total ${baseFrom}`,
            filterParams
        );

        const [rows] = await pool.query(
            `SELECT
                t.id,
                t.token_id,
                t.username,
                t.create_by,
                t.create_ip,
                t.last_ip,
                t.login_method,
                t.status,
                t.remark,
                t.create_date,
                t.last_used_date,
                t.expire_date,
                u.login_id,
                u.type AS user_type,
                u.status AS user_status,
                u.remark AS user_remark,
                p.name,
                p.mobile,
                p.country_code,
                p.email,
                p.user_type AS profile_user_type
            ${baseFrom}
            ORDER BY t.id DESC
            LIMIT ? OFFSET ?`,
            [...filterParams, limit, offset]
        );

        const now = new Date();
        const data = rows.map((row) => {
            const expireDate = row.expire_date ? new Date(row.expire_date) : null;
            const isExpired = expireDate ? expireDate < now : false;

            return {
                token_id: row.token_id,
                status: row.status === "1",
                is_expired: isExpired,
                is_active: row.status === "1" && !isExpired,
                create_date: FORMAT_DATE(row.create_date),
                last_used_date: FORMAT_DATE(row.last_used_date),
                expire_date: FORMAT_DATE(row.expire_date),
                create_ip: row.create_ip,
                last_ip: row.last_ip,
                login_method: row.login_method,
                create_by: row.create_by,
                remark: row.remark,
                user: {
                    username: row.username,
                    login_id: row.login_id,
                    type: row.user_type,
                    status: row.user_status === "1",
                    remark: row.user_remark,
                    name: row.name,
                    mobile: row.mobile,
                    country_code: row.country_code,
                    email: row.email,
                    profile_user_type: row.profile_user_type,
                },
            };
        });

        const totalCount = Number(total) || 0;

        return res.status(200).json({
            success: true,
            message: "Sessions retrieved successfully",
            filters: {
                username: username || null,
                search: search || null,
            },
            data,
            pagination: {
                page_no,
                limit,
                total: totalCount,
                total_pages: Math.ceil(totalCount / limit) || 0,
                has_more: offset + rows.length < totalCount,
            },
        });
    } catch (err) {
        console.error("ADMIN USER SESSIONS ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch sessions",
        });
    }
});

export default router;
