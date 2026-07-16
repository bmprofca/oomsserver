import express from "express";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { UNIQUE_RANDOM_STRING, ID_LENGTH, TODAY_DATE, USER_SNIPPED_DATA, BANK_SNIPPED_DATA } from "../helpers/function.js";

const router = express.Router();


router.post("/create", auth, validateBranch, async (req, res) => {
    try {
        const username = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;
        const {
            party_1,
            party_2,
            transaction_date,
            amount,
            remark
        } = req.body || {};

        const party1_id = party_1 != null ? String(party_1).trim() : "";
        const party2_id = party_2 != null ? String(party_2).trim() : "";
        const txnDate = transaction_date != null ? String(transaction_date).trim() : "";
        const amountNum = Number(amount);
        const remarkVal = remark != null ? String(remark).trim() : null;

        if (!party1_id) {
            return res.status(400).json({ success: false, message: "party_1 is required" });
        }
        if (!party2_id) {
            return res.status(400).json({ success: false, message: "party_2 is required" });
        }
        if (!txnDate) {
            return res.status(400).json({ success: false, message: "transaction_date is required" });
        }
        if (!Number.isFinite(amountNum) || amountNum <= 0) {
            return res.status(400).json({ success: false, message: "amount must be greater than 0" });
        }
        if (party1_id === party2_id) {
            return res.status(400).json({ success: false, message: "party_1 and party_2 cannot be same bank" });
        }

        const [bankRows] = await pool.query(
            `SELECT bank_id FROM banks
             WHERE branch_id = ? AND bank_id IN (?, ?)`,
            [branch_id, party1_id, party2_id]
        );
        const bankSet = new Set(bankRows.map(el => String(el.bank_id)));
        if (!bankSet.has(party1_id)) {
            return res.status(400).json({ success: false, message: "Invalid party_1 bank_id" });
        }
        if (!bankSet.has(party2_id)) {
            return res.status(400).json({ success: false, message: "Invalid party_2 bank_id" });
        }

        const roundedAmount = Number(amountNum.toFixed(2));

        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            const invoice_id = await UNIQUE_RANDOM_STRING("invoice", "invoice_id", { length: ID_LENGTH, conn: connection });
            const transaction_id = await UNIQUE_RANDOM_STRING("transactions", "transaction_id", { length: ID_LENGTH, conn: connection });
            const contra_id = await UNIQUE_RANDOM_STRING("contra_entries", "contra_id", { length: ID_LENGTH, conn: connection });

            const [invoicePrefixRows] = await connection.query(
                "SELECT * FROM `invoice_prefix` WHERE `branch_id` = ? AND `type` = ? AND `is_deleted` = ? AND `issue_date` <= ? AND `expire_date` >= ?",
                [branch_id, "contra", "0", TODAY_DATE(), TODAY_DATE()]
            );
            if (!invoicePrefixRows || invoicePrefixRows.length === 0) {
                await connection.rollback();
                return res.status(400).json({ success: false, message: "Invoice prefix not set for contra." });
            }

            const invoiceData = invoicePrefixRows[0];
            const invoicePrimaryId = invoiceData?.id;
            const serial = Number(invoiceData?.current || 0) + 1;
            const invoice_no = `${invoiceData?.prefix}${serial}`;

            await connection.query(
                `INSERT INTO invoice (invoice_id, branch_id, invoice_no, create_by, modify_by, type, transaction_id, subtotal, discount_type, discount_perc_rate, discount_value, additional_charge, total, round_off, grand_total)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [invoice_id, branch_id, invoice_no, username, username, "contra", transaction_id, roundedAmount, "not applicable", 0, 0, 0, roundedAmount, 0, roundedAmount]
            );

            await connection.query(
                `INSERT INTO transactions (branch_id, transaction_id, create_by, modify_by, transaction_date, amount, transaction_type, invoice_id, invoice_no, party1_type, party1_id, party2_type, party2_id, remark)
                 VALUES (?, ?, ?, ?, ?, ?, 'contra', ?, ?, ?, ?, ?, ?, ?)`,
                [branch_id, transaction_id, username, username, txnDate, roundedAmount, invoice_id, invoice_no, "bank", party1_id, "bank", party2_id, remarkVal]
            );

            await connection.query(
                `INSERT INTO contra_entries (branch_id, contra_id, create_by, modify_by, invoice_id, invoice_no, transaction_id, transaction_date, from_bank_id, to_bank_id, amount, remark)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [branch_id, contra_id, username, username, invoice_id, invoice_no, transaction_id, txnDate, party1_id, party2_id, roundedAmount, remarkVal]
            );

            await connection.query("UPDATE `invoice_prefix` SET `current` = ? WHERE `id` = ?", [serial, invoicePrimaryId]);
            await connection.commit();

            return res.status(200).json({
                success: true,
                message: "Contra created successfully",
                data: {
                    contra_id,
                    invoice_id,
                    invoice_no,
                    transaction_id,
                    party_1: party1_id,
                    party_2: party2_id,
                    transaction_date: txnDate,
                    amount: roundedAmount,
                    remark: remarkVal
                }
            });
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error("Create contra fatal error:", error);
        return res.status(500).json({ success: false, message: "Failed to create contra", error: error.message });
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

        const searchClause = hasSearch
            ? `AND (
                ce.contra_id LIKE ?
                OR ce.transaction_id LIKE ?
                OR IFNULL(ce.remark, '') LIKE ?
                OR IFNULL(ce.invoice_no, '') LIKE ?
                OR IFNULL(invoice.invoice_no, '') LIKE ?
                OR IFNULL(fb.bank_id, '') LIKE ?
                OR IFNULL(fb.account_no, '') LIKE ?
                OR IFNULL(fb.holder, '') LIKE ?
                OR IFNULL(fb.ifsc, '') LIKE ?
                OR IFNULL(fb.bank, '') LIKE ?
                OR IFNULL(fb.branch, '') LIKE ?
                OR IFNULL(fb.type, '') LIKE ?
                OR IFNULL(fb.remark, '') LIKE ?
                OR IFNULL(tb.bank_id, '') LIKE ?
                OR IFNULL(tb.account_no, '') LIKE ?
                OR IFNULL(tb.holder, '') LIKE ?
                OR IFNULL(tb.ifsc, '') LIKE ?
                OR IFNULL(tb.bank, '') LIKE ?
                OR IFNULL(tb.branch, '') LIKE ?
                OR IFNULL(tb.type, '') LIKE ?
                OR IFNULL(tb.remark, '') LIKE ?
            )`
            : "";

        const fromSql = `
             FROM contra_entries ce
             LEFT JOIN invoice ON invoice.invoice_id = ce.invoice_id
             LEFT JOIN banks fb ON fb.bank_id = ce.from_bank_id AND CAST(fb.branch_id AS CHAR) = CAST(ce.branch_id AS CHAR)
             LEFT JOIN banks tb ON tb.bank_id = ce.to_bank_id AND CAST(tb.branch_id AS CHAR) = CAST(ce.branch_id AS CHAR)`;

        const whereClause = `ce.branch_id = ?
            AND (DATE(ce.transaction_date) >= ? AND DATE(ce.transaction_date) <= ?)
            ${searchClause}`;
        const params = [branch_id, from_date || "1970-01-01", to_date || "2099-12-31"];
        if (hasSearch) {
            for (let i = 0; i < 21; i++) params.push(searchPattern);
        }
        const listParams = [...params, limit, offset];

        const [rows] = await pool.query(
            `SELECT ce.*, invoice.invoice_id, invoice.invoice_no
             ${fromSql}
             WHERE ${whereClause}
             ORDER BY ce.transaction_date DESC, ce.id DESC
             LIMIT ? OFFSET ?`,
            listParams
        );

        const [[{ total: totalRows }]] = await pool.query(
            `SELECT COUNT(*) AS total
             ${fromSql}
             WHERE ${whereClause}`,
            params
        );
        const total = Number(totalRows) || 0;

        const data = [];
        for (let index = 0; index < rows.length; index++) {
            const row = rows[index];

            const create_by = await USER_SNIPPED_DATA(row.create_by);
            const modify_by = await USER_SNIPPED_DATA(row.modify_by);
            const from_bank = await BANK_SNIPPED_DATA(row.from_bank_id);
            const to_bank = await BANK_SNIPPED_DATA(row.to_bank_id);

            data.push({
                contra_id: row.contra_id,
                transaction_id: row.transaction_id,
                invoice_id: row.invoice_id,
                invoice_no: row.invoice_no,
                transaction_date: row.transaction_date,
                amount: row.amount,
                remark: row.remark,
                create_by,
                modify_by,
                payment_from: {
                    type: "bank",
                    details: from_bank
                },
                payment_to: {
                    type: "bank",
                    details: to_bank
                }
            });
        }

        return res.status(200).json({
            success: true,
            data,
            meta: {
                page_no,
                limit,
                total,
                count: data.length,
                is_last_page: offset + data.length >= total
            }
        });
    } catch (error) {
        console.error("Contra (list) error:", error);
        return res.status(500).json({ success: false, message: "Failed to get contra list", error: error.message });
    }
});

router.put("/edit", auth, validateBranch, async (req, res) => {
    try {
        const username = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;
        const {
            contra_id,
            transaction_id,
            party_1,
            party_2,
            transaction_date,
            amount,
            remark,
        } = req.body || {};

        const contraIdVal = contra_id != null ? String(contra_id).trim() : "";
        const transactionIdVal = transaction_id != null ? String(transaction_id).trim() : "";

        if (!contraIdVal && !transactionIdVal) {
            return res.status(400).json({ success: false, message: "contra_id or transaction_id is required" });
        }

        const party1_id = party_1 != null ? String(party_1).trim() : "";
        const party2_id = party_2 != null ? String(party_2).trim() : "";
        const txnDate = transaction_date != null ? String(transaction_date).trim().slice(0, 10) : "";
        const amountNum = Number(amount);
        const remarkVal = remark != null ? String(remark).trim() : null;

        if (!party1_id || !party2_id) {
            return res.status(400).json({ success: false, message: "party_1 and party_2 are required" });
        }
        if (!txnDate) {
            return res.status(400).json({ success: false, message: "transaction_date is required" });
        }
        if (!Number.isFinite(amountNum) || amountNum <= 0) {
            return res.status(400).json({ success: false, message: "amount must be greater than 0" });
        }
        if (party1_id === party2_id) {
            return res.status(400).json({ success: false, message: "party_1 and party_2 cannot be same bank" });
        }

        const [bankRows] = await pool.query(
            `SELECT bank_id FROM banks WHERE branch_id = ? AND bank_id IN (?, ?)`,
            [branch_id, party1_id, party2_id]
        );
        const bankSet = new Set(bankRows.map((el) => String(el.bank_id)));
        if (!bankSet.has(party1_id)) {
            return res.status(400).json({ success: false, message: "Invalid party_1 bank_id" });
        }
        if (!bankSet.has(party2_id)) {
            return res.status(400).json({ success: false, message: "Invalid party_2 bank_id" });
        }

        const roundedAmount = Number(amountNum.toFixed(2));
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            let resolvedTransactionId = transactionIdVal;
            if (!resolvedTransactionId && contraIdVal) {
                const [ceRows] = await connection.query(
                    `SELECT transaction_id FROM contra_entries WHERE branch_id = ? AND contra_id = ? LIMIT 1`,
                    [branch_id, contraIdVal]
                );
                if (!ceRows?.length) {
                    await connection.rollback();
                    connection.release();
                    return res.status(404).json({ success: false, message: "Contra entry not found" });
                }
                resolvedTransactionId = ceRows[0].transaction_id;
            }

            const [txnRows] = await connection.query(
                `SELECT t.transaction_id, t.invoice_id, i.type AS invoice_type
                 FROM transactions t
                 INNER JOIN invoice i ON i.invoice_id = t.invoice_id AND i.branch_id = t.branch_id
                 WHERE t.branch_id = ? AND t.transaction_id = ?
                 LIMIT 1`,
                [branch_id, resolvedTransactionId]
            );
            if (!txnRows?.length) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ success: false, message: "Transaction not found" });
            }
            const txn = txnRows[0];
            if (String(txn.invoice_type) !== "contra") {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ success: false, message: "Transaction type mismatch" });
            }

            await connection.query(
                `UPDATE transactions
                 SET modify_by = ?, transaction_date = ?, amount = ?, remark = ?,
                     party1_type = 'bank', party1_id = ?, party2_type = 'bank', party2_id = ?
                 WHERE branch_id = ? AND transaction_id = ?`,
                [username, txnDate, roundedAmount, remarkVal, party1_id, party2_id, branch_id, resolvedTransactionId]
            );
            await connection.query(
                `UPDATE invoice
                 SET modify_by = ?, subtotal = ?, total = ?, grand_total = ?
                 WHERE branch_id = ? AND invoice_id = ?`,
                [username, roundedAmount, roundedAmount, roundedAmount, branch_id, txn.invoice_id]
            );
            await connection.query(
                `UPDATE contra_entries
                 SET modify_by = ?, transaction_date = ?, from_bank_id = ?, to_bank_id = ?, amount = ?, remark = ?
                 WHERE branch_id = ? AND transaction_id = ?`,
                [username, txnDate, party1_id, party2_id, roundedAmount, remarkVal, branch_id, resolvedTransactionId]
            );

            await connection.commit();

            return res.status(200).json({
                success: true,
                message: "Contra updated successfully",
                data: {
                    contra_id: contraIdVal || null,
                    transaction_id: resolvedTransactionId,
                    amount: roundedAmount,
                    transaction_date: txnDate,
                },
            });
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error("Contra (edit) error:", error);
        return res.status(500).json({ success: false, message: "Failed to update contra", error: error.message });
    }
});

export default router;