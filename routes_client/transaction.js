import express from "express";
import pool from "../db.js";
import {
    ALLOWED_GENERATE_TYPES,
    buildInvoicePdfBuffer,
    normInvoiceType,
    saveInvoicePdfLink,
} from "../services/invoiceGenerateService.js";
import { validateClientSession } from "../middleware/validateClientSession.js";

const router = express.Router();

const PARTY_TYPE = "client";

function buildLedgerRow(row, username, runningBalanceRef) {
    const amount = Math.abs(Number(row.amount) || 0);
    const isParty1 = row.party1_type === PARTY_TYPE && String(row.party1_id) === username;
    const isParty2 = row.party2_type === PARTY_TYPE && String(row.party2_id) === username;

    let debit = 0;
    let credit = 0;

    if (isParty2) debit = amount;
    if (isParty1) credit = amount;

    runningBalanceRef.value = runningBalanceRef.value + (debit - credit);

    return {
        transaction_id: row.transaction_id,
        transaction_date: row.transaction_date,
        transaction_type: row.transaction_type,
        invoice_id: row.invoice_id,
        invoice_no: row.invoice_no,
        payment: {
            debit,
            credit,
            balance: Number(runningBalanceRef.value.toFixed(2)),
        },
    };
}

router.get("/list", validateClientSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.client_username;
        const {
            page_no = 1,
            limit = 20,
            from_date,
            to_date,
        } = req.query || {};

        if (!from_date || String(from_date).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "from_date is required",
            });
        }
        if (!to_date || String(to_date).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "to_date is required",
            });
        }

        const fromDate = String(from_date).trim();
        const toDate = String(to_date).trim();
        const pageNum = Math.max(1, Number(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
        const offset = (pageNum - 1) * limitNum;

        const partyFilter = `
            branch_id = ?
            AND (
                (party1_type = ? AND party1_id = ?)
                OR (party2_type = ? AND party2_id = ?)
            )
        `;
        const partyParams = [branch_id, PARTY_TYPE, username, PARTY_TYPE, username];

        const [[openingRow]] = await pool.query(
            `SELECT
                SUM(CASE
                    WHEN party2_type = ? AND party2_id = ? THEN ABS(amount)
                    ELSE 0
                END) AS debit,
                SUM(CASE
                    WHEN party1_type = ? AND party1_id = ? THEN ABS(amount)
                    ELSE 0
                END) AS credit
             FROM transactions
             WHERE ${partyFilter}
               AND transaction_date < ?`,
            [
                PARTY_TYPE,
                username,
                PARTY_TYPE,
                username,
                ...partyParams,
                fromDate,
            ]
        );

        const balanceBefore =
            (Number(openingRow?.debit ?? 0) || 0) - (Number(openingRow?.credit ?? 0) || 0);
        const openingDebit = balanceBefore >= 0 ? balanceBefore : 0;
        const openingCredit = balanceBefore < 0 ? Math.abs(balanceBefore) : 0;

        let listSql = `
            SELECT
                id,
                transaction_id,
                transaction_date,
                transaction_type,
                amount,
                invoice_id,
                invoice_no,
                party1_type,
                party1_id,
                party2_type,
                party2_id
            FROM transactions
            WHERE ${partyFilter}
              AND transaction_date >= ?
              AND transaction_date <= ?
        `;
        const listParams = [...partyParams, fromDate, toDate];

        listSql += " ORDER BY transaction_date ASC, id ASC";

        const [rows] = await pool.query(listSql, listParams);

        const runningBalanceRef = { value: balanceBefore };
        const fullList = rows.map((row) => buildLedgerRow(row, username, runningBalanceRef));

        const total = fullList.length;
        const data = fullList.slice(offset, offset + limitNum);

        return res.status(200).json({
            success: true,
            message: "Transaction ledger retrieved successfully",
            opening_balance: {
                debit: Number(openingDebit.toFixed(2)),
                credit: Number(openingCredit.toFixed(2)),
                balance: Number(balanceBefore.toFixed(2)),
            },
            data,
            pagination: {
                page_no: pageNum,
                limit: limitNum,
                total,
                total_pages: Math.ceil(total / limitNum) || 1,
                is_last_page: offset + data.length >= total,
            },
        });
    } catch (error) {
        console.error("CLIENT TRANSACTION LIST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch transaction ledger",
        });
    }
});

router.post("/generate-invoice", validateClientSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.client_username;
        const { invoice_id, type: bodyType } = req.body || {};

        if (!invoice_id || String(invoice_id).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "invoice_id is required",
            });
        }
        if (bodyType == null || String(bodyType).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "type is required (e.g. sale, receive, payment)",
            });
        }
        if (!ALLOWED_GENERATE_TYPES.has(normInvoiceType(bodyType))) {
            return res.status(400).json({
                success: false,
                message: `Invalid type. Allowed: ${[...ALLOWED_GENERATE_TYPES].sort().join(", ")}`,
            });
        }

        const built = await buildInvoicePdfBuffer(
            branch_id,
            username,
            invoice_id,
            bodyType
        );
        if (built.error) {
            return res.status(built.error.status).json({
                success: false,
                message: built.error.message,
            });
        }

        const saved = await saveInvoicePdfLink(built);

        return res.status(200).json({
            success: true,
            message: "Invoice PDF generated successfully",
            data: {
                invoice_id: built.invoice_id,
                type: built.type,
                format_id: built.formatKey,
                url: saved.url,
                filename: saved.filename,
                suggested_filename: saved.suggested_filename,
            },
        });
    } catch (error) {
        console.error("CLIENT INVOICE GENERATE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to generate invoice",
        });
    }
});

export default router;