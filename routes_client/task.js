import express from "express";
import pool from "../db.js";
import { SINGLE_TASK_STAFF_LIST, USER_SNIPPED_DATA } from "../helpers/function.js";
import { validateClientSession } from "../middleware/validateClientSession.js";

const router = express.Router();

const ALLOWED_STATUSES = [
    "in process",
    "pending from client",
    "pending from department",
    "complete",
    "cancel",
];

const TASK_SELECT_FIELDS = `
    t.task_id,
    t.username,
    t.firm_id,
    t.service_id,
    t.fees,
    t.tax_rate,
    t.tax_value,
    t.total,
    t.due_date,
    t.target_date,
    t.complete_date,
    t.billing_status,
    t.invoice_id,
    t.invoice_no,
    t.status,
    t.cancelled_date,
    t.create_date,
    t.is_recurring,
    f.firm_name,
    f.firm_type,
    f.gst_no,
    f.pan_no,
    f.tan_no,
    f.vat_no,
    f.cin_no,
    f.file_no,
    f.address_line_1,
    f.address_line_2,
    f.city,
    f.district,
    f.state,
    f.country,
    f.pincode,
    s.name AS service_name,
    s.sac_code,
    s.type AS service_type,
    s.remark AS service_remark
`;

function parseQueryArray(value) {
    if (value === undefined || value === null) return [];

    const toCleanStringArray = (arr) =>
        arr
            .map((item) => String(item).trim())
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

function formatBillingStatus(value) {
    if (value === "0" || value === 0) return "pending";
    if (value === "1" || value === 1) return "complete";
    return "non billable";
}

function formatTaskListItem(row) {
    return {
        task_id: row.task_id,
        firm: {
            firm_id: row.firm_id,
            firm_name: row.firm_name,
        },
        service: {
            service_id: row.service_id,
            name: row.service_name,
        },
        status: row.status,
        dates: {
            due_date: row.due_date,
        },
        charges: {
            total: Number(row.total) || 0,
        },
    };
}

async function getTaskStatusLog(branch_id, task_id) {
    const [rows] = await pool.query(
        `SELECT status, create_date, create_by
         FROM task_status
         WHERE branch_id = ? AND task_id = ?
         ORDER BY id ASC`,
        [branch_id, task_id]
    );

    const userCache = new Map();
    const status_log = [];

    for (const entry of rows) {
        const createByKey =
            entry.create_by != null ? String(entry.create_by).trim() : "";

        if (createByKey && !userCache.has(createByKey)) {
            userCache.set(createByKey, await USER_SNIPPED_DATA(createByKey));
        }

        status_log.push({
            status: entry.status,
            create_date: entry.create_date,
            create_by: createByKey
                ? userCache.get(createByKey) ?? { username: createByKey }
                : null,
        });
    }

    return status_log;
}

async function formatTaskDetails(row, branch_id) {
    const [staffs, status_log] = await Promise.all([
        SINGLE_TASK_STAFF_LIST(row.task_id),
        getTaskStatusLog(branch_id, row.task_id),
    ]);

    const data = {
        task_id: row.task_id,
        username: row.username,
        status: row.status,
        billing_status: formatBillingStatus(row.billing_status),
        is_recurring: row.is_recurring === "1" || row.is_recurring === 1,
        firm: {
            firm_id: row.firm_id,
            firm_name: row.firm_name,
            firm_type: row.firm_type,
            tax: {
                gst_no: row.gst_no,
                pan_no: row.pan_no,
                tan_no: row.tan_no,
                vat_no: row.vat_no,
                cin_no: row.cin_no,
                file_no: row.file_no,
            },
            address: {
                address_line_1: row.address_line_1,
                address_line_2: row.address_line_2,
                city: row.city,
                district: row.district,
                state: row.state,
                country: row.country,
                pincode: row.pincode,
            },
        },
        service: {
            service_id: row.service_id,
            name: row.service_name,
            sac_code: row.sac_code,
            type: row.service_type,
            remark: row.service_remark,
        },
        charges: {
            fees: Number(row.fees) || 0,
            tax_rate: Number(row.tax_rate) || 0,
            tax_value: Number(row.tax_value) || 0,
            total: Number(row.total) || 0,
        },
        dates: {
            due_date: row.due_date,
            target_date: row.target_date,
            create_date: row.create_date,
            complete_date: row.complete_date,
            cancelled_date: row.cancelled_date,
        },
        billing: {
            invoice_id: row.invoice_id,
            invoice_no: row.invoice_no,
        },
        staffs,
        status_log,
    };

    return data;
}

router.get("/list", validateClientSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.client_username;
        const { page_no = 1, limit = 20, search, firm_id, status } = req.query || {};

        const pageNum = Math.max(1, Number(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
        const offset = (pageNum - 1) * limitNum;

        const statusList = parseQueryArray(status).map((item) => item.toLowerCase());
        const invalidStatuses = statusList.filter((item) => !ALLOWED_STATUSES.includes(item));
        if (invalidStatuses.length) {
            return res.status(400).json({
                success: false,
                message: `Invalid status value(s): ${invalidStatuses.join(", ")}`,
            });
        }

        let baseQuery = `
            FROM tasks t
            LEFT JOIN firms f
                ON f.firm_id = t.firm_id
                AND (f.is_deleted = '0' OR f.is_deleted = 0)
            LEFT JOIN services s
                ON s.service_id = t.service_id
            WHERE t.branch_id = ?
              AND t.username = ?
        `;

        const params = [branch_id, username];

        if (firm_id && String(firm_id).trim() !== "") {
            baseQuery += " AND t.firm_id = ?";
            params.push(String(firm_id).trim());
        }

        if (statusList.length > 0) {
            const placeholders = statusList.map(() => "?").join(", ");
            baseQuery += ` AND t.status IN (${placeholders})`;
            params.push(...statusList);
        }

        if (search && String(search).trim() !== "") {
            const searchPattern = `%${String(search).trim()}%`;
            baseQuery += `
              AND (
                  t.task_id LIKE ?
                  OR f.firm_name LIKE ?
                  OR s.name LIKE ?
                  OR t.status LIKE ?
              )
            `;
            params.push(searchPattern, searchPattern, searchPattern, searchPattern);
        }

        const [countRows] = await pool.query(`SELECT COUNT(*) AS total ${baseQuery}`, params);
        const total = Number(countRows[0]?.total || 0);

        const [rows] = await pool.query(
            `SELECT
                t.task_id,
                t.firm_id,
                t.service_id,
                t.status,
                t.due_date,
                t.total,
                f.firm_name,
                s.name AS service_name
             ${baseQuery}
             ORDER BY t.create_date DESC, t.id DESC
             LIMIT ? OFFSET ?`,
            [...params, limitNum, offset]
        );

        const data = rows.map((row) => formatTaskListItem(row));

        return res.status(200).json({
            success: true,
            message: "Task list retrieved successfully",
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
        console.error("CLIENT TASK LIST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch task list",
        });
    }
});

router.get("/details/:task_id", validateClientSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.client_username;
        const task_id = String(req.params.task_id || "").trim();

        if (!task_id) {
            return res.status(400).json({
                success: false,
                message: "task_id is required",
            });
        }

        const [rows] = await pool.query(
            `SELECT
                ${TASK_SELECT_FIELDS}
             FROM tasks t
             LEFT JOIN firms f
                ON f.firm_id = t.firm_id
                AND (f.is_deleted = '0' OR f.is_deleted = 0)
             LEFT JOIN services s
                ON s.service_id = t.service_id
             WHERE t.branch_id = ?
               AND t.username = ?
               AND t.task_id = ?
             LIMIT 1`,
            [branch_id, username, task_id]
        );

        if (!rows.length) {
            return res.status(404).json({
                success: false,
                message: "Task not found",
            });
        }

        return res.status(200).json({
            success: true,
            message: "Task details retrieved successfully",
            data: await formatTaskDetails(rows[0], branch_id),
        });
    } catch (error) {
        console.error("CLIENT TASK DETAILS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch task details",
        });
    }
});

export default router;
