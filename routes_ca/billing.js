import express from "express";
import pool from "../db.js";
import { validateCaSession } from "../middleware/validateCaSession.js";

const router = express.Router();

/**
 * GET /ca/billing/list?status=0|1&page_no&limit&search
 * status 0 = pending purchase (completed tasks only, is_ca_purchased=0)
 * status 1 = complete / generated purchase (is_ca_purchased=1)
 * Scoped to authenticated CA session.
 */
router.get("/list", validateCaSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const ca_username = req.ca_username;
        const page_no = Math.max(1, Number(req.query?.page_no) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 20));
        const offset = (page_no - 1) * limit;
        const search = req.query?.search != null ? String(req.query.search).trim() : "";
        const statusRaw = req.query?.status != null ? String(req.query.status).trim() : "0";
        const statusNum = Number(statusRaw);

        if (![0, 1].includes(statusNum)) {
            return res.status(400).json({
                success: false,
                message: "status must be 0 (pending) or 1 (complete)",
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
              AND t.is_ca_purchased = ?
        `;
        const params = [branch_id, ca_username, statusNum];

        // Pending purchase billing only for completed tasks
        if (statusNum === 0) {
            baseQuery += ` AND LOWER(TRIM(t.status)) = 'complete'`;
        }

        if (search) {
            const sp = `%${search}%`;
            baseQuery += `
              AND (
                  t.task_id LIKE ?
                  OR t.username LIKE ?
                  OR IFNULL(cp.name, '') LIKE ?
                  OR IFNULL(f.firm_name, '') LIKE ?
                  OR IFNULL(f.pan_no, '') LIKE ?
                  OR IFNULL(s.name, '') LIKE ?
                  OR IFNULL(s.service_id, '') LIKE ?
              )
            `;
            params.push(sp, sp, sp, sp, sp, sp, sp);
        }

        const [countRows] = await pool.query(`SELECT COUNT(*) AS total ${baseQuery}`, params);
        const total = Number(countRows[0]?.total) || 0;

        const [rows] = await pool.query(
            `SELECT
                t.task_id,
                t.username,
                t.firm_id,
                t.service_id,
                t.ca_id,
                t.status,
                t.is_ca_purchased,
                t.compliance_year,
                t.compliance_period,
                f.firm_name,
                f.pan_no AS firm_pan,
                s.name AS service_name,
                s.type AS service_type,
                cp.name AS client_name,
                (
                    SELECT pe.amount
                    FROM purchase_entries pe
                    WHERE CAST(pe.branch_id AS CHAR) = CAST(t.branch_id AS CHAR)
                      AND pe.party_type = 'ca'
                      AND pe.party_id = t.ca_id
                      AND (
                        pe.task_id = t.task_id
                        OR EXISTS (
                          SELECT 1 FROM purchase_items pi
                          WHERE pi.purchase_id = pe.purchase_id
                            AND CAST(pi.branch_id AS CHAR) = CAST(pe.branch_id AS CHAR)
                            AND pi.remark = t.task_id
                        )
                      )
                    ORDER BY pe.id DESC
                    LIMIT 1
                ) AS purchase_amount,
                (
                    SELECT pe.invoice_id
                    FROM purchase_entries pe
                    WHERE CAST(pe.branch_id AS CHAR) = CAST(t.branch_id AS CHAR)
                      AND pe.party_type = 'ca'
                      AND pe.party_id = t.ca_id
                      AND (
                        pe.task_id = t.task_id
                        OR EXISTS (
                          SELECT 1 FROM purchase_items pi
                          WHERE pi.purchase_id = pe.purchase_id
                            AND CAST(pi.branch_id AS CHAR) = CAST(pe.branch_id AS CHAR)
                            AND pi.remark = t.task_id
                        )
                      )
                    ORDER BY pe.id DESC
                    LIMIT 1
                ) AS purchase_invoice_id,
                (
                    SELECT inv.invoice_no
                    FROM purchase_entries pe
                    INNER JOIN invoice inv
                        ON inv.invoice_id = pe.invoice_id
                    WHERE CAST(pe.branch_id AS CHAR) = CAST(t.branch_id AS CHAR)
                      AND pe.party_type = 'ca'
                      AND pe.party_id = t.ca_id
                      AND (
                        pe.task_id = t.task_id
                        OR EXISTS (
                          SELECT 1 FROM purchase_items pi
                          WHERE pi.purchase_id = pe.purchase_id
                            AND CAST(pi.branch_id AS CHAR) = CAST(pe.branch_id AS CHAR)
                            AND pi.remark = t.task_id
                        )
                      )
                    ORDER BY pe.id DESC
                    LIMIT 1
                ) AS purchase_invoice_no,
                (
                    SELECT pe.purchase_date
                    FROM purchase_entries pe
                    WHERE CAST(pe.branch_id AS CHAR) = CAST(t.branch_id AS CHAR)
                      AND pe.party_type = 'ca'
                      AND pe.party_id = t.ca_id
                      AND (
                        pe.task_id = t.task_id
                        OR EXISTS (
                          SELECT 1 FROM purchase_items pi
                          WHERE pi.purchase_id = pe.purchase_id
                            AND CAST(pi.branch_id AS CHAR) = CAST(pe.branch_id AS CHAR)
                            AND pi.remark = t.task_id
                        )
                      )
                    ORDER BY pe.id DESC
                    LIMIT 1
                ) AS purchase_date
             ${baseQuery}
             ORDER BY t.create_date DESC, t.id DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        const data = rows.map((row) => {
            const isPurchased = Number(row.is_ca_purchased) || 0;
            const purchaseAmount =
                row.purchase_amount != null && Number.isFinite(Number(row.purchase_amount))
                    ? Number(row.purchase_amount)
                    : null;

            return {
                task_id: row.task_id,
                client: {
                    username: row.username,
                    name: row.client_name || null,
                },
                firm: {
                    firm_id: row.firm_id || null,
                    firm_name: row.firm_name || null,
                    pan_no: row.firm_pan || null,
                },
                service: {
                    service_id: row.service_id || null,
                    name: row.service_name || null,
                    type: row.service_type || null,
                },
                purchase_amount: isPurchased === 1 ? purchaseAmount : null,
                purchase_invoice_id: isPurchased === 1 ? row.purchase_invoice_id || null : null,
                purchase_invoice_no: isPurchased === 1 ? row.purchase_invoice_no || null : null,
                purchase_date: isPurchased === 1 ? row.purchase_date || null : null,
                compliance_year: row.compliance_year || null,
                compliance_period: row.compliance_period || null,
                status: row.status,
                is_ca_purchased: isPurchased,
            };
        });

        return res.status(200).json({
            success: true,
            message: "CA billing list retrieved successfully",
            data,
            pagination: {
                page_no,
                limit,
                total,
                total_pages: Math.max(1, Math.ceil(total / limit)),
                is_last_page: offset + rows.length >= total,
            },
        });
    } catch (error) {
        console.error("CA BILLING LIST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch billing list",
        });
    }
});

export default router;
