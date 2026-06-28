import express from "express";
import pool from "../db.js";
import { validateCaSession } from "../middleware/validateCaSession.js";

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

function parseRequiredFields(value) {
    if (value === undefined || value === null || String(value).trim() === "") {
        return null;
    }

    try {
        return JSON.parse(value);
    } catch (_) {
        return value;
    }
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
        fields: parseRequiredFields(row.fields),
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
    s.fields,
    bs.fees,
    bs.gst_rate,
    bs.gst_value,
    bs.remark,
    bs.due_date
`;

router.get("/list", validateCaSession, async (req, res) => {
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

        return res.status(200).json({
            success: true,
            message: "Service list retrieved successfully",
            data: rows.map((row) => formatServiceListItem(row)),
            pagination: {
                page_no: pageNum,
                limit: limitNum,
                total,
                total_pages: Math.ceil(total / limitNum) || 1,
                is_last_page: offset + rows.length >= total,
            },
        });
    } catch (error) {
        console.error("CA SERVICE LIST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch service list",
        });
    }
});

router.get("/details/:service_id", validateCaSession, async (req, res) => {
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
        console.error("CA SERVICE DETAILS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch service details",
        });
    }
});

export default router;
