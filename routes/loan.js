import express from "express";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { RANDOM_STRING, TODAY_DATE, USER_SNIPPED_DATA } from "../helpers/function.js";

const router = express.Router();

const LOAN_TYPE_PREFIX_MAP = {
    loan: "loan create",
    repayment: "loan repayment",
    interest: "loan interest"
};

const ALLOWED_PARTY_TYPES = ["staff", "client", "ca", "agent"];

async function createLoanEntry({ req, res, loanType }) {
    try {
        const username = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;

        const {
            party_type,
            party_id,
            transaction_date,
            amount,
            remark
        } = req.body || {};

        if (!party_type || String(party_type).trim() === "") {
            return res.status(400).json({ success: false, message: "party_type is required" });
        }
        if (!ALLOWED_PARTY_TYPES.includes(String(party_type).trim().toLowerCase())) {
            return res.status(400).json({ success: false, message: `party_type must be one of: ${ALLOWED_PARTY_TYPES.join(", ")}` });
        }
        if (!party_id || String(party_id).trim() === "") {
            return res.status(400).json({ success: false, message: "party_id is required" });
        }
        if (!transaction_date || String(transaction_date).trim() === "") {
            return res.status(400).json({ success: false, message: "transaction_date is required" });
        }
        if (amount == null || String(amount).trim?.() === "") {
            return res.status(400).json({ success: false, message: "amount is required" });
        }

        const partyType = String(party_type).trim().toLowerCase();
        const partyId = String(party_id).trim();
        const txnDate = String(transaction_date).trim();
        const amountNum = Number(amount);
        const remarkVal = remark != null ? String(remark).trim() : null;

        if (!Number.isFinite(amountNum) || amountNum <= 0) {
            return res.status(400).json({ success: false, message: "amount must be a valid number greater than 0" });
        }

        const invoicePrefixType = LOAN_TYPE_PREFIX_MAP[loanType];

        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            const [invoicePrefixRows] = await connection.query(
                "SELECT * FROM `invoice_prefix` WHERE `branch_id` = ? AND `type` = ? AND `is_deleted` = ? AND `issue_date` <= ? AND `expire_date` >= ?",
                [branch_id, invoicePrefixType, "0", TODAY_DATE(), TODAY_DATE()]
            );

            if (!invoicePrefixRows || invoicePrefixRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ success: false, message: `Invoice prefix not set for "${invoicePrefixType}".` });
            }

            const invoiceData = invoicePrefixRows[0];
            const invoicePrimaryId = invoiceData?.id;
            const serial = Number(invoiceData?.current || 0) + 1;
            const invoice_no = `${invoiceData?.prefix}${serial}`;

            const entry_id = RANDOM_STRING(30);
            const invoice_id = RANDOM_STRING(30);
            const transaction_id = RANDOM_STRING(30);

            await connection.query(
                `INSERT INTO loan_entries (branch_id, entry_id, type, party_type, party_id, transaction_date, amount, invoice_id, invoice_no, transaction_id, remark, create_by, modify_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [branch_id, entry_id, loanType, partyType, partyId, txnDate, Number(amountNum.toFixed(2)), invoice_id, invoice_no, transaction_id, remarkVal, username, username]
            );

            await connection.query(
                "UPDATE `invoice_prefix` SET `current` = ? WHERE `id` = ?",
                [serial, invoicePrimaryId]
            );

            await connection.commit();

            return res.status(200).json({
                success: true,
                message: "Loan entry created successfully",
                data: {
                    entry_id,
                    invoice_id,
                    invoice_no,
                    transaction_id,
                    party_type: partyType,
                    party_id: partyId,
                    transaction_date: txnDate,
                    type: loanType,
                    amount: Number(amountNum.toFixed(2)),
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
        console.error(`Create loan entry (${loanType}) fatal error:`, error);
        return res.status(500).json({ success: false, message: "Failed to create loan entry", error: error.message });
    }
}

router.post("/loan/create", auth, validateBranch, (req, res) => {
    return createLoanEntry({ req, res, loanType: "loan" });
});

router.post("/repayment/create", auth, validateBranch, (req, res) => {
    return createLoanEntry({ req, res, loanType: "repayment" });
});

router.post("/interest/create", auth, validateBranch, (req, res) => {
    return createLoanEntry({ req, res, loanType: "interest" });
});

async function editLoanEntry({ req, res, loanType }) {
    try {
        const username = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;

        const {
            entry_id,
            transaction_date,
            amount,
            remark
        } = req.body || {};

        if (!entry_id || String(entry_id).trim() === "") {
            return res.status(400).json({ success: false, message: "entry_id is required" });
        }
        if (!transaction_date || String(transaction_date).trim() === "") {
            return res.status(400).json({ success: false, message: "transaction_date is required" });
        }
        if (amount == null || String(amount).trim?.() === "") {
            return res.status(400).json({ success: false, message: "amount is required" });
        }

        const entryId = String(entry_id).trim();
        const txnDate = String(transaction_date).trim();
        const amountNum = Number(amount);
        const remarkVal = remark != null ? String(remark).trim() : null;

        if (!Number.isFinite(amountNum) || amountNum <= 0) {
            return res.status(400).json({ success: false, message: "amount must be a valid number greater than 0" });
        }

        const [existingRows] = await pool.query(
            "SELECT * FROM `loan_entries` WHERE `entry_id` = ? AND `branch_id` = ? AND `type` = ?",
            [entryId, branch_id, loanType]
        );

        if (!existingRows || existingRows.length === 0) {
            return res.status(404).json({ success: false, message: "Loan entry not found" });
        }

        const existing = existingRows[0];
        const partyType = existing.party_type;
        const partyId = existing.party_id;

        await pool.query(
            `UPDATE \`loan_entries\`
             SET \`party_type\` = ?, \`party_id\` = ?, \`transaction_date\` = ?, \`amount\` = ?, \`remark\` = ?, \`modify_by\` = ?
             WHERE \`entry_id\` = ? AND \`branch_id\` = ?`,
            [partyType, partyId, txnDate, Number(amountNum.toFixed(2)), remarkVal, username, entryId, branch_id]
        );

        return res.status(200).json({
            success: true,
            message: "Loan entry updated successfully",
            data: {
                entry_id: entryId,
                invoice_id: existing.invoice_id,
                invoice_no: existing.invoice_no,
                transaction_id: existing.transaction_id,
                party_type: partyType,
                party_id: partyId,
                transaction_date: txnDate,
                type: loanType,
                amount: Number(amountNum.toFixed(2)),
                remark: remarkVal
            }
        });

    } catch (error) {
        console.error(`Edit loan entry (${loanType}) fatal error:`, error);
        return res.status(500).json({ success: false, message: "Failed to update loan entry", error: error.message });
    }
}

router.put("/loan/edit", auth, validateBranch, (req, res) => {
    return editLoanEntry({ req, res, loanType: "loan" });
});

router.put("/repayment/edit", auth, validateBranch, (req, res) => {
    return editLoanEntry({ req, res, loanType: "repayment" });
});

router.put("/interest/edit", auth, validateBranch, (req, res) => {
    return editLoanEntry({ req, res, loanType: "interest" });
});

router.get("/list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const {
            from_date,
            to_date,
            party_type,
            party_id,
            page_no = 1,
            limit: limitParam = 10
        } = req.query || {};

        const requiredFields = [
            { key: "from_date", label: "from_date" },
            { key: "to_date", label: "to_date" },
            { key: "party_type", label: "party_type" },
            { key: "party_id", label: "party_id" }
        ];

        for (const field of requiredFields) {
            const value = req.query?.[field.key];
            if (!value || String(value).trim() === "") {
                return res.status(400).json({ success: false, message: `${field.label} is required` });
            }
        }

        const fromDate = String(from_date).trim();
        const toDate = String(to_date).trim();
        const pt = String(party_type).trim();
        const pid = String(party_id).trim();
        const pageNum = Math.max(1, Number(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limitParam) || 10));
        const offset = (pageNum - 1) * limitNum;

        // Opening balance: all entries before from_date for this party
        // loan/advance/interest = debit (money owed by party), repayment = credit
        const [[openingRow]] = await pool.query(
            `SELECT
                SUM(CASE WHEN \`type\` IN ('loan', 'advance', 'interest') THEN \`amount\` ELSE 0 END) AS debit,
                SUM(CASE WHEN \`type\` = 'repayment' THEN \`amount\` ELSE 0 END) AS credit
             FROM \`loan_entries\`
             WHERE \`branch_id\` = ? AND \`party_type\` = ? AND \`party_id\` = ? AND \`transaction_date\` < ?`,
            [branch_id, pt, pid, fromDate]
        );

        const openingDebit = Number(openingRow?.debit ?? 0) || 0;
        const openingCredit = Number(openingRow?.credit ?? 0) || 0;
        let balanceBefore = openingDebit - openingCredit;

        // Fetch all rows in range (paginate in JS to compute running balance)
        const [rows] = await pool.query(
            `SELECT entry_id, invoice_id, invoice_no, transaction_id, type, amount, transaction_date, create_date, modify_date, create_by, modify_by, remark
             FROM \`loan_entries\`
             WHERE \`branch_id\` = ? AND \`party_type\` = ? AND \`party_id\` = ? AND \`transaction_date\` >= ? AND \`transaction_date\` <= ?
             ORDER BY \`transaction_date\` ASC, \`id\` ASC`,
            [branch_id, pt, pid, fromDate, toDate]
        );

        let runningBalance = balanceBefore;
        const fullList = [];

        for (const row of rows) {
            const amount = Math.abs(Number(row.amount) || 0);
            const isDebit = row.type === "loan" || row.type === "advance" || row.type === "interest";
            const rowDebit = isDebit ? amount : 0;
            const rowCredit = isDebit ? 0 : amount;
            runningBalance = runningBalance + (rowDebit - rowCredit);

            const create_by = await USER_SNIPPED_DATA(row.create_by);
            const modify_by = await USER_SNIPPED_DATA(row.modify_by);

            fullList.push({
                entry_id: row.entry_id,
                invoice_id: row.invoice_id,
                invoice_no: row.invoice_no,
                transaction_id: row.transaction_id,
                type: row.type,
                transaction_date: row.transaction_date,
                create_date: row.create_date,
                modify_date: row.modify_date,
                payment: { debit: rowDebit, credit: rowCredit, balance: runningBalance },
                particulars: { remark: row.remark ?? null },
                create_by,
                modify_by
            });
        }

        const total = fullList.length;
        const data = fullList.slice(offset, offset + limitNum);
        const count = data.length;
        const is_last_page = offset + count >= total;

        return res.status(200).json({
            success: true,
            opening_balance: {
                debit: Number(openingDebit.toFixed(2)),
                credit: Number(openingCredit.toFixed(2)),
                balance: Number(balanceBefore.toFixed(2))
            },
            data,
            meta: {
                page_no: pageNum,
                limit: limitNum,
                total,
                count,
                is_last_page
            }
        });

    } catch (error) {
        console.error("Get loan list fatal error:", error);
        return res.status(500).json({ success: false, message: "Failed to get loan list", error: error.message });
    }
});


export default router;
