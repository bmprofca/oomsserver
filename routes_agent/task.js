import express from "express";
import pool from "../db.js";
import { validateAgentSession } from "../middleware/validateAgentSession.js";

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

function formatTaskListItem(row, margin, charges) {
    return {
        task_id: row.task_id,
        client: {
            username: row.username,
            name: row.client_name ?? null,
            email: row.client_email ?? null,
            country_code: row.client_country_code ?? null,
            mobile: row.client_mobile ?? null,
        },
        firm: {
            firm_id: row.firm_id,
            firm_name: row.firm_name,
            firm_type: row.firm_type ?? null,
            pan_no: row.pan_no ?? null,
        },
        service: {
            service_id: row.service_id,
            name: row.service_name,
        },
        status: row.status,
        dates: {
            due_date: row.due_date,
        },
        margin: {
            margin_type: margin.margin_type,
            margin_value: margin.margin_value,
            source: margin.source,
            amount: margin.margin_type === "flat" ? margin.margin_value : margin.margin_value * charges.fees / 100,
        },
        charges: {
            fees: charges.fees,
            gst_rate: charges.gst_rate,
            gst_value: charges.gst_value,
            total: charges.total,
        },
    };
}

function resolveMargin(serviceId, globalMargin, serviceMarginMap) {
    const serviceMargin = serviceMarginMap.get(String(serviceId || "").trim());
    if (serviceMargin) {
        return {
            margin_type: serviceMargin.margin_type,
            margin_value: serviceMargin.margin_value,
            source: "service",
        };
    }

    return {
        margin_type: globalMargin.margin_type,
        margin_value: globalMargin.margin_value,
        source: "global",
    };
}

function calculateMarginAmount(taskFees, margin) {
    const fees = Number(taskFees) || 0;
    const marginValue = Number(margin.margin_value) || 0;

    if (margin.margin_type === "flat") {
        return Number(marginValue.toFixed(2));
    }

    return Number(((fees * marginValue) / 100).toFixed(2));
}

function calculateAgentCharges(taskFees, taskTaxRate, margin) {
    const gst_rate = Number(taskTaxRate) || 0;
    const fees = calculateMarginAmount(taskFees, margin);

    const gst_value = Number(((fees * gst_rate) / 100).toFixed(2));
    const total = Number((fees + gst_value).toFixed(2));

    return { fees, total };
}

async function getAgentMarginContext(branch_id, agent_username) {
    const [[clientRow]] = await pool.query(
        `SELECT margin_type, margin_value
         FROM clients
         WHERE username = ?
           AND branch_id = ?
           AND user_type = 'agent'
           AND is_deleted = '0'
         LIMIT 1`,
        [agent_username, branch_id]
    );

    const globalMargin = {
        margin_type: clientRow?.margin_type || "percentage",
        margin_value: Number(clientRow?.margin_value ?? 0) || 0,
    };

    const [serviceMarginRows] = await pool.query(
        `SELECT service_id, margin_type, margin_value
         FROM agent_margin
         WHERE username = ?
           AND branch_id = ?
           AND is_deleted = '0'`,
        [agent_username, branch_id]
    );

    const serviceMarginMap = new Map(
        serviceMarginRows.map((row) => [
            String(row.service_id || "").trim(),
            {
                margin_type: row.margin_type === "flat" ? "flat" : "percentage",
                margin_value: Number(row.margin_value ?? 0) || 0,
            },
        ])
    );

    return { globalMargin, serviceMarginMap };
}

router.get("/list", validateAgentSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const agent_username = req.agent_username;
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
              AND t.has_agent = '1'
              AND t.agent_id = ?
        `;

        const params = [branch_id, agent_username];

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

        const { globalMargin, serviceMarginMap } = await getAgentMarginContext(
            branch_id,
            agent_username
        );

        const [rows] = await pool.query(
            `SELECT
                t.task_id,
                t.username,
                t.firm_id,
                t.service_id,
                t.status,
                t.due_date,
                t.fees,
                0,
                0,
                t.total,
                f.firm_name,
                f.firm_type,
                f.pan_no,
                s.name AS service_name,
                cp.name AS client_name,
                cp.email AS client_email,
                cp.country_code AS client_country_code,
                cp.mobile AS client_mobile
             ${baseQuery}
             ORDER BY t.create_date DESC, t.id DESC
             LIMIT ? OFFSET ?`,
            [...params, limitNum, offset]
        );

        const data = rows.map((row) => {
            const resolvedMargin = resolveMargin(row.service_id, globalMargin, serviceMarginMap);
            const marginAmount = calculateMarginAmount(row.fees, resolvedMargin);
            const margin = { ...resolvedMargin, amount: marginAmount };
            const charges = calculateAgentCharges(row.fees, row.tax_rate, resolvedMargin);
            return formatTaskListItem(row, margin, charges);
        });

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
        console.error("AGENT TASK LIST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch task list",
        });
    }
});

export default router;
