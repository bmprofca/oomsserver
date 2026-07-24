import express from "express";
import pool from "../db.js";
import { authAdmin } from "../middleware/authAdmin.js";
import { FORMAT_DATE } from "../helpers/function.js";
import { buildBranchLogoUrl, buildBranchSignUrl } from "../helpers/mediaUrl.js";
import {
    getSubscriptionStatus,
    isPlanActive,
    updatePlanExpiryByAdmin,
    assignPlanByAdmin,
    VALID_PLANS,
} from "../services/subscriptionService.js";

const router = express.Router();

const num = (value) => Number(value) || 0;

function formatBranchRow(row) {
    return {
        branch_id: row.branch_id,
        name: row.name,
        status: row.status === "1",
        logo: buildBranchLogoUrl(row.logo),
        sign: buildBranchSignUrl(row.sign),
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
                s.default_due_date
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

/**
 * Branch subscription overview for admin:
 * - summary (highest active plan)
 * - all plan rows (active + expired history on the plan table)
 * - payment / checkout history from razorpay_orders
 */
router.get("/:branch_id/subscriptions", authAdmin, async (req, res) => {
    try {
        const branch_id = String(req.params.branch_id || "").trim();
        if (!branch_id) {
            return res.status(400).json({
                success: false,
                message: "branch_id is required",
            });
        }

        const [branchRows] = await pool.query(
            `SELECT branch_id, name, username
             FROM branch_list
             WHERE branch_id = ? AND is_deleted = '0'
             LIMIT 1`,
            [branch_id]
        );

        if (!branchRows.length) {
            return res.status(404).json({
                success: false,
                message: "Branch not found",
            });
        }

        const summary = await getSubscriptionStatus(branch_id);

        const [subscriptionRows] = await pool.query(
            `SELECT
                subscription_id,
                branch_id,
                username,
                plan_name,
                billing_cycle,
                expires_at,
                payment_ref,
                payment_method,
                status,
                create_date,
                modify_date
             FROM user_subscriptions
             WHERE branch_id = ?
             ORDER BY
                CASE WHEN expires_at > NOW() THEN 0 ELSE 1 END ASC,
                expires_at DESC,
                plan_name ASC`,
            [branch_id]
        );

        const subscriptions = subscriptionRows.map((row) => {
            const active = isPlanActive(row.expires_at);
            const diffMs = new Date(row.expires_at).getTime() - Date.now();
            return {
                subscription_id: row.subscription_id,
                branch_id: row.branch_id,
                username: row.username,
                plan_name: row.plan_name,
                billing_cycle: row.billing_cycle,
                expires_at: row.expires_at,
                payment_ref: row.payment_ref,
                payment_method: row.payment_method,
                status: active ? "active" : "expired",
                is_active: active,
                days_remaining: active ? Math.ceil(diffMs / (1000 * 60 * 60 * 24)) : 0,
                create_date: FORMAT_DATE(row.create_date),
                modify_date: FORMAT_DATE(row.modify_date),
            };
        });

        const [paymentRows] = await pool.query(
            `SELECT
                razorpay_order_id,
                razorpay_payment_id,
                username,
                branch_id,
                plan_name,
                billing_cycle,
                order_type,
                purpose,
                amount,
                status
             FROM razorpay_orders
             WHERE branch_id = ?
               AND (order_type = 'subscription' OR order_type IS NULL OR order_type = '')
             ORDER BY id DESC
             LIMIT 100`,
            [branch_id]
        );

        const payments = paymentRows.map((row) => ({
            order_id: row.razorpay_order_id,
            payment_id: row.razorpay_payment_id || null,
            username: row.username,
            plan_name: row.plan_name,
            billing_cycle: row.billing_cycle,
            order_type: row.order_type || "subscription",
            purpose: row.purpose || null,
            amount_paise: Number(row.amount) || 0,
            amount_rupees: Math.round(((Number(row.amount) || 0) / 100) * 100) / 100,
            status: row.status || "pending",
        }));

        return res.status(200).json({
            success: true,
            message: "Branch subscriptions retrieved successfully",
            data: {
                branch: {
                    branch_id: branchRows[0].branch_id,
                    name: branchRows[0].name,
                    username: branchRows[0].username,
                },
                summary,
                subscriptions,
                payments,
                plans: VALID_PLANS,
            },
        });
    } catch (err) {
        console.error("ADMIN BRANCH SUBSCRIPTIONS ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch branch subscriptions",
            error: err.message,
        });
    }
});

/**
 * Admin manually assigns a plan to a branch (no payment gateway).
 * Body: { plan_name, billing_cycle?, expires_at? }
 * If expires_at is omitted, expiry = now + monthly/yearly period (does not stack).
 */
router.post("/:branch_id/subscriptions", authAdmin, async (req, res) => {
    try {
        const branch_id = String(req.params.branch_id || "").trim();
        const plan_name = String(req.body?.plan_name || "").trim();
        const billing_cycle =
            req.body?.billing_cycle === "yearly" ? "yearly" : "monthly";
        const expires_at = req.body?.expires_at || null;

        if (!branch_id) {
            return res.status(400).json({
                success: false,
                message: "branch_id is required",
            });
        }

        if (!VALID_PLANS.includes(plan_name)) {
            return res.status(400).json({
                success: false,
                message: "Invalid plan_name. Must be Business, BusinessPlus, or BusinessPro.",
            });
        }

        const [branchRows] = await pool.query(
            `SELECT branch_id FROM branch_list
             WHERE branch_id = ? AND is_deleted = '0'
             LIMIT 1`,
            [branch_id]
        );

        if (!branchRows.length) {
            return res.status(404).json({
                success: false,
                message: "Branch not found",
            });
        }

        const adminUsername =
            req.headers["username"] || req.headers["Username"] || null;

        const assigned = await assignPlanByAdmin({
            branchId: branch_id,
            planName: plan_name,
            billingCycle: billing_cycle,
            expiresAt: expires_at,
            adminUsername,
        });

        const summary = await getSubscriptionStatus(branch_id);

        return res.status(200).json({
            success: true,
            message: "Plan assigned successfully (manual, no payment).",
            data: {
                assigned,
                summary,
            },
        });
    } catch (err) {
        console.error("ADMIN BRANCH ASSIGN SUBSCRIPTION ERROR:", err);
        const status = err.statusCode || 500;
        return res.status(status).json({
            success: false,
            message: err.message || "Failed to assign subscription plan",
        });
    }
});

/**
 * Admin manually updates a subscription expiry date for a branch plan.
 * Body: { expires_at: "YYYY-MM-DD" | ISO datetime }
 */
router.patch(
    "/:branch_id/subscriptions/:subscription_id/expiry",
    authAdmin,
    async (req, res) => {
        try {
            const branch_id = String(req.params.branch_id || "").trim();
            const subscription_id = String(req.params.subscription_id || "").trim();
            const expires_at = req.body?.expires_at;

            if (!branch_id || !subscription_id) {
                return res.status(400).json({
                    success: false,
                    message: "branch_id and subscription_id are required",
                });
            }

            if (!expires_at) {
                return res.status(400).json({
                    success: false,
                    message: "expires_at is required",
                });
            }

            const adminUsername =
                req.headers["username"] || req.headers["Username"] || null;

            // Accept date-only (YYYY-MM-DD) as end-of-day local-ish UTC evening
            let normalizedExpiry = expires_at;
            if (/^\d{4}-\d{2}-\d{2}$/.test(String(expires_at).trim())) {
                normalizedExpiry = `${String(expires_at).trim()}T23:59:59`;
            }

            const updated = await updatePlanExpiryByAdmin({
                branchId: branch_id,
                subscriptionId: subscription_id,
                expiresAt: normalizedExpiry,
                adminUsername,
            });

            const summary = await getSubscriptionStatus(branch_id);

            return res.status(200).json({
                success: true,
                message: "Subscription expiry updated successfully",
                data: {
                    updated,
                    summary,
                },
            });
        } catch (err) {
            console.error("ADMIN BRANCH SUBSCRIPTION EXPIRY ERROR:", err);
            const status = err.statusCode || 500;
            return res.status(status).json({
                success: false,
                message: err.message || "Failed to update subscription expiry",
            });
        }
    }
);

export default router;
