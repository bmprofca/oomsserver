import express from "express";
import pool from "../db.js";
import { validateCaSession } from "../middleware/validateCaSession.js";

const router = express.Router();

const ALLOWED_SERVICE_TYPES = ["general", "compliance"];

/**
 * GET /ca/service/list
 * Branch services marked as added (branch_services), for CA task filters.
 * Query: page_no, limit, search, type, added_only (default true)
 */
router.get("/list", validateCaSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { search, page_no = 1, limit = 100, type, added_only } = req.query || {};

        const serviceType = type != null ? String(type).trim().toLowerCase() : "";
        if (serviceType && !ALLOWED_SERVICE_TYPES.includes(serviceType)) {
            return res.status(400).json({
                success: false,
                message: "type must be empty, 'general', or 'compliance'",
            });
        }

        const addedOnlyRaw =
            added_only === undefined || added_only === null || String(added_only).trim() === ""
                ? "true"
                : String(added_only).trim().toLowerCase();
        const addedOnly =
            addedOnlyRaw === "1" ||
            addedOnlyRaw === "true" ||
            addedOnlyRaw === "yes";

        const pageNum = Math.max(1, Number(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limit) || 100));
        const offset = (pageNum - 1) * limitNum;

        let baseQuery = `
            FROM services s
            LEFT JOIN branch_services bs
                ON bs.service_id = s.service_id
               AND bs.branch_id = ?
               AND bs.is_deleted = '0'
            WHERE s.type IN ('general', 'compliance')
        `;
        const params = [branch_id];

        if (addedOnly) {
            baseQuery += " AND bs.service_id IS NOT NULL";
        }

        if (serviceType) {
            baseQuery += " AND s.type = ?";
            params.push(serviceType);
        }

        if (search != null && String(search).trim() !== "") {
            const pattern = `%${String(search).trim()}%`;
            baseQuery += " AND (s.name LIKE ? OR s.sac_code LIKE ? OR s.service_id LIKE ?)";
            params.push(pattern, pattern, pattern);
        }

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total ${baseQuery}`,
            params
        );

        const [rows] = await pool.query(
            `SELECT
                s.service_id,
                s.name,
                s.sac_code,
                s.type,
                s.frequency,
                s.default_due_date,
                CASE WHEN bs.service_id IS NOT NULL THEN 1 ELSE 0 END AS is_added
             ${baseQuery}
             ORDER BY s.name ASC
             LIMIT ? OFFSET ?`,
            [...params, limitNum, offset]
        );

        const data = rows.map((row) => {
            const item = {
                service_id: row.service_id,
                name: row.name,
                sac_code: row.sac_code || null,
                type: row.type,
                is_added: row.is_added === 1,
            };
            if (String(row.type || "").toLowerCase() === "compliance") {
                item.frequency = row.frequency || null;
                item.default_due_date = row.default_due_date ?? null;
            }
            return item;
        });

        return res.status(200).json({
            success: true,
            message: "Service list retrieved successfully",
            data,
            pagination: {
                page_no: pageNum,
                limit: limitNum,
                total: Number(total) || 0,
                total_pages: Math.ceil((Number(total) || 0) / limitNum) || 1,
                is_last_page: offset + rows.length >= (Number(total) || 0),
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

export default router;
