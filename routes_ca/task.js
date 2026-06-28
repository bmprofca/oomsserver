import express from "express";
import pool from "../db.js";
import { validateCaSession } from "../middleware/validateCaSession.js";

const router = express.Router();

const ALLOWED_STATUSES = [
    "in process",
    "pending from client",
    "pending from department",
    "complete",
    "cancel",
];

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

function formatTaskListItem(row) {
    return {
        task_id: row.task_id,
        client: {
            username: row.username,
            name: row.client_name ?? null,
        },
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
    };
}

router.get("/list", validateCaSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const ca_username = req.ca_username;
        const { page_no = 1, limit = 20, search, status } = req.query || {};

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
            LEFT JOIN profile cp
                ON cp.username = t.username
                AND cp.id = (
                    SELECT MAX(cp2.id)
                    FROM profile cp2
                    WHERE cp2.username = t.username
                )
            WHERE t.branch_id = ?
              AND t.has_ca = '1'
              AND t.ca_id = ?
        `;

        const params = [branch_id, ca_username];

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
                  OR t.username LIKE ?
                  OR cp.name LIKE ?
                  OR f.firm_name LIKE ?
                  OR s.name LIKE ?
                  OR t.status LIKE ?
              )
            `;
            params.push(
                searchPattern,
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
                t.task_id,
                t.username,
                t.firm_id,
                t.service_id,
                t.status,
                t.due_date,
                f.firm_name,
                s.name AS service_name,
                cp.name AS client_name
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
        console.error("CA TASK LIST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch task list",
        });
    }
});


export default router;
