import express from "express";
import pool from "../db.js";
import { GET_BALANCE } from "../helpers/function.js";
import { validateCaSession } from "../middleware/validateCaSession.js";

const router = express.Router();

function parseCsvQuery(value) {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) {
        return value.map((v) => String(v).trim()).filter(Boolean);
    }
    const raw = String(value).trim();
    if (!raw) return [];
    return raw.split(",").map((v) => v.trim()).filter(Boolean);
}

router.get("/dashboard", validateCaSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.ca_username;

        const [balanceResult, taskResult, firmResult] = await Promise.all([
            GET_BALANCE({
                branch_id,
                party_id: username,
                party_type: "ca",
            }),
            pool.query(
                `SELECT
                    COUNT(*) AS total,
                    COALESCE(SUM(CASE WHEN status = 'in process' THEN 1 ELSE 0 END), 0) AS in_process,
                    COALESCE(SUM(CASE WHEN status = 'pending from client' THEN 1 ELSE 0 END), 0) AS pending_from_client,
                    COALESCE(SUM(CASE WHEN status = 'pending from department' THEN 1 ELSE 0 END), 0) AS pending_from_department,
                    COALESCE(SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END), 0) AS complete,
                    COALESCE(SUM(CASE WHEN status = 'cancel' THEN 1 ELSE 0 END), 0) AS cancel
                 FROM tasks
                 WHERE branch_id = ?
                   AND has_ca = '1'
                   AND ca_id = ?`,
                [branch_id, username]
            ),
            pool.query(
                `SELECT
                    COUNT(*) AS total,
                    COALESCE(SUM(CASE WHEN status = '1' THEN 1 ELSE 0 END), 0) AS active,
                    COALESCE(SUM(CASE WHEN status = '0' THEN 1 ELSE 0 END), 0) AS inactive
                 FROM (
                    SELECT DISTINCT f.firm_id, f.status
                    FROM tasks t
                    INNER JOIN firms f
                        ON f.firm_id = t.firm_id
                        AND f.branch_id = t.branch_id
                        AND (f.is_deleted = '0' OR f.is_deleted = 0)
                    WHERE t.branch_id = ?
                      AND t.has_ca = '1'
                      AND t.ca_id = ?
                 ) AS ca_firms`,
                [branch_id, username]
            ),
        ]);

        const num = (value) => Number(value) || 0;
        const tasks = taskResult[0]?.[0] || {};
        const firms = firmResult[0]?.[0] || {};

        return res.status(200).json({
            success: true,
            message: "Dashboard statistics retrieved successfully",
            data: {
                balance: {
                    balance: num(balanceResult?.balance),
                    debit: num(balanceResult?.debit),
                    credit: num(balanceResult?.credit),
                },
                tasks: {
                    total: num(tasks.total),
                    in_process: num(tasks.in_process),
                    pending_from_client: num(tasks.pending_from_client),
                    pending_from_department: num(tasks.pending_from_department),
                    complete: num(tasks.complete),
                    cancel: num(tasks.cancel),
                },
                firms: {
                    total: num(firms.total),
                    active: num(firms.active),
                    inactive: num(firms.inactive),
                },
            },
        });
    } catch (error) {
        console.error("CA DASHBOARD ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch dashboard statistics",
        });
    }
});

/**
 * Same logic as staff GET /api/v1/ca/details/report-by-service,
 * but scoped to the authenticated CA session (no username query).
 */
router.get("/report-by-service", validateCaSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const caUsername = req.ca_username;
        const {
            service_ids,
            type,
            firm_id,
            status,
            from_date,
            to_date,
            compliance_year,
            compliance_period,
            search,
            page_no = 1,
            limit = 20,
        } = req.query || {};

        const serviceType = type != null ? String(type).trim().toLowerCase() : "";
        if (serviceType && !["general", "compliance"].includes(serviceType)) {
            return res.status(400).json({
                success: false,
                message: "type must be empty, 'general', or 'compliance'",
            });
        }

        const pageNum = Math.max(1, Number(page_no) || 1);
        let limitNum = Number(limit) || 20;
        if (limitNum > 100) limitNum = 100;
        if (limitNum < 1) limitNum = 20;
        const offset = (pageNum - 1) * limitNum;

        const serviceIdList = parseCsvQuery(service_ids);
        const statusList = parseCsvQuery(status).map((s) => String(s).trim().toLowerCase());
        const allowedStatuses = new Set([
            "in process",
            "pending from client",
            "pending from department",
            "complete",
            "cancel",
        ]);
        const normalizedStatuses = statusList.filter((s) => allowedStatuses.has(s));

        const hasComplianceYear =
            compliance_year != null && String(compliance_year).trim() !== "";
        const hasCompliancePeriod =
            compliance_period != null && String(compliance_period).trim() !== "";

        if (hasCompliancePeriod && !hasComplianceYear) {
            return res.status(400).json({
                success: false,
                message: "compliance_year is required when compliance_period is provided",
            });
        }

        const fromJoins = `
            FROM tasks t
            INNER JOIN services s ON s.service_id = t.service_id
            LEFT JOIN firms f
                ON f.firm_id = t.firm_id
                AND (f.is_deleted = '0' OR f.is_deleted = 0)
            LEFT JOIN profile pf ON pf.username = f.username
            LEFT JOIN profile p ON p.username = t.username
        `;

        let whereSql = `
            WHERE t.branch_id = ?
              AND t.has_ca = '1'
              AND t.ca_id = ?
        `;
        const whereParams = [branch_id, caUsername];

        if (serviceIdList.length > 0) {
            whereSql += ` AND t.service_id IN (${serviceIdList.map(() => "?").join(",")})`;
            whereParams.push(...serviceIdList);
        }
        if (serviceType) {
            whereSql += " AND LOWER(s.type) = ?";
            whereParams.push(serviceType);
        }
        if (firm_id && String(firm_id).trim() !== "") {
            whereSql += " AND t.firm_id = ?";
            whereParams.push(String(firm_id).trim());
        }
        if (normalizedStatuses.length > 0) {
            whereSql += ` AND LOWER(TRIM(t.status)) IN (${normalizedStatuses.map(() => "?").join(",")})`;
            whereParams.push(...normalizedStatuses);
        }
        if (from_date && String(from_date).trim() !== "") {
            whereSql += " AND DATE(t.complete_date) >= ?";
            whereParams.push(String(from_date).trim());
        }
        if (to_date && String(to_date).trim() !== "") {
            whereSql += " AND DATE(t.complete_date) <= ?";
            whereParams.push(String(to_date).trim());
        }
        if (hasComplianceYear || hasCompliancePeriod) {
            whereSql += " AND LOWER(s.type) = 'compliance'";
            if (hasComplianceYear) {
                whereSql += " AND t.compliance_year = ?";
                whereParams.push(String(compliance_year).trim());
            }
            if (hasCompliancePeriod) {
                whereSql += " AND t.compliance_period = ?";
                whereParams.push(String(compliance_period).trim());
            }
        }
        if (search && String(search).trim() !== "") {
            const pattern = `%${String(search).trim()}%`;
            whereSql += ` AND (
                s.name LIKE ?
                OR f.firm_name LIKE ?
                OR COALESCE(NULLIF(TRIM(f.pan_no), ''), NULLIF(TRIM(pf.pan_number), ''), '') LIKE ?
                OR p.name LIKE ?
                OR p.mobile LIKE ?
                OR t.username LIKE ?
            )`;
            whereParams.push(pattern, pattern, pattern, pattern, pattern, pattern);
        }

        const [countRows] = await pool.query(
            `SELECT
                COUNT(*) AS total_tasks,
                COUNT(DISTINCT t.service_id) AS total_services,
                COUNT(DISTINCT t.firm_id) AS total_firms
             ${fromJoins}
             ${whereSql}`,
            whereParams
        );

        const total = Number(countRows[0]?.total_tasks) || 0;
        const totalServices = Number(countRows[0]?.total_services) || 0;
        const totalFirms = Number(countRows[0]?.total_firms) || 0;

        const [rows] = await pool.query(
            `SELECT
                t.task_id,
                t.status,
                t.create_date,
                t.complete_date,
                t.service_id,
                s.name AS service_name,
                s.type AS service_type,
                t.firm_id,
                f.firm_name,
                f.firm_type,
                f.gst_no,
                f.tan_no,
                f.cin_no,
                f.vat_no,
                f.file_no,
                f.address_line_1,
                f.address_line_2,
                f.city,
                f.state,
                f.country,
                f.pincode,
                f.create_date AS firm_create_date,
                f.status AS firm_status,
                COALESCE(NULLIF(TRIM(f.pan_no), ''), NULLIF(TRIM(pf.pan_number), ''), '') AS firm_pan,
                t.username AS client_username,
                p.name AS client_name,
                t.compliance_year,
                t.compliance_period
             ${fromJoins}
             ${whereSql}
             ORDER BY t.complete_date DESC, s.name ASC, f.firm_name ASC, p.name ASC
             LIMIT ? OFFSET ?`,
            [...whereParams, limitNum, offset]
        );

        const data = rows.map((row) => ({
            task_id: row.task_id,
            status: row.status || "",
            create_date: row.create_date,
            complete_date: row.complete_date,
            service_id: row.service_id,
            service_name: row.service_name,
            service_type: row.service_type,
            firm_id: row.firm_id,
            firm_name: row.firm_name || "—",
            firm_pan: row.firm_pan || "",
            firm_type: row.firm_type || "",
            firm_gst: row.gst_no || "",
            firm_tan: row.tan_no || "",
            firm_cin: row.cin_no || "",
            firm_vat: row.vat_no || "",
            firm_file_no: row.file_no || "",
            firm_address_line_1: row.address_line_1 || "",
            firm_address_line_2: row.address_line_2 || "",
            firm_city: row.city || "",
            firm_state: row.state || "",
            firm_country: row.country || "",
            firm_pincode: row.pincode || "",
            firm_create_date: row.firm_create_date || null,
            firm_status: row.firm_status,
            client_username: row.client_username || "",
            client_name: row.client_name || row.client_username || "—",
            compliance_year: row.compliance_year || null,
            compliance_period: row.compliance_period || null,
        }));

        return res.status(200).json({
            success: true,
            message: "CA firm report retrieved successfully",
            data,
            summary: {
                total_services: totalServices,
                total_firms: totalFirms,
                total_tasks: total,
            },
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                total_pages: Math.ceil(total / limitNum) || 1,
                is_last_page: offset + rows.length >= total,
            },
            filters_applied: {
                username: caUsername,
                service_ids: serviceIdList.length > 0 ? serviceIdList : "all",
                type: serviceType || "all",
                firm_id: firm_id ? String(firm_id).trim() : "all",
                status: normalizedStatuses.length > 0 ? normalizedStatuses : "all",
                from_date: from_date || null,
                to_date: to_date || null,
                compliance_year: compliance_year || null,
                compliance_period: compliance_period || null,
                search: search || null,
            },
        });
    } catch (error) {
        console.error("CA report-by-service error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch CA service report",
        });
    }
});

export default router;
