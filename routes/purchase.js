import express from "express";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { USER_SNIPPED_DATA, BANK_SNIPPED_DATA } from "../helpers/function.js";
import { executeCreatePurchase } from "../helpers/purchaseCreate.js";

const router = express.Router();

async function createPurchase({
    req,
    res,
    party_id,
    party_type,
    transaction_date,
    remark,
    items
}) {
    const username = req.headers["username"] || req.headers["Username"] || "";
    const branch_id = req.branch_id;

    try {
        const data = await executeCreatePurchase({
            branch_id,
            create_by: username,
            party_id,
            party_type,
            transaction_date,
            remark,
            items,
        });
        return res.status(200).json({
            success: true,
            message: "Purchase created successfully",
            data,
        });
    } catch (err) {
        const status = err?.status || 500;
        if (status === 400) {
            return res.status(400).json({ success: false, message: err.message });
        }
        throw err;
    }
}

router.post("/create/user", auth, validateBranch, async (req, res) => {
    try {
        const {
            username,
            user_type,
            transaction_date,
            remark,
            items
        } = req.body || {};

        if (!username || String(username).trim() === "") {
            return res.status(400).json({ success: false, message: "username is required" });
        }
        if (!user_type || String(user_type).trim() === "") {
            return res.status(400).json({ success: false, message: "user_type is required" });
        }

        return await createPurchase({
            req,
            res,
            party_id: username,
            party_type: user_type,
            transaction_date,
            remark,
            items
        });
    } catch (error) {
        console.error("Create purchase fatal error:", error);
        return res.status(500).json({ success: false, message: "Failed to create purchase", error: error.message });
    }
});

router.post("/create/bank", auth, validateBranch, async (req, res) => {
    try {
        const {
            bank_id,
            transaction_date,
            remark,
            items
        } = req.body || {};

        if (!bank_id || String(bank_id).trim() === "") {
            return res.status(400).json({ success: false, message: "bank_id is required" });
        }

        const [[bankRow]] = await pool.query(
            "SELECT bank_id FROM banks WHERE branch_id = ? AND bank_id = ? LIMIT 1",
            [req.branch_id, String(bank_id).trim()]
        );
        if (!bankRow) {
            return res.status(400).json({ success: false, message: "Invalid bank_id" });
        }

        return await createPurchase({
            req,
            res,
            party_id: bank_id,
            party_type: "bank",
            transaction_date,
            remark,
            items
        });
    } catch (error) {
        console.error("Create purchase fatal error:", error);
        return res.status(500).json({ success: false, message: "Failed to create purchase", error: error.message });
    }
});

router.get("/list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const page_no = Math.max(1, Number(req.query?.page_no) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 10));
        const offset = (page_no - 1) * limit;
        const from_date = req.query?.from_date || null;
        const to_date = req.query?.to_date || null;
        const search = req.query?.search || null;
        const searchPattern = search && String(search).trim() !== "" ? `%${String(search).trim()}%` : null;
        const hasSearch = searchPattern != null;

        const fromD = from_date || "1970-01-01";
        const toD = to_date || "2099-12-31";

        let searchFilterSql = "";
        const searchFilterParams = [];
        if (hasSearch) {
            const sp = searchPattern;
            searchFilterSql = `AND (
                invoice.invoice_no LIKE ?
                OR IFNULL(transactions.remark, '') LIKE ?
                OR EXISTS (
                    SELECT 1 FROM purchase_items pi
                    LEFT JOIN services svc ON svc.service_id = pi.service_id
                    WHERE pi.purchase_id = pe.purchase_id
                        AND (
                            IFNULL(pi.service_id, '') LIKE ?
                            OR IFNULL(svc.name, '') LIKE ?
                            OR IFNULL(svc.sac_code, '') LIKE ?
                        )
                )
                OR (
                    COALESCE(LOWER(transactions.party1_type), LOWER(pe.party_type), '') <> 'bank'
                    AND (
                        EXISTS (
                            SELECT 1 FROM profile prof
                            WHERE prof.username = COALESCE(transactions.party1_id, pe.party_id)
                                AND prof.status = '1'
                                AND prof.id = (
                                    SELECT MAX(p2.id) FROM profile p2
                                    WHERE p2.username = prof.username AND p2.status = '1'
                                )
                                AND (
                                    IFNULL(prof.username, '') LIKE ?
                                    OR IFNULL(prof.name, '') LIKE ?
                                    OR IFNULL(prof.care_of, '') LIKE ?
                                    OR IFNULL(prof.guardian_name, '') LIKE ?
                                    OR IFNULL(prof.email, '') LIKE ?
                                    OR IFNULL(prof.mobile, '') LIKE ?
                                    OR IFNULL(prof.pan_number, '') LIKE ?
                                    OR IFNULL(prof.state, '') LIKE ?
                                    OR IFNULL(prof.district, '') LIKE ?
                                    OR IFNULL(prof.city, '') LIKE ?
                                    OR IFNULL(prof.village_town, '') LIKE ?
                                    OR IFNULL(prof.address_line_1, '') LIKE ?
                                    OR IFNULL(prof.address_line_2, '') LIKE ?
                                    OR IFNULL(prof.pincode, '') LIKE ?
                                )
                        )
                        OR EXISTS (
                            SELECT 1 FROM firms f
                            WHERE f.username = COALESCE(transactions.party1_id, pe.party_id)
                                AND CAST(f.branch_id AS CHAR) = CAST(pe.branch_id AS CHAR)
                                AND (f.is_deleted = '0' OR f.is_deleted = 0)
                                AND (
                                    IFNULL(f.firm_name, '') LIKE ?
                                    OR IFNULL(f.firm_id, '') LIKE ?
                                    OR IFNULL(f.username, '') LIKE ?
                                    OR IFNULL(f.firm_type, '') LIKE ?
                                    OR IFNULL(f.gst_no, '') LIKE ?
                                    OR IFNULL(f.pan_no, '') LIKE ?
                                    OR IFNULL(f.address_line_1, '') LIKE ?
                                    OR IFNULL(f.address_line_2, '') LIKE ?
                                    OR IFNULL(f.city, '') LIKE ?
                                    OR IFNULL(f.state, '') LIKE ?
                                    OR IFNULL(f.pincode, '') LIKE ?
                                )
                        )
                    )
                )
            )`;
            searchFilterParams.push(sp, sp);
            for (let i = 0; i < 3; i++) searchFilterParams.push(sp);
            for (let i = 0; i < 14; i++) searchFilterParams.push(sp);
            for (let i = 0; i < 11; i++) searchFilterParams.push(sp);
        }

        const whereClause = `CAST(pe.branch_id AS CHAR) = CAST(? AS CHAR)
            AND invoice.invoice_id = pe.invoice_id
            AND invoice.branch_id = ?
            AND invoice.type = ?
            AND (DATE(pe.purchase_date) >= ? AND DATE(pe.purchase_date) <= ?)
            ${searchFilterSql}`;
        const params = [branch_id, branch_id, "purchase", fromD, toD, ...searchFilterParams];

        const [rows] = await pool.query(
            `SELECT invoice.invoice_id, invoice.invoice_no, invoice.subtotal, invoice.discount_type, invoice.discount_perc_rate, invoice.discount_value, invoice.additional_charge, invoice.total, invoice.round_off, invoice.grand_total, transactions.*
             FROM purchase_entries pe
             INNER JOIN invoice ON invoice.invoice_id = pe.invoice_id
             LEFT JOIN transactions ON transactions.transaction_id = invoice.transaction_id
             WHERE ${whereClause}
             ORDER BY pe.purchase_date DESC, pe.id DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        const [[{ total: totalRows }]] = await pool.query(
            `SELECT COUNT(*) AS total
             FROM purchase_entries pe
             INNER JOIN invoice ON invoice.invoice_id = pe.invoice_id
             LEFT JOIN transactions ON transactions.transaction_id = invoice.transaction_id
             WHERE ${whereClause}`,
            params
        );
        const total = Number(totalRows) || 0;

        const [[{ total_amount: totalAmountRows }]] = await pool.query(
            `SELECT COALESCE(SUM(invoice.grand_total), 0) AS total_amount
             FROM purchase_entries pe
             INNER JOIN invoice ON invoice.invoice_id = pe.invoice_id
             LEFT JOIN transactions ON transactions.transaction_id = invoice.transaction_id
             WHERE ${whereClause}`,
            params
        );
        const total_amount = Number(totalAmountRows) || 0;

        const data = [];
        for (let index = 0; index < rows.length; index++) {
            const row = rows[index];
            const purchase_type = row.party1_type;
            let purchase_party = {};
            if (purchase_type === "bank") {
                purchase_party = await BANK_SNIPPED_DATA(row.party1_id);
            } else {
                purchase_party = await USER_SNIPPED_DATA(row.party1_id);
            }

            const create_by = await USER_SNIPPED_DATA(row.create_by);
            const modify_by = await USER_SNIPPED_DATA(row.modify_by);

            data.push({
                transaction_id: row.transaction_id,
                transaction_date: row.transaction_date,
                amount: row.amount,
                remark: row.remark,
                create_by,
                modify_by,
                invoice_no: row.invoice_no,
                invoice_id: row.invoice_id,
                purchase_type,
                purchase_party,
            });
        }

        return res.status(200).json({
            success: true,
            data,
            stats: {
                count: total,
                amount: total_amount
            },
            meta: {
                page_no,
                limit,
                total,
                count: data.length,
                is_last_page: offset + data.length >= total
            }
        });
    } catch (error) {
        console.error("Purchase list error:", error);
        return res.status(500).json({ success: false, message: "Failed to get purchase list", error: error.message });
    }
});

export default router;
