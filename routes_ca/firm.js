import express from "express";
import pool from "../db.js";
import { USER_DATA } from "../helpers/function.js";
import { validateCaSession } from "../middleware/validateCaSession.js";

const router = express.Router();

const FIRM_SELECT_FIELDS = `
    f.firm_id,
    f.firm_name,
    f.firm_type,
    f.username,
    f.gst_no,
    f.pan_no,
    f.file_no,
    f.cin_no,
    f.vat_no,
    f.tan_no,
    f.status,
    f.remark,
    f.create_by,
    f.create_date,
    f.modify_by,
    f.modify_date,
    f.address_line_1,
    f.address_line_2,
    f.city,
    f.district,
    f.state,
    f.pincode,
    f.country
`;

const CA_FIRM_SCOPE = `
    EXISTS (
        SELECT 1
        FROM tasks t
        WHERE t.firm_id = f.firm_id
          AND t.branch_id = f.branch_id
          AND t.has_ca = '1'
          AND t.ca_id = ?
    )
`;

function formatFirmListItem(row) {
    return {
        firm_id: row.firm_id,
        firm_name: row.firm_name,
        firm_type: row.firm_type,
        client: {
            username: row.username,
            name: row.client_name ?? null,
        },
        status: row.status === "1" || row.status === 1,
        tax: {
            gst_no: row.gst_no,
            pan_no: row.pan_no,
            file_no: row.file_no,
        },
    };
}

async function formatFirmDetails(row) {
    const [create_by, modify_by] = await Promise.all([
        USER_DATA(row.create_by),
        USER_DATA(row.modify_by),
    ]);

    return {
        firm_id: row.firm_id,
        firm_name: row.firm_name,
        firm_type: row.firm_type,
        username: row.username,
        client: {
            username: row.username,
            name: row.client_name ?? null,
        },
        status: row.status === "1" || row.status === 1,
        remark: row.remark,
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
            pincode: row.pincode,
            country: row.country,
        },
        audit: {
            create_by: {
                name: create_by?.name ?? null,
            },
            create_date: row.create_date,
            modify_by: {
                name: modify_by?.name ?? null,
            },
            modify_date: row.modify_date,
        },
    };
}

router.get("/list", validateCaSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const ca_username = req.ca_username;
        const { page_no = 1, limit = 20, search } = req.query || {};

        const pageNum = Math.max(1, Number(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
        const offset = (pageNum - 1) * limitNum;

        let baseQuery = `
            FROM firms f
            LEFT JOIN profile p
                ON p.username = f.username
                AND p.id = (
                    SELECT MAX(p2.id)
                    FROM profile p2
                    WHERE p2.username = f.username
                )
            WHERE f.branch_id = ?
              AND (f.is_deleted = '0' OR f.is_deleted = 0)
              AND ${CA_FIRM_SCOPE}
        `;

        const params = [branch_id, ca_username];

        if (search && String(search).trim() !== "") {
            const searchPattern = `%${String(search).trim()}%`;
            baseQuery += `
              AND (
                  f.firm_name LIKE ?
                  OR f.firm_id LIKE ?
                  OR f.firm_type LIKE ?
                  OR f.gst_no LIKE ?
                  OR f.pan_no LIKE ?
                  OR f.file_no LIKE ?
                  OR p.name LIKE ?
              )
            `;
            params.push(
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern
            );
        }

        const [countRows] = await pool.query(
            `SELECT COUNT(*) AS total ${baseQuery}`,
            params
        );
        const total = Number(countRows[0]?.total || 0);

        const [rows] = await pool.query(
            `SELECT
                ${FIRM_SELECT_FIELDS},
                p.name AS client_name
             ${baseQuery}
             ORDER BY f.firm_name ASC, f.id DESC
             LIMIT ? OFFSET ?`,
            [...params, limitNum, offset]
        );

        return res.status(200).json({
            success: true,
            message: "Firm list retrieved successfully",
            data: rows.map(formatFirmListItem),
            pagination: {
                page_no: pageNum,
                limit: limitNum,
                total,
                total_pages: Math.ceil(total / limitNum) || 1,
                is_last_page: offset + rows.length >= total,
            },
        });
    } catch (error) {
        console.error("CA FIRM LIST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch firm list",
        });
    }
});

router.get("/details/:firm_id", validateCaSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const ca_username = req.ca_username;
        const firm_id = String(req.params.firm_id || "").trim();

        if (!firm_id) {
            return res.status(400).json({
                success: false,
                message: "firm_id is required",
            });
        }

        const [rows] = await pool.query(
            `SELECT
                ${FIRM_SELECT_FIELDS},
                p.name AS client_name
             FROM firms f
             LEFT JOIN profile p
                ON p.username = f.username
                AND p.id = (
                    SELECT MAX(p2.id)
                    FROM profile p2
                    WHERE p2.username = f.username
                )
             WHERE f.branch_id = ?
               AND f.firm_id = ?
               AND (f.is_deleted = '0' OR f.is_deleted = 0)
               AND ${CA_FIRM_SCOPE}
             LIMIT 1`,
            [branch_id, firm_id, ca_username]
        );

        if (!rows.length) {
            return res.status(404).json({
                success: false,
                message: "Firm not found",
            });
        }

        return res.status(200).json({
            success: true,
            message: "Firm details retrieved successfully",
            data: await formatFirmDetails(rows[0]),
        });
    } catch (error) {
        console.error("CA FIRM DETAILS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch firm details",
        });
    }
});

export default router;
