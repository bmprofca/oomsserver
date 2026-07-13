import express from "express";
import pool from "../db.js";
import { UNIQUE_RANDOM_STRING, ID_LENGTH } from "../helpers/function.js";
import { validateClientSession } from "../middleware/validateClientSession.js";

const router = express.Router();

const ALLOWED_TYPES = ["general", "compliance"];

function parseQueryArray(value) {
    if (value === undefined || value === null) return [];

    const toCleanStringArray = (arr) =>
        arr
            .map((item) => String(item).trim().toLowerCase())
            .filter((item) => item !== "");

    if (Array.isArray(value)) {
        return toCleanStringArray(value);
    }

    const raw = String(value).trim();
    if (raw === "") return [];

    if (raw.startsWith("[") && raw.endsWith("]")) {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return toCleanStringArray(parsed);
            }
        } catch (_) { }
    }

    return toCleanStringArray(raw.split(","));
}

function formatServiceListItem(row) {
    const fees = Number(row.fees) || 0;
    const gst_value = Number(row.gst_value) || 0;
    const isCompliance = row.type === "compliance";

    const item = {
        service_id: row.service_id,
        name: row.name,
        sac_code: row.sac_code,
        type: row.type,
        charges: {
            total: Number((fees + gst_value).toFixed(2)),
        },
    };

    if (isCompliance) {
        item.frequency = row.frequency;
        item.default_due_date = row.default_due_date;
        item.due_date = row.due_date;
    }

    return item;
}

function formatServiceDetails(row) {
    const fees = Number(row.fees) || 0;
    const gst_rate = Number(row.gst_rate) || 0;
    const gst_value = Number(row.gst_value) || 0;
    const isCompliance = row.type === "compliance";

    const serviceBlock = {
        remark: row.service_remark,
        default_amount: Number(row.default_amount) || 0,
    };

    if (isCompliance) {
        serviceBlock.frequency = row.frequency;
        serviceBlock.default_due_date = row.default_due_date;
    }

    const branchBlock = isCompliance
        ? { due_date: row.due_date }
        : { remark: row.remark };

    return {
        service_id: row.service_id,
        name: row.name,
        sac_code: row.sac_code,
        type: row.type,
        compliance: isCompliance,
        service: serviceBlock,
        branch: branchBlock,
        charges: {
            fees,
            gst_rate,
            gst_value,
            total: Number((fees + gst_value).toFixed(2)),
        },
    };
}

const SERVICE_SELECT_FIELDS = `
    s.service_id,
    s.name,
    s.sac_code,
    s.type,
    s.frequency,
    s.default_due_date,
    s.default_amount,
    s.remark AS service_remark,
    bs.fees,
    bs.gst_rate,
    bs.gst_value,
    bs.remark,
    bs.due_date
`;

const SERVICE_REQUEST_STATUSES = ["pending", "approved", "rejected"];

function formatServiceRequestListItem(row) {
    const fees = Number(row.fees) || 0;
    const tax_value = Number(row.tax_value) || 0;

    return {
        request_id: row.request_id,
        firm_id: row.firm_id,
        firm_name: row.firm_name,
        service_id: row.service_id,
        service_name: row.service_name,
        status: row.status,
        client_remark: row.client_remark,
        charges: {
            fees,
            tax_rate: Number(row.tax_rate) || 0,
            tax_value,
            amount: Number(row.amount) || Number((fees + tax_value).toFixed(2)),
        },
        create_date: row.create_date,
    };
}

function formatServiceRequestDetails(row) {
    const fees = Number(row.fees) || 0;
    const tax_rate = Number(row.tax_rate) || 0;
    const tax_value = Number(row.tax_value) || 0;

    return {
        request_id: row.request_id,
        status: row.status,
        task_id: row.task_id,
        client_remark: row.client_remark,
        office_remark: row.office_remark,
        firm: {
            firm_id: row.firm_id,
            firm_name: row.firm_name,
            firm_type: row.firm_type,
        },
        service: {
            service_id: row.service_id,
            name: row.service_name,
            sac_code: row.sac_code,
            type: row.type,
        },
        charges: {
            fees,
            tax_rate,
            tax_value,
            amount: Number(row.amount) || Number((fees + tax_value).toFixed(2)),
        },
        create_date: row.create_date,
        modify_date: row.modify_date,
    };
}

const SERVICE_REQUEST_SELECT_FIELDS = `
    sr.request_id,
    sr.firm_id,
    sr.service_id,
    sr.fees,
    sr.tax_rate,
    sr.tax_value,
    sr.amount,
    sr.task_id,
    sr.client_remark,
    sr.office_remark,
    sr.status,
    sr.create_date,
    sr.modify_date,
    f.firm_name,
    f.firm_type,
    s.name AS service_name,
    s.sac_code,
    s.type
`;

router.get("/list", validateClientSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { page_no = 1, limit = 20, search, type } = req.query || {};

        const pageNum = Math.max(1, Number(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
        const offset = (pageNum - 1) * limitNum;

        const typeList = parseQueryArray(type);
        const invalidTypes = typeList.filter((item) => !ALLOWED_TYPES.includes(item));
        if (invalidTypes.length) {
            return res.status(400).json({
                success: false,
                message: `Invalid type value(s): ${invalidTypes.join(", ")}`,
            });
        }

        let baseQuery = `
            FROM branch_services bs
            INNER JOIN services s ON s.service_id = bs.service_id
            WHERE bs.branch_id = ?
              AND (bs.is_deleted = '0' OR bs.is_deleted = 0)
        `;

        const params = [branch_id];

        if (typeList.length > 0) {
            const placeholders = typeList.map(() => "?").join(", ");
            baseQuery += ` AND s.type IN (${placeholders})`;
            params.push(...typeList);
        }

        if (search && String(search).trim() !== "") {
            const searchPattern = `%${String(search).trim()}%`;
            baseQuery += `
              AND (
                  s.name LIKE ?
                  OR s.service_id LIKE ?
                  OR s.sac_code LIKE ?
                  OR s.remark LIKE ?
                  OR bs.remark LIKE ?
              )
            `;
            params.push(
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern
            );
        }

        const [countRows] = await pool.query(`SELECT COUNT(*) AS total ${baseQuery}`, params);
        const total = Number(countRows[0]?.total || 0);

        const [rows] = await pool.query(
            `SELECT
                s.service_id,
                s.name,
                s.sac_code,
                s.type,
                s.frequency,
                s.default_due_date,
                bs.fees,
                bs.gst_value,
                bs.due_date
             ${baseQuery}
             ORDER BY s.name ASC, bs.id DESC
             LIMIT ? OFFSET ?`,
            [...params, limitNum, offset]
        );

        const data = rows.map((row) => formatServiceListItem(row));

        return res.status(200).json({
            success: true,
            message: "Service list retrieved successfully",
            data,
            pagination: {
                page_no: pageNum,
                limit: limitNum,
                total,
                total_pages: Math.ceil(total / limitNum) || 1,
                is_last_page: offset + rows.length >= total,
            },
        });
    } catch (error) {
        console.error("CLIENT SERVICE LIST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch service list",
        });
    }
});

router.get("/details/:service_id", validateClientSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const service_id = String(req.params.service_id || "").trim();

        if (!service_id) {
            return res.status(400).json({
                success: false,
                message: "service_id is required",
            });
        }

        const [rows] = await pool.query(
            `SELECT
                ${SERVICE_SELECT_FIELDS}
             FROM branch_services bs
             INNER JOIN services s ON s.service_id = bs.service_id
             WHERE bs.branch_id = ?
               AND bs.service_id = ?
               AND (bs.is_deleted = '0' OR bs.is_deleted = 0)
             LIMIT 1`,
            [branch_id, service_id]
        );

        if (!rows.length) {
            return res.status(404).json({
                success: false,
                message: "Service not found",
            });
        }

        return res.status(200).json({
            success: true,
            message: "Service details retrieved successfully",
            data: formatServiceDetails(rows[0]),
        });
    } catch (error) {
        console.error("CLIENT SERVICE DETAILS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch service details",
        });
    }
});

router.post("/service-request/create", validateClientSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.client_username;
        const { firm_id, service_id, remark } = req.body || {};

        if (!firm_id || String(firm_id).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "firm_id is required",
            });
        }

        if (!service_id || String(service_id).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "service_id is required",
            });
        }

        const resolvedFirmId = String(firm_id).trim();
        const resolvedServiceId = String(service_id).trim();
        const clientRemark =
            remark != null && String(remark).trim() !== "" ? String(remark).trim() : null;

        const [firmRows] = await pool.query(
            `SELECT firm_id
             FROM firms
             WHERE firm_id = ?
               AND branch_id = ?
               AND username = ?
               AND (is_deleted = '0' OR is_deleted = 0)
             LIMIT 1`,
            [resolvedFirmId, branch_id, username]
        );

        if (!firmRows.length) {
            return res.status(404).json({
                success: false,
                message: "Firm not found",
            });
        }

        const [serviceRows] = await pool.query(
            `SELECT
                bs.fees,
                bs.gst_rate,
                bs.gst_value,
                s.type
             FROM branch_services bs
             INNER JOIN services s ON s.service_id = bs.service_id
             WHERE bs.branch_id = ?
               AND bs.service_id = ?
               AND (bs.is_deleted = '0' OR bs.is_deleted = 0)
             LIMIT 1`,
            [branch_id, resolvedServiceId]
        );

        if (!serviceRows.length) {
            return res.status(404).json({
                success: false,
                message: "Service not found",
            });
        }

        if (serviceRows[0].type !== "general") {
            return res.status(400).json({
                success: false,
                message: "Only general services can be requested",
            });
        }

        const fees = Number(serviceRows[0].fees) || 0;
        const tax_rate = Number(serviceRows[0].gst_rate) || 0;
        const tax_value = Number(serviceRows[0].gst_value) || 0;
        const amount = Number((fees + tax_value).toFixed(2));
        const request_id = await UNIQUE_RANDOM_STRING("service_requests", "request_id", { length: ID_LENGTH });

        await pool.query(
            `INSERT INTO service_requests (
                request_id,
                branch_id,
                username,
                firm_id,
                service_id,
                fees,
                tax_rate,
                tax_value,
                amount,
                client_remark,
                status,
                create_by,
                modify_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
            [
                request_id,
                branch_id,
                username,
                resolvedFirmId,
                resolvedServiceId,
                fees,
                tax_rate,
                tax_value,
                amount,
                clientRemark,
                username,
                username,
            ]
        );

        return res.status(200).json({
            success: true,
            message: "Service request created successfully",
            data: {
                request_id,
                firm_id: resolvedFirmId,
                service_id: resolvedServiceId,
                status: "pending",
                client_remark: clientRemark,
                charges: {
                    fees,
                    tax_rate,
                    tax_value,
                    amount,
                },
            },
        });
    } catch (error) {
        console.error("CLIENT SERVICE REQUEST CREATE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to create service request",
        });
    }
});

router.get("/service-request/list", validateClientSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.client_username;
        const { page_no = 1, limit = 20, search, firm_id, status } = req.query || {};

        const pageNum = Math.max(1, Number(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
        const offset = (pageNum - 1) * limitNum;

        const statusList = parseQueryArray(status);
        const invalidStatuses = statusList.filter(
            (item) => !SERVICE_REQUEST_STATUSES.includes(item)
        );
        if (invalidStatuses.length) {
            return res.status(400).json({
                success: false,
                message: `Invalid status value(s): ${invalidStatuses.join(", ")}`,
            });
        }

        let baseQuery = `
            FROM service_requests sr
            LEFT JOIN firms f
                ON f.firm_id = sr.firm_id
                AND (f.is_deleted = '0' OR f.is_deleted = 0)
            LEFT JOIN services s
                ON s.service_id = sr.service_id
            WHERE sr.branch_id = ?
              AND sr.username = ?
        `;

        const params = [branch_id, username];

        if (firm_id && String(firm_id).trim() !== "") {
            baseQuery += " AND sr.firm_id = ?";
            params.push(String(firm_id).trim());
        }

        if (statusList.length > 0) {
            const placeholders = statusList.map(() => "?").join(", ");
            baseQuery += ` AND sr.status IN (${placeholders})`;
            params.push(...statusList);
        }

        if (search && String(search).trim() !== "") {
            const searchPattern = `%${String(search).trim()}%`;
            baseQuery += `
              AND (
                  sr.request_id LIKE ?
                  OR f.firm_name LIKE ?
                  OR s.name LIKE ?
                  OR sr.status LIKE ?
                  OR sr.client_remark LIKE ?
              )
            `;
            params.push(
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern
            );
        }

        const [countRows] = await pool.query(`SELECT COUNT(*) AS total ${baseQuery}`, params);
        const total = Number(countRows[0]?.total || 0);

        const [rows] = await pool.query(
            `SELECT ${SERVICE_REQUEST_SELECT_FIELDS}
             ${baseQuery}
             ORDER BY sr.create_date DESC, sr.id DESC
             LIMIT ? OFFSET ?`,
            [...params, limitNum, offset]
        );

        return res.status(200).json({
            success: true,
            message: "Service request list retrieved successfully",
            data: rows.map((row) => formatServiceRequestListItem(row)),
            pagination: {
                page_no: pageNum,
                limit: limitNum,
                total,
                total_pages: Math.ceil(total / limitNum) || 1,
                is_last_page: offset + rows.length >= total,
            },
        });
    } catch (error) {
        console.error("CLIENT SERVICE REQUEST LIST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch service request list",
        });
    }
});

router.get("/service-request/details/:request_id", validateClientSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.client_username;
        const request_id = String(req.params.request_id || "").trim();

        if (!request_id) {
            return res.status(400).json({
                success: false,
                message: "request_id is required",
            });
        }

        const [rows] = await pool.query(
            `SELECT ${SERVICE_REQUEST_SELECT_FIELDS}
             FROM service_requests sr
             LEFT JOIN firms f
                ON f.firm_id = sr.firm_id
                AND (f.is_deleted = '0' OR f.is_deleted = 0)
             LEFT JOIN services s
                ON s.service_id = sr.service_id
             WHERE sr.request_id = ?
               AND sr.branch_id = ?
               AND sr.username = ?
             LIMIT 1`,
            [request_id, branch_id, username]
        );

        if (!rows.length) {
            return res.status(404).json({
                success: false,
                message: "Service request not found",
            });
        }

        return res.status(200).json({
            success: true,
            message: "Service request details retrieved successfully",
            data: formatServiceRequestDetails(rows[0]),
        });
    } catch (error) {
        console.error("CLIENT SERVICE REQUEST DETAILS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch service request details",
        });
    }
});

export default router;