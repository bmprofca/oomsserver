import express from "express";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { GET_BALANCE, RANDOM_STRING, SET_OPENING_BALANCE, EDIT_OPENING_BALANCE, USER_SNIPPED_DATA, TODAY_DATE, TIMESTAMP, CAPITAL_SNIPPED_DATA, BANK_SNIPPED_DATA } from "../helpers/function.js";

const router = express.Router();

router.post("/create", auth, validateBranch, async (req, res) => {
    try {
        const username = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;

        const {
            amount,
            party1_id,
            party2_id,
            party1_type,
            party2_type,
            remark,
            transaction_date
        } = req.body || {};

        if (amount == null || Number(amount) <= 0) {
            return res.status(400).json({ success: false, message: "Valid amount is required" });
        }
        if (!party1_id || String(party1_id).trim() === "") {
            return res.status(400).json({ success: false, message: "party1_id is required" });
        }
        if (!party2_id || String(party2_id).trim() === "") {
            return res.status(400).json({ success: false, message: "party2_id is required" });
        }
        if (!party1_type || String(party1_type).trim() === "") {
            return res.status(400).json({ success: false, message: "party1_type is required" });
        }
        if (!party2_type || String(party2_type).trim() === "") {
            return res.status(400).json({ success: false, message: "party2_type is required" });
        }

        const amountNum = Number(amount);
        const txnDate = transaction_date ? String(transaction_date).trim() : new Date().toISOString().slice(0, 10);
        const transaction_id = RANDOM_STRING(30);
        const journal_id = RANDOM_STRING(30);
        const invoice_id = RANDOM_STRING(30);
        const p1_id = String(party1_id).trim();
        const p2_id = String(party2_id).trim();
        const p1_type = String(party1_type).trim();
        const p2_type = String(party2_type).trim();
        const remarkVal = remark != null ? String(remark).trim() : null;
        let invoice_no = "";

        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            const [invoicePrefixRows] = await connection.query(
                "SELECT * FROM `invoice_prefix` WHERE `branch_id` = ? AND `type` = ? AND `is_deleted` = ? AND `issue_date` <= ? AND `expire_date` >= ?",
                [branch_id, "journal", "0", TODAY_DATE(), TODAY_DATE()]
            );

            if (!invoicePrefixRows || invoicePrefixRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ success: false, message: "Invoice prefix not set for journal." });
            }

            const invoiceData = invoicePrefixRows[0];
            const invoicePrimaryId = invoiceData?.id;
            const serial = Number(invoiceData?.current || 0) + 1;
            invoice_no = `${invoiceData?.prefix}${serial}`;

            const grandTotal = amountNum;
            await connection.query(
                `INSERT INTO invoice (invoice_id, branch_id, invoice_no, create_by, modify_by, type, transaction_id, subtotal, total, grand_total)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [invoice_id, branch_id, invoice_no, username, username, "journal", transaction_id, amountNum, amountNum, grandTotal]
            );

            await connection.query(
                `INSERT INTO transactions (branch_id, transaction_id, create_by, modify_by, transaction_date, amount, transaction_type, invoice_id, invoice_no, party1_type, party1_id, party2_type, party2_id, remark)
                 VALUES (?, ?, ?, ?, ?, ?, 'journal', ?, ?, ?, ?, ?, ?, ?)`,
                [branch_id, transaction_id, username, username, txnDate, grandTotal, invoice_id, invoice_no, p1_type, p1_id, p2_type, p2_id, remarkVal]
            );

            const amountFixed = Number(amountNum.toFixed(2));
            await connection.query(
                `INSERT INTO journal_entries (
                    branch_id, journal_id, create_by, invoice_id, invoice_no, transaction_id,
                    transaction_date, party1_type, party1_id, party2_type, party2_id,
                    amount, modify_by, is_deleted, remark
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0', ?)`,
                [
                    branch_id,
                    journal_id,
                    username,
                    invoice_id,
                    invoice_no,
                    transaction_id,
                    txnDate,
                    p1_type,
                    p1_id,
                    p2_type,
                    p2_id,
                    amountFixed,
                    username,
                    remarkVal
                ]
            );

            await connection.query("UPDATE `invoice_prefix` SET `current` = ? WHERE `id` = ?", [serial, invoicePrimaryId]);

            await connection.commit();
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }

        return res.status(200).json({
            success: true,
            message: "Journal recorded successfully",
            data: {
                journal_id,
                transaction_id,
                invoice_id,
                invoice_no,
                amount: amountNum,
                party1_type: p1_type,
                party1_id: p1_id,
                party2_type: p2_type,
                party2_id: p2_id,
                transaction_date: txnDate
            }
        });
    } catch (error) {
        console.error("Journal (create) error:", error);
        return res.status(500).json({ success: false, message: "Failed to record journal", error: error.message });
    }
});

router.put("/edit", auth, validateBranch, async (req, res) => {
    try {
        const username = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;
        const {
            journal_id,
            transaction_id,
            amount,
            party1_id,
            party2_id,
            party1_type,
            party2_type,
            remark,
            transaction_date,
        } = req.body || {};

        const journalIdVal = journal_id != null ? String(journal_id).trim() : "";
        const transactionIdVal = transaction_id != null ? String(transaction_id).trim() : "";

        if (!journalIdVal && !transactionIdVal) {
            return res.status(400).json({ success: false, message: "journal_id or transaction_id is required" });
        }
        if (amount == null || Number(amount) <= 0) {
            return res.status(400).json({ success: false, message: "Valid amount is required" });
        }
        if (!party1_id || !party2_id || !party1_type || !party2_type) {
            return res.status(400).json({ success: false, message: "party fields are required" });
        }

        const amountNum = Number(amount);
        const amountFixed = Number(amountNum.toFixed(2));
        const txnDate = transaction_date ? String(transaction_date).trim().slice(0, 10) : new Date().toISOString().slice(0, 10);
        const remarkVal = remark != null ? String(remark).trim() : null;
        const p1_id = String(party1_id).trim();
        const p2_id = String(party2_id).trim();
        const p1_type = String(party1_type).trim();
        const p2_type = String(party2_type).trim();

        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            let resolvedTransactionId = transactionIdVal;
            if (!resolvedTransactionId && journalIdVal) {
                const [jeRows] = await connection.query(
                    `SELECT transaction_id FROM journal_entries
                     WHERE branch_id = ? AND journal_id = ? AND is_deleted = '0' LIMIT 1`,
                    [branch_id, journalIdVal]
                );
                if (!jeRows?.length) {
                    await connection.rollback();
                    connection.release();
                    return res.status(404).json({ success: false, message: "Journal entry not found" });
                }
                resolvedTransactionId = jeRows[0].transaction_id;
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
            if (String(txn.invoice_type) !== "journal") {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ success: false, message: "Transaction type mismatch" });
            }

            await connection.query(
                `UPDATE transactions
                 SET modify_by = ?, transaction_date = ?, amount = ?, remark = ?,
                     party1_type = ?, party1_id = ?, party2_type = ?, party2_id = ?
                 WHERE branch_id = ? AND transaction_id = ?`,
                [username, txnDate, amountFixed, remarkVal, p1_type, p1_id, p2_type, p2_id, branch_id, resolvedTransactionId]
            );
            await connection.query(
                `UPDATE invoice
                 SET modify_by = ?, subtotal = ?, total = ?, grand_total = ?
                 WHERE branch_id = ? AND invoice_id = ?`,
                [username, amountFixed, amountFixed, amountFixed, branch_id, txn.invoice_id]
            );
            await connection.query(
                `UPDATE journal_entries
                 SET modify_by = ?, transaction_date = ?,
                     party1_type = ?, party1_id = ?, party2_type = ?, party2_id = ?,
                     amount = ?, remark = ?
                 WHERE branch_id = ? AND transaction_id = ? AND is_deleted = '0'`,
                [username, txnDate, p1_type, p1_id, p2_type, p2_id, amountFixed, remarkVal, branch_id, resolvedTransactionId]
            );

            await connection.commit();

            return res.status(200).json({
                success: true,
                message: "Journal updated successfully",
                data: {
                    journal_id: journalIdVal || null,
                    transaction_id: resolvedTransactionId,
                    amount: amountFixed,
                    party1_type: p1_type,
                    party1_id: p1_id,
                    party2_type: p2_type,
                    party2_id: p2_id,
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
        console.error("Journal (edit) error:", error);
        return res.status(500).json({ success: false, message: "Failed to update journal", error: error.message });
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

        const whereClause = `invoice.branch_id = ? AND invoice.type = ?
            AND (transactions.transaction_date >= ? AND transactions.transaction_date <= ?)
            ${hasSearch ? "AND (invoice.invoice_no LIKE ? OR transactions.remark LIKE ?)" : ""}`;
        const params = [branch_id, "journal", from_date || "1970-01-01", to_date || "2099-12-31"];
        if (hasSearch) params.push(searchPattern, searchPattern);
        const listParams = [...params, limit, offset];

        const [rows] = await pool.query(
            `SELECT invoice.invoice_id, invoice.invoice_no, transactions.*,
                    journal_entries.id AS journal_entry_pk, journal_entries.journal_id
            FROM invoice
            LEFT JOIN transactions ON invoice.transaction_id = transactions.transaction_id
            LEFT JOIN journal_entries ON journal_entries.transaction_id = transactions.transaction_id
                AND journal_entries.branch_id = ? AND journal_entries.is_deleted = '0'
            WHERE ${whereClause}
            ORDER BY transactions.transaction_date DESC, transactions.id DESC
            LIMIT ? OFFSET ?`,
            [branch_id, ...listParams]
        );

        const [[{ total: totalRows }]] = await pool.query(
            `SELECT COUNT(*) AS total FROM invoice
            LEFT JOIN transactions ON invoice.transaction_id = transactions.transaction_id
            LEFT JOIN journal_entries ON journal_entries.transaction_id = transactions.transaction_id
                AND journal_entries.branch_id = ? AND journal_entries.is_deleted = '0'
            WHERE ${whereClause}`,
            [branch_id, ...params]
        );
        const total = Number(totalRows) || 0;

        const data = [];
        for (let index = 0; index < rows.length; index++) {
            const row = rows[index];
            const transaction_id = row.transaction_id;
            const transaction_date = row.transaction_date;
            const amount = row.amount;
            const party1_type = row.party1_type;
            const party1_id = row.party1_id;
            const party2_type = row.party2_type;
            const party2_id = row.party2_id;
            const remark = row.remark;
            const invoice_no = row.invoice_no;
            const invoice_id = row.invoice_id;

            const create_by = await USER_SNIPPED_DATA(row.create_by);
            const modify_by = await USER_SNIPPED_DATA(row.modify_by);

            let party1 = {};
            if (party1_type == "bank") {
                party1 = await BANK_SNIPPED_DATA(party1_id);
            } else if (party1_type == "capital") {
                party1 = await CAPITAL_SNIPPED_DATA(party1_id);
            } else {
                party1 = await USER_SNIPPED_DATA(party1_id);
            }

            let party2 = {};
            if (party2_type == "bank") {
                party2 = await BANK_SNIPPED_DATA(party2_id);
            } else if (party2_type == "capital") {
                party2 = await CAPITAL_SNIPPED_DATA(party2_id);
            } else {
                party2 = await USER_SNIPPED_DATA(party2_id);
            }

            data.push({
                journal_id: row.journal_id || null,
                journal_entry_id: row.journal_entry_pk != null ? row.journal_entry_pk : null,
                transaction_id,
                transaction_date,
                amount,
                remark,
                create_by,
                modify_by,
                invoice_no,
                invoice_id,
                payment_from: {
                    type: party1_type,
                    details: party1
                },
                payment_to: {
                    type: party2_type,
                    details: party2
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
        console.error("Journal (list) error:", error);
        return res.status(500).json({ success: false, message: "Failed to get journal report", error: error.message });
    }
});


export default router;