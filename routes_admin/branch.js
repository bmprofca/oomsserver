import express from "express";
import pool from "../db.js";
import { authAdmin } from "../middleware/authAdmin.js";
import { FORMAT_DATE } from "../helpers/function.js";
import { BASE_DOMAIN } from "../helpers/Config.js";

const router = express.Router();

const num = (value) => Number(value) || 0;

function formatBranchRow(row) {
    return {
        branch_id: row.branch_id,
        name: row.name,
        status: row.status === "1",
        logo: row.logo ? `${BASE_DOMAIN}/media/logo/${row.logo}` : null,
        sign: row.sign ? `${BASE_DOMAIN}/media/sign/${row.sign}` : null,
        address: {
            address_line_1: row.address_line_1,
            address_line_2: row.address_line_2,
            city: row.city,
            state: row.state,
            country: row.country,
            pincode: row.pincode,
            invoice_address: row.invoice_address,
        },
        contact: {
            mobile_1: row.mobile_1,
            mobile_2: row.mobile_2,
            email_1: row.email_1,
            email_2: row.email_2,
        },
        tax_info: {
            pan: row.pan,
            is_pan_verified: row.is_pan_verified === "1",
            gst: row.gst,
            gst_rate: row.gst_rate,
            is_gst_verified: row.is_gst_verified === "1",
        },
        create_by: row.create_by,
        modify_by: row.modify_by,
        create_date: FORMAT_DATE(row.create_date),
        modify_date: FORMAT_DATE(row.modify_date),
        owner: {
            username: row.username,
            status: row.user_status === "1",
            name: row.owner_name,
            mobile: row.owner_mobile,
            country_code: row.owner_country_code,
            email: row.owner_email,
        },
    };
}

async function fetchBranchStatistics(branchId) {
    const [[clientStats]] = await pool.query(
        `SELECT
            COALESCE(SUM(CASE WHEN user_type = 'client' THEN 1 ELSE 0 END), 0) AS clients_total,
            COALESCE(SUM(CASE WHEN user_type = 'client' AND status = '1' THEN 1 ELSE 0 END), 0) AS clients_active,
            COALESCE(SUM(CASE WHEN user_type = 'ca' THEN 1 ELSE 0 END), 0) AS ca_total,
            COALESCE(SUM(CASE WHEN user_type = 'ca' AND status = '1' THEN 1 ELSE 0 END), 0) AS ca_active,
            COALESCE(SUM(CASE WHEN user_type = 'agent' THEN 1 ELSE 0 END), 0) AS agent_total,
            COALESCE(SUM(CASE WHEN user_type = 'agent' AND status = '1' THEN 1 ELSE 0 END), 0) AS agent_active
        FROM clients
        WHERE branch_id = ?
          AND is_deleted = '0'`,
        [branchId]
    );

    const [[employeeStats]] = await pool.query(
        `SELECT
            COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = '1' THEN 1 ELSE 0 END), 0) AS active,
            COALESCE(SUM(CASE WHEN is_accepted = '1' THEN 1 ELSE 0 END), 0) AS accepted,
            COALESCE(SUM(CASE WHEN is_accepted = '0' THEN 1 ELSE 0 END), 0) AS pending
        FROM branch_mapping
        WHERE branch_id = ?
          AND type = 'staff'
          AND is_deleted = '0'`,
        [branchId]
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
        WHERE branch_id = ?`,
        [branchId]
    );

    const [[firmStats]] = await pool.query(
        `SELECT
            COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = '1' THEN 1 ELSE 0 END), 0) AS active
        FROM firms
        WHERE branch_id = ?
          AND is_deleted = '0'`,
        [branchId]
    );

    return {
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

function buildBranchSearchClause(search) {
    if (!search) {
        return { sql: "", params: [] };
    }

    const sp = `%${search}%`;

    const sql = ` AND (
        bl.branch_id LIKE ?
        OR bl.username LIKE ?
        OR bl.name LIKE ?
        OR bl.pan LIKE ?
        OR bl.gst LIKE ?
        OR bl.mobile_1 LIKE ?
        OR bl.mobile_2 LIKE ?
        OR bl.email_1 LIKE ?
        OR bl.email_2 LIKE ?
        OR bl.city LIKE ?
        OR bl.state LIKE ?
        OR bl.country LIKE ?
        OR bl.pincode LIKE ?
        OR bl.address_line_1 LIKE ?
        OR bl.address_line_2 LIKE ?
        OR p.name LIKE ?
        OR p.mobile LIKE ?
        OR p.email LIKE ?
    )`;

    const params = [
        sp, sp, sp, sp, sp, sp, sp, sp, sp, sp, sp, sp, sp, sp, sp, sp, sp, sp,
    ];

    return { sql, params };
}

router.get("/list", authAdmin, async (req, res) => {
    try {
        const page_no = Math.max(1, Number(req.query.page_no) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
        const offset = (page_no - 1) * limit;
        const username = req.query.username ? String(req.query.username).trim() : "";
        const search = req.query.search ? String(req.query.search).trim() : "";

        const filters = ["bl.is_deleted = '0'"];
        const filterParams = [];

        if (username) {
            filters.push("bl.username = ?");
            filterParams.push(username);
        }

        const { sql: searchSql, params: searchParams } = buildBranchSearchClause(search);
        filterParams.push(...searchParams);

        const whereSql = `WHERE ${filters.join(" AND ")}${searchSql}`;

        const baseFrom = `
            FROM branch_list bl
            LEFT JOIN users u ON u.username = bl.username
            LEFT JOIN profile p ON p.username = bl.username
                AND p.status = '1'
            ${whereSql}
        `;

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total ${baseFrom}`,
            filterParams
        );

        const [rows] = await pool.query(
            `SELECT
                bl.id,
                bl.branch_id,
                bl.username,
                bl.name,
                bl.logo,
                bl.sign,
                bl.status,
                bl.address_line_1,
                bl.address_line_2,
                bl.city,
                bl.state,
                bl.country,
                bl.pincode,
                bl.invoice_address,
                bl.pan,
                bl.is_pan_verified,
                bl.gst,
                bl.gst_rate,
                bl.is_gst_verified,
                bl.mobile_1,
                bl.mobile_2,
                bl.email_1,
                bl.email_2,
                bl.create_by,
                bl.modify_by,
                bl.create_date,
                bl.modify_date,
                u.status AS user_status,
                p.name AS owner_name,
                p.mobile AS owner_mobile,
                p.country_code AS owner_country_code,
                p.email AS owner_email
            ${baseFrom}
            ORDER BY bl.id DESC
            LIMIT ? OFFSET ?`,
            [...filterParams, limit, offset]
        );

        const data = rows.map(formatBranchRow);

        const totalCount = Number(total) || 0;

        return res.status(200).json({
            success: true,
            message: "Branch list retrieved successfully",
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
        console.error("ADMIN BRANCH LIST ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch branch list",
        });
    }
});

router.get("/details/:branch_id", authAdmin, async (req, res) => {
    try {
        const branch_id = String(req.params.branch_id || "").trim();

        if (!branch_id) {
            return res.status(400).json({
                success: false,
                message: "Branch ID is required",
            });
        }

        const [rows] = await pool.query(
            `SELECT
                bl.id,
                bl.branch_id,
                bl.username,
                bl.name,
                bl.logo,
                bl.sign,
                bl.status,
                bl.address_line_1,
                bl.address_line_2,
                bl.city,
                bl.state,
                bl.country,
                bl.pincode,
                bl.invoice_address,
                bl.pan,
                bl.is_pan_verified,
                bl.gst,
                bl.gst_rate,
                bl.is_gst_verified,
                bl.mobile_1,
                bl.mobile_2,
                bl.email_1,
                bl.email_2,
                bl.create_by,
                bl.modify_by,
                bl.create_date,
                bl.modify_date,
                u.status AS user_status,
                p.name AS owner_name,
                p.mobile AS owner_mobile,
                p.country_code AS owner_country_code,
                p.email AS owner_email
            FROM branch_list bl
            LEFT JOIN users u ON u.username = bl.username
            LEFT JOIN profile p ON p.username = bl.username
                AND p.status = '1'
            WHERE bl.branch_id = ?
              AND bl.is_deleted = '0'
            LIMIT 1`,
            [branch_id]
        );

        if (!rows.length) {
            return res.status(404).json({
                success: false,
                message: "Branch not found",
            });
        }

        const statistics = await fetchBranchStatistics(branch_id);

        return res.status(200).json({
            success: true,
            message: "Branch details retrieved successfully",
            data: {
                ...formatBranchRow(rows[0]),
                statistics,
            },
        });
    } catch (err) {
        console.error("ADMIN BRANCH DETAILS ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch branch details",
        });
    }
});

router.get("/services", authAdmin, async (req, res) => {
    try {
        const branch_id = req.query.branch_id ? String(req.query.branch_id).trim() : "";
        const page_no = Math.max(1, Number(req.query.page_no) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
        const offset = (page_no - 1) * limit;
        const search = req.query.search ? String(req.query.search).trim() : "";

        if (!branch_id) {
            return res.status(400).json({
                success: false,
                message: "branch_id is required",
            });
        }

        const [branchRows] = await pool.query(
            "SELECT branch_id FROM branch_list WHERE branch_id = ? AND is_deleted = '0' LIMIT 1",
            [branch_id]
        );

        if (!branchRows.length) {
            return res.status(404).json({
                success: false,
                message: "Branch not found",
            });
        }

        let baseFrom = `
            FROM branch_services bs
            INNER JOIN services s ON s.service_id = bs.service_id
            WHERE bs.branch_id = ?
              AND bs.is_deleted = '0'
        `;
        const filterParams = [branch_id];

        if (search) {
            const sp = `%${search}%`;
            baseFrom += ` AND (
                s.service_id LIKE ?
                OR s.name LIKE ?
                OR s.sac_code LIKE ?
                OR s.type LIKE ?
                OR s.remark LIKE ?
                OR bs.remark LIKE ?
            )`;
            filterParams.push(sp, sp, sp, sp, sp, sp);
        }

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total ${baseFrom}`,
            filterParams
        );

        const [rows] = await pool.query(
            `SELECT
                bs.id AS branch_service_id,
                bs.service_id,
                bs.fees,
                bs.gst_rate,
                bs.gst_value,
                bs.remark AS branch_remark,
                bs.create_by,
                bs.modify_by,
                bs.create_date,
                bs.modify_date,
                s.name,
                s.sac_code,
                s.type,
                s.frequency,
                s.default_amount,
                s.remark AS service_remark,
                s.default_due_date,
                s.fields
            ${baseFrom}
            ORDER BY s.name ASC
            LIMIT ? OFFSET ?`,
            [...filterParams, limit, offset]
        );

        const data = rows.map((row) => ({
            service_id: row.service_id,
            name: row.name,
            sac_code: row.sac_code,
            type: row.type,
            compliance: row.type === "compliance",
            frequency: row.frequency,
            default_amount: row.default_amount,
            due_day: row.default_due_date ?? row.due_day ?? null,
            service_remark: row.service_remark,
            fees: row.fees,
            gst_rate: row.gst_rate,
            gst_value: row.gst_value,
            remark: row.branch_remark,
            create_by: row.create_by,
            modify_by: row.modify_by,
            create_date: FORMAT_DATE(row.create_date),
            modify_date: FORMAT_DATE(row.modify_date),
        }));

        const totalCount = Number(total) || 0;

        return res.status(200).json({
            success: true,
            message: "Branch services retrieved successfully",
            filters: {
                branch_id,
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
        console.error("ADMIN BRANCH SERVICES ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch branch services",
        });
    }
});

export default router;
