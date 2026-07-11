import express from "express";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { GET_BALANCE, UNIQUE_RANDOM_STRING, ID_LENGTH, SET_OPENING_BALANCE, EDIT_OPENING_BALANCE, USER_SNIPPED_DATA, TODAY_DATE, TIMESTAMP, CAPITAL_SNIPPED_DATA, BANK_SNIPPED_DATA } from "../helpers/function.js";
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import {
    notifyPaymentReceiptEmail,
    notifyPaymentEmail,
    notifyReceivedEmail
} from "../helpers/transactionStaticEmail.js";
import { notifyPaymentReceiveWhatsapp } from "../helpers/whatsappNotification.js";

const router = express.Router();

async function updateInvoiceLinkedTransaction(connection, {
    branch_id,
    username,
    transaction_id,
    expectedInvoiceType,
    amountNum,
    txnDate,
    remarkVal,
    p1_id,
    p1_type,
    p2_id,
    p2_type,
}) {
    const [txnRows] = await connection.query(
        `SELECT t.transaction_id, t.invoice_id, i.type AS invoice_type
         FROM transactions t
         INNER JOIN invoice i ON i.invoice_id = t.invoice_id AND i.branch_id = t.branch_id
         WHERE t.branch_id = ? AND t.transaction_id = ?
         LIMIT 1`,
        [branch_id, transaction_id]
    );
    if (!txnRows?.length) {
        const err = new Error("Transaction not found");
        err.statusCode = 404;
        throw err;
    }
    const txn = txnRows[0];
    if (String(txn.invoice_type) !== String(expectedInvoiceType)) {
        const err = new Error("Transaction type mismatch");
        err.statusCode = 400;
        throw err;
    }
    const grandTotal = Number(amountNum);
    await connection.query(
        `UPDATE transactions
         SET modify_by = ?, transaction_date = ?, amount = ?, remark = ?,
             party1_type = ?, party1_id = ?, party2_type = ?, party2_id = ?
         WHERE branch_id = ? AND transaction_id = ?`,
        [username, txnDate, grandTotal, remarkVal, p1_type, p1_id, p2_type, p2_id, branch_id, transaction_id]
    );
    await connection.query(
        `UPDATE invoice
         SET modify_by = ?, subtotal = ?, total = ?, grand_total = ?
         WHERE branch_id = ? AND invoice_id = ?`,
        [username, grandTotal, grandTotal, grandTotal, branch_id, txn.invoice_id]
    );
    return txn;
}

async function getTableColumns(db, tableName) {
    const [rows] = await db.query(`SHOW COLUMNS FROM \`${tableName}\``);
    return new Set(rows.map(r => r.Field));
}

async function tableExists(db, tableName) {
    const [rows] = await db.query("SHOW TABLES LIKE ?", [tableName]);
    return rows.length > 0;
}

async function insertRow(db, tableName, data) {
    const columns = await getTableColumns(db, tableName);
    const entries = Object.entries(data).filter(([k]) => columns.has(k));

    if (entries.length === 0) {
        throw new Error(`No valid columns to insert into ${tableName}`);
    }

    const keys = entries.map(([k]) => `\`${k}\``).join(", ");
    const placeholders = entries.map(() => "?").join(", ");
    const values = entries.map(([, v]) => v);

    const [result] = await db.query(
        `INSERT INTO \`${tableName}\` (${keys}) VALUES (${placeholders})`,
        values
    );

    return result;
}

function bankRowToItem(element, balance) {

    const bank_id = element?.bank_id;
    const account_no = element?.account_no;
    const ifsc = element?.ifsc;
    const holder = element?.holder;
    const remark = element?.remark;
    const bank = element?.bank;
    const branch = element?.branch;
    const status = element?.status == '1';
    const type = element?.type;

    const object = {
        bank_id,
        holder,
        remark,
        status,
        type,
        balance
    }

    if (type != 'cash') {
        object.account_no = account_no;
        object.ifsc = ifsc;
        object.bank = bank;
        object.branch = branch;
    }

    return object;
}

const buildBankSearchWhere = (alias = "") => {
    const col = (name) => (alias ? `${alias}.${name}` : name);
    return `${col("branch_id")} = ?
        AND (${col("account_no")} LIKE ? OR ${col("holder")} LIKE ? OR ${col("ifsc")} LIKE ? OR ${col("bank")} LIKE ? OR ${col("branch")} LIKE ? OR IFNULL(${col("remark")}, '') LIKE ?)`;
};

const BANK_TYPES = ['savings', 'current', 'loan', 'cash'];

const emptyBankTypeStats = () =>
    BANK_TYPES.reduce((acc, type) => {
        acc[type] = { count: 0, balance: 0 };
        return acc;
    }, {});

const fetchBankListStats = async (branch_id, searchPattern) => {
    const whereClause = buildBankSearchWhere("b");
    const params = [branch_id, branch_id, branch_id, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern];

    const [typeRows] = await pool.query(
        `SELECT
            LOWER(b.type) AS type,
            COUNT(DISTINCT b.bank_id) AS count,
            COALESCE(SUM(bt.balance), 0) AS balance
         FROM banks b
         LEFT JOIN (
            SELECT
                bank_id,
                SUM(effect) AS balance
            FROM (
                SELECT
                    party1_id AS bank_id,
                    CASE WHEN party2_id IS NULL THEN amount ELSE -amount END AS effect
                FROM transactions
                WHERE branch_id = ? AND party1_type = 'bank'
                UNION ALL
                SELECT
                    party2_id AS bank_id,
                    amount AS effect
                FROM transactions
                WHERE branch_id = ? AND party2_type = 'bank' AND party2_id IS NOT NULL
            ) effects
            GROUP BY bank_id
         ) bt ON bt.bank_id = b.bank_id
         WHERE ${whereClause}
         GROUP BY LOWER(b.type)`,
        params
    );

    const by_type = emptyBankTypeStats();
    for (const row of typeRows || []) {
        const type = String(row?.type || '').toLowerCase();
        if (!BANK_TYPES.includes(type)) continue;
        by_type[type] = {
            count: Number(row?.count) || 0,
            balance: Number(Number(row?.balance ?? 0).toFixed(2)),
        };
    }

    return { by_type };
};


function capitalRowToItem(element, balance) {
    return {
        capital_id: element?.capital_id,
        name: element?.name,
        remark: element?.remark,
        status: true,
        balance: balance ?? 0
    };
}

async function getOppositePartySnippet(branch_id, party_type, party_id) {
    if (!party_type || !party_id) return {};
    const type = String(party_type).trim();
    const id = String(party_id).trim();
    if (type === "client") {
        const [rows] = await pool.query(
            `SELECT p.name, p.email, p.mobile, p.country_code, c.username
             FROM clients c
             LEFT JOIN profile p ON p.username = c.username AND p.id = (SELECT MAX(p2.id) FROM profile p2 WHERE p2.username = c.username)
             WHERE c.username = ? AND c.branch_id = ? AND c.is_deleted = '0' LIMIT 1`,
            [id, branch_id]
        );
        const r = rows?.[0];
        if (!r) return {};
        return {
            client: {
                username: r?.username,
                name: r?.name ?? null,
                email: r?.email ?? null,
                mobile: r?.mobile ?? null,
                country_code: r?.country_code ?? null
            }
        };
    }
    if (type === "bank") {
        const [rows] = await pool.query(
            "SELECT bank_id, account_no, holder, ifsc, bank, branch, type FROM banks WHERE branch_id = ? AND bank_id = ? LIMIT 1",
            [branch_id, id]
        );
        const r = rows?.[0];
        if (!r) return {};
        return {
            bank: {
                bank_id: r?.bank_id,
                bank: r?.bank ?? null,
                account_no: r?.account_no ?? null,
                holder: r?.holder ?? null,
                ifsc: r?.ifsc ?? null,
                branch: r?.branch ?? null,
                type: r?.type ?? null
            }
        };
    }
    return {};
}

router.post("/bank/create", auth, validateBranch, async (req, res) => {
    try {
        const username = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;

        const {
            account_no,
            holder,
            ifsc,
            bank,
            branch,
            type,
            remark,
            opening_balance = {}
        } = req.body || {};

        const normalizedType = String(type || "").toLowerCase();
        const isCashType = normalizedType === "cash";
        const accountNoForInsert = isCashType ? null : account_no;
        const ifscForInsert = isCashType ? null : ifsc;
        const bankForInsert = isCashType ? null : bank;
        const branchForInsert = isCashType ? null : branch;


        const bank_id = await UNIQUE_RANDOM_STRING("banks", "bank_id", { length: ID_LENGTH });
        await pool.query(
            "INSERT INTO `banks` (`branch_id`, `bank_id`, `create_by`, `modify_by`, `account_no`, `holder`, `ifsc`, `bank`, `branch`, `type`, `remark`) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            [
                branch_id,
                bank_id,
                username,     // create_by
                username,     // modify_by
                accountNoForInsert,
                holder,
                ifscForInsert,
                bankForInsert,
                branchForInsert,
                type,
                remark
            ]
        );


        const amount = opening_balance?.amount;
        const transaction_date = opening_balance?.date;
        const transaction_type = opening_balance?.type;

        try {
            await SET_OPENING_BALANCE({
                req,
                type: transaction_type == "credit" ? "1" : "0",
                party_type: "bank",
                party_id: bank_id,
                amount,
                remark: "",
                transaction_date
            });
        } catch (err) {
            return res.status(400).json({ success: false, message: err.message || "Opening balance not set" });
        }

        const { balance } = await GET_BALANCE({ party_type: "bank", party_id: bank_id, branch_id });
        const data = bankRowToItem(
            {
                bank_id,
                account_no: accountNoForInsert,
                holder,
                ifsc: ifscForInsert,
                bank: bankForInsert,
                branch: branchForInsert,
                type,
                remark,
                status: '1'
            },
            balance
        );

        return res.status(200).json({
            success: true,
            message: 'Bank created successfully',
            data
        });

    } catch (error) {
        console.error("Create bank fatal error:", error);
        return res.status(500).json({ success: false, message: "Failed to create bank", error: error.message });
    }
});

router.put("/bank/edit", auth, validateBranch, async (req, res) => {
    try {
        const username = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;

        const {
            bank_id,
            account_no,
            holder,
            ifsc,
            bank,
            branch,
            type,
            remark,
            opening_balance = {}
        } = req.body || {};

        if (!bank_id || String(bank_id).trim() === "") {
            return res.status(400).json({ success: false, message: "bank_id is required" });
        }

        const [bankRows] = await pool.query(
            "SELECT id, branch_id, bank_id, create_by, modify_by, account_no, holder, ifsc, bank, branch, type, remark, create_date, modify_date FROM `banks` WHERE `branch_id` = ? AND `bank_id` = ? LIMIT 1",
            [branch_id, bank_id]
        );

        if (!bankRows || bankRows.length === 0) {
            return res.status(404).json({ success: false, message: "Bank not found for this branch" });
        }

        await pool.query(
            "UPDATE `banks` SET `modify_by` = ?, `account_no` = ?, `holder` = ?, `ifsc` = ?, `bank` = ?, `branch` = ?, `type` = ?, `remark` = ? WHERE `branch_id` = ? AND `bank_id` = ?",
            [username, account_no, holder, ifsc, bank, branch, type, remark, branch_id, bank_id]
        );

        const amount = opening_balance?.amount;
        const transaction_date = opening_balance?.date;
        const transaction_type = opening_balance?.type;

        if (opening_balance && (amount != null || transaction_date != null || transaction_type != null)) {
            const [txRows] = await pool.query(
                "SELECT `transaction_id`, `transaction_date`, `amount` FROM `transactions` WHERE `branch_id` = ? AND `party1_type` = ? AND `party1_id` = ? AND `transaction_type` = ? ORDER BY `id` DESC LIMIT 1",
                [branch_id, "bank", bank_id, "opening balance"]
            );

            if (txRows && txRows.length > 0) {
                const existing = txRows[0];
                const existingAmount = Number(existing.amount) || 0;
                const derivedType = existingAmount >= 0 ? "0" : "1"; // positive=debit, negative=credit
                try {
                    await EDIT_OPENING_BALANCE({
                        req,
                        transaction_id: existing.transaction_id,
                        type: transaction_type === "credit" ? "1" : transaction_type === "debit" ? "0" : derivedType,
                        party_type: "bank",
                        party_id: bank_id,
                        amount: amount != null ? Number(amount) : Math.abs(existingAmount),
                        remark: remark ?? "",
                        transaction_date: transaction_date ?? existing.transaction_date
                    });
                } catch (err) {
                    return res.status(400).json({ success: false, message: err.message || "Failed to update opening balance" });
                }
            }
        }

        const { balance } = await GET_BALANCE({ party_type: "bank", party_id: bank_id, branch_id });
        const [updated] = await pool.query(
            "SELECT id, branch_id, bank_id, create_by, modify_by, account_no, holder, ifsc, bank, branch, type, remark, create_date, modify_date FROM `banks` WHERE `branch_id` = ? AND `bank_id` = ? LIMIT 1",
            [branch_id, bank_id]
        );
        const data = bankRowToItem(updated[0], balance);

        return res.status(200).json({
            success: true,
            message: "Bank updated successfully",
            data
        });
    } catch (error) {
        console.error("Edit bank fatal error:", error);
        return res.status(500).json({ success: false, message: "Failed to update bank", error: error.message });
    }
});

router.get('/bank/list', auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { page_no = 1, limit: limitParam = 10, search = "" } = req.query || {};
        const pageNum = Math.max(1, Number(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limitParam) || 10));
        const offset = (pageNum - 1) * limitNum;
        const searchTerm = String(search || "").trim();
        const search_sql = `%${searchTerm}%`;

        const countQuery = `
            SELECT COUNT(*) AS total FROM banks
            WHERE branch_id = ? AND (account_no LIKE ? OR holder LIKE ? OR ifsc LIKE ? OR bank LIKE ? OR branch LIKE ? OR remark LIKE ?)
        `;
        const [[{ total: totalRows }]] = await pool.query(countQuery, [
            branch_id, search_sql, search_sql, search_sql, search_sql, search_sql, search_sql
        ]);
        const total = Number(totalRows) || 0;

        const [rows] = await pool.query(
            "SELECT id, branch_id, bank_id, create_by, modify_by, account_no, holder, ifsc, bank, branch, type, remark, create_date, modify_date FROM banks WHERE branch_id = ? AND (account_no LIKE ? OR holder LIKE ? OR ifsc LIKE ? OR bank LIKE ? OR branch LIKE ? OR remark LIKE ?) ORDER BY bank_id LIMIT ? OFFSET ?",
            [branch_id, search_sql, search_sql, search_sql, search_sql, search_sql, search_sql, limitNum, offset]
        );

        const bank_list = [];
        for (let i = 0; i < rows.length; i++) {
            const element = rows[i];
            const { balance } = await GET_BALANCE({ party_type: "bank", party_id: element.bank_id, branch_id });
            bank_list.push(bankRowToItem(element, balance));
        }

        const count = bank_list.length;
        const is_last_page = offset + count >= total;
        const stats = await fetchBankListStats(branch_id, search_sql);

        return res.status(200).json({
            success: true,
            data: bank_list,
            stats,
            meta: {
                page_no: pageNum,
                limit: limitNum,
                total,
                count,
                is_last_page
            }
        });


    } catch (error) {
        console.error('Error fetching bank list:', error);
        return res.status(500).json({ success: false, message: "Failed to fetch bank list", error: error.message });
    }
});

router.get("/bank/details", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { bank_id } = req.query || {};

        if (!bank_id || String(bank_id).trim() === "") {
            return res.status(400).json({ success: false, message: "bank_id is required" });
        }

        const [rows] = await pool.query(
            "SELECT id, branch_id, bank_id, create_by, modify_by, account_no, holder, ifsc, bank, branch, type, remark, create_date, modify_date FROM banks WHERE branch_id = ? AND bank_id = ? LIMIT 1",
            [branch_id, String(bank_id).trim()]
        );

        if (!rows || rows.length === 0) {
            return res.status(404).json({ success: false, message: "Bank not found for this branch" });
        }

        const element = rows[0];
        const { balance } = await GET_BALANCE({ party_type: "bank", party_id: element.bank_id, branch_id });
        const data = bankRowToItem(element, balance);

        return res.status(200).json({
            success: true,
            data
        });
    } catch (error) {
        console.error("Bank details error:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch bank details", error: error.message });
    }
});

router.get("/list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const {
            from_date,
            to_date,
            invoice_no,
            limit: limitParam = 10,
            page_no = 1,
            party_type,
            party_id
        } = req.query || {};

        const requiredFields = [
            { key: 'from_date', label: 'from_date' },
            { key: 'to_date', label: 'to_date' },
            { key: 'party_type', label: 'party_type' },
            { key: 'party_id', label: 'party_id' }
        ];

        for (const field of requiredFields) {
            const value = req.query?.[field.key];
            if (!value || String(value).trim() === "") {
                return res.status(400).json({ success: false, message: `${field.label} is required` });
            }
        }

        const fromDate = String(from_date).trim();
        const toDate = String(to_date).trim();
        const pageNum = Math.max(1, Number(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limitParam) || 10));
        const offset = (pageNum - 1) * limitNum;
        const invoiceFilter = invoice_no != null && String(invoice_no).trim() !== "";
        const invoicePattern = invoiceFilter ? `%${String(invoice_no).trim()}%` : null;

        // Ledger rule: if requested party is in party1 => credit, if in party2 => debit.
        const [[openingRow]] = await pool.query(
            `SELECT
                SUM(CASE
                    WHEN \`party2_type\` = ? AND \`party2_id\` = ? THEN ABS(amount)
                    ELSE 0
                END) AS debit,
                SUM(CASE
                    WHEN \`party1_type\` = ? AND \`party1_id\` = ? THEN ABS(amount)
                    ELSE 0
                END) AS credit
            FROM \`transactions\` WHERE \`branch_id\` = ? AND (\`party1_type\` = ? AND \`party1_id\` = ? OR \`party2_type\` = ? AND \`party2_id\` = ?) AND \`transaction_date\` < ?`,
            [party_type, party_id, party_type, party_id, branch_id, party_type, party_id, party_type, party_id, fromDate]
        );
        const balanceBefore = (Number(openingRow?.debit ?? 0) || 0) - (Number(openingRow?.credit ?? 0) || 0);
        // Opening display: balance 500 => {debit:500,credit:0,balance:500}. balance -500 => {debit:0,credit:500,balance:-500}
        const openingDebit = balanceBefore >= 0 ? balanceBefore : 0;
        const openingCredit = balanceBefore < 0 ? Math.abs(balanceBefore) : 0;

        const baseWhere = "`branch_id` = ? AND (`party1_type` = ? AND `party1_id` = ? OR `party2_type` = ? AND `party2_id` = ?) AND `transaction_date` >= ? AND `transaction_date` <= ?";
        const baseParams = [branch_id, party_type, party_id, party_type, party_id, fromDate, toDate];
        const countParams = [...baseParams];
        const listParams = [...baseParams];
        if (invoiceFilter) {
            countParams.push(invoicePattern);
            listParams.push(invoicePattern);
        }

        const listSql = `SELECT transaction_id, create_date, create_by, modify_date, modify_by, transaction_date, transaction_type, amount, invoice_id, invoice_no, party1_type, party1_id, party2_type, party2_id, remark FROM \`transactions\` WHERE ${baseWhere}${invoiceFilter ? " AND `invoice_no` LIKE ?" : ""} ORDER BY \`transaction_date\` ASC, \`id\` ASC`;
        const [rows] = await pool.query(listSql, listParams);
        const pt = String(party_type).trim();
        const pid = String(party_id).trim();

        const oppositeKeys = new Set();
        for (const row of rows) {
            const isParty2 = (row.party2_type === pt && String(row.party2_id) === pid);
            const oppType = isParty2 ? row.party1_type : row.party2_type;
            const oppId = isParty2 ? row.party1_id : row.party2_id;
            if (oppType && oppId) oppositeKeys.add(`${oppType}|${oppId}`);
        }
        const oppositeCache = new Map();
        await Promise.all([...oppositeKeys].map(async (key) => {
            const [oppType, oppId] = key.split("|");
            const snippet = await getOppositePartySnippet(branch_id, oppType, oppId);
            oppositeCache.set(key, snippet);
        }));

        let runningBalance = balanceBefore;
        const fullList = [];
        for (const row of rows) {
            const { id, create_by: create_by_username, modify_by: modify_by_username, party1_type: p1t, party1_id: p1id, party2_type: p2t, party2_id: p2id, ...rest } = row;
            const amount = Math.abs(Number(row.amount) || 0);
            const isParty1 = (row.party1_type === pt && String(row.party1_id) === pid);
            const isParty2 = (row.party2_type === pt && String(row.party2_id) === pid);
            // Ledger rule: party1 => credit, party2 => debit (independent of opposite party null/non-null).
            let rowDebit = 0, rowCredit = 0;
            if (isParty2) rowDebit = amount;
            if (isParty1) rowCredit = amount;
            runningBalance = runningBalance + (rowDebit - rowCredit);

            const oppType = isParty2 ? row.party1_type : row.party2_type;
            const oppId = isParty2 ? row.party1_id : row.party2_id;
            const hasOppositeParty = oppType && oppId;
            const oppKey = hasOppositeParty ? `${oppType}|${oppId}` : null;
            const oppositeSnippet = oppKey ? (oppositeCache.get(oppKey) || {}) : {};
            const details = oppositeSnippet.bank || oppositeSnippet.client || {};
            const particular = hasOppositeParty
                ? { type: oppType, details, remark: row.remark ?? null }
                : { remark: row.remark ?? null };

            const create_by = await USER_SNIPPED_DATA(create_by_username);
            const modify_by = await USER_SNIPPED_DATA(modify_by_username);

            if (row.transaction_type === "sale") {
                const [saleRows] = await pool.query(
                    "SELECT services.name, sale_items.tax_perc, sale_items.fees, sale_items.tax_value, sale_items.total, sale_items.remark FROM `sale_items` JOIN `services` ON `sale_items`.`service_id` = `services`.`service_id` WHERE `sale_items`.`branch_id` = ? AND `sale_items`.`invoice_id` = ? ORDER BY `sale_items`.`id` ASC",
                    [branch_id, row.invoice_id]
                );
                const sale_items = saleRows.map(item => {
                    return {
                        name: item.name,
                        fees: Number(item.fees),
                        tax_rate: Number(item.tax_perc),
                        tax_value: Number(item.tax_value),
                        total: Number(item.total),
                        remark: item.remark ?? null
                    }
                });
                particular.sale_items = sale_items;
            }

            fullList.push({
                transaction_id: row.transaction_id,
                create_date: row.create_date,
                modify_date: row.modify_date,
                transaction_date: row.transaction_date,
                transaction_type: row.transaction_type,
                payment: { debit: rowDebit, credit: rowCredit, balance: runningBalance },
                invoice_id: row.invoice_id,
                invoice_no: row.invoice_no,
                create_by,
                modify_by,
                particular
            });
        }

        const total = fullList.length;
        const data = fullList.slice(offset, offset + limitNum);
        const count = data.length;
        const is_last_page = offset + count >= total;

        return res.status(200).json({
            success: true,
            opening_balance: {
                debit: openingDebit,
                credit: openingCredit,
                balance: balanceBefore
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
        console.error("Transaction history error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch transaction history",
            error: error.message
        });
    }
});

router.post("/payment/receive", auth, validateBranch, async (req, res) => {
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
            transaction_date,
            notification
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

        const p2_type = String(party2_type).trim();
        const allowedReceiverTypes = ["bank", "capital"];
        if (!allowedReceiverTypes.includes(p2_type)) {
            return res.status(400).json({
                success: false,
                message: `party2_type must be one of: ${allowedReceiverTypes.join(", ")} (money is received into bank/capital)`
            });
        }

        const amountNum = Number(amount);
        const txnDate = transaction_date ? String(transaction_date).trim() : new Date().toISOString().slice(0, 10);
        const p1_id = String(party1_id).trim();
        const p2_id = String(party2_id).trim();
        const p1_type = String(party1_type).trim();
        const remarkVal = remark != null ? String(remark).trim() : null;
        const shouldNotifyEmail = notification?.email !== false;
        const shouldNotifyWhatsapp = notification?.whatsapp !== false;
        const shouldNotifySms = notification?.sms === true;

        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            const transaction_id = await UNIQUE_RANDOM_STRING("transactions", "transaction_id", { length: ID_LENGTH, conn: connection });
            const invoice_id = await UNIQUE_RANDOM_STRING("invoice", "invoice_id", { length: ID_LENGTH, conn: connection });

            const [invoicePrefixRows] = await connection.query(
                "SELECT * FROM `invoice_prefix` WHERE `branch_id` = ? AND `type` = ? AND `is_deleted` = ? AND `issue_date` <= ? AND `expire_date` >= ?",
                [branch_id, "receive", "0", TODAY_DATE(), TODAY_DATE()]
            );

            if (!invoicePrefixRows || invoicePrefixRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ success: false, message: "Invoice prefix not set for receive." });
            }

            const invoiceData = invoicePrefixRows[0];
            const invoicePrimaryId = invoiceData?.id;
            const serial = Number(invoiceData?.current || 0) + 1;
            const invoice_no = `${invoiceData?.prefix}${serial}`;

            const grandTotal = amountNum;
            await connection.query(
                `INSERT INTO invoice (invoice_id, branch_id, invoice_no, create_by, modify_by, type, transaction_id, subtotal, total, grand_total)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [invoice_id, branch_id, invoice_no, username, username, "payment receive", transaction_id, amountNum, amountNum, grandTotal]
            );

            // Receive: party1=sender (client/other), party2=receiver (bank/capital). remark on transactions.
            await connection.query(
                `INSERT INTO transactions (branch_id, transaction_id, create_by, modify_by, transaction_date, amount, transaction_type, invoice_id, invoice_no, party1_type, party1_id, party2_type, party2_id, remark)
                 VALUES (?, ?, ?, ?, ?, ?, 'receive', ?, ?, ?, ?, ?, ?, ?)`,
                [branch_id, transaction_id, username, username, txnDate, grandTotal, invoice_id, invoice_no, p1_type, p1_id, p2_type, p2_id, remarkVal]
            );

            await connection.query("UPDATE `invoice_prefix` SET `current` = ? WHERE `id` = ?", [serial, invoicePrimaryId]);

            await connection.commit();
            if (shouldNotifyEmail) {
                await notifyPaymentReceiptEmail({
                    branch_id: branch_id,
                    transaction_id: transaction_id,
                    amount: amountNum,
                    party1_id: p1_id,
                    party1_type: p1_type,
                    party2_id: p2_id,
                    party2_type: p2_type,
                    transaction_date: txnDate,
                    remark: remarkVal,
                    invoice_no: invoice_no
                });
            }
            if (shouldNotifyWhatsapp) {
                notifyPaymentReceiveWhatsapp({
                    branch_id,
                    amount: amountNum,
                    party1_id: p1_id,
                    party1_type: p1_type,
                    transaction_date: txnDate,
                    invoice_no,
                    received_by: username,
                });
            }
            if (shouldNotifySms) {
                // SMS notification hook is not wired for payment receive yet.
            }
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }

        return res.status(200).json({
            success: true,
            message: "Payment received successfully",
            data: { transaction_id, amount: amountNum, party1_type: p1_type, party1_id: p1_id, party2_type: p2_type, party2_id: p2_id, transaction_date: txnDate }
        });



    } catch (error) {
        console.error("Payment receive error:", error);
        return res.status(500).json({ success: false, message: "Failed to record payment", error: error.message });
    }
});

router.post("/payment/payment", auth, validateBranch, async (req, res) => {
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
            transaction_date,
            notification
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

        const p1_type = String(party1_type).trim();
        const allowedParty1Types = ["bank", "capital"];
        if (!allowedParty1Types.includes(p1_type)) {
            return res.status(400).json({
                success: false,
                message: `party1_type must be one of: ${allowedParty1Types.join(", ")}`
            });
        }

        const amountNum = Number(amount);
        const txnDate = transaction_date ? String(transaction_date).trim() : new Date().toISOString().slice(0, 10);
        const p1_id = String(party1_id).trim();
        const p2_id = String(party2_id).trim();
        const p2_type = String(party2_type).trim();
        const remarkVal = remark != null ? String(remark).trim() : null;
        const shouldNotifyEmail = notification?.email !== false;
        const shouldNotifySms = notification?.sms === true;

        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            const transaction_id = await UNIQUE_RANDOM_STRING("transactions", "transaction_id", { length: ID_LENGTH, conn: connection });
            const invoice_id = await UNIQUE_RANDOM_STRING("invoice", "invoice_id", { length: ID_LENGTH, conn: connection });

            const [invoicePrefixRows] = await connection.query(
                "SELECT * FROM `invoice_prefix` WHERE `branch_id` = ? AND `type` = ? AND `is_deleted` = ? AND `issue_date` <= ? AND `expire_date` >= ?",
                [branch_id, "payment", "0", TODAY_DATE(), TODAY_DATE()]
            );

            if (!invoicePrefixRows || invoicePrefixRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ success: false, message: "Invoice prefix not set for payment." });
            }

            const invoiceData = invoicePrefixRows[0];
            const invoicePrimaryId = invoiceData?.id;
            const serial = Number(invoiceData?.current || 0) + 1;
            const invoice_no = `${invoiceData?.prefix}${serial}`;

            const grandTotal = amountNum;
            await connection.query(
                `INSERT INTO invoice (invoice_id, branch_id, invoice_no, create_by, modify_by, type, transaction_id, subtotal, total, grand_total)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [invoice_id, branch_id, invoice_no, username, username, "payment", transaction_id, amountNum, amountNum, grandTotal]
            );

            // party1=sender (bank), party2=receiver for payment. remark on transactions.
            await connection.query(
                `INSERT INTO transactions (branch_id, transaction_id, create_by, modify_by, transaction_date, amount, transaction_type, invoice_id, invoice_no, party1_type, party1_id, party2_type, party2_id, remark)
                 VALUES (?, ?, ?, ?, ?, ?, 'payment', ?, ?, ?, ?, ?, ?, ?)`,
                [branch_id, transaction_id, username, username, txnDate, grandTotal, invoice_id, invoice_no, p1_type, p1_id, p2_type, p2_id, remarkVal]
            );

            await connection.query("UPDATE `invoice_prefix` SET `current` = ? WHERE `id` = ?", [serial, invoicePrimaryId]);

            await connection.commit();
            if (shouldNotifyEmail) {
                await notifyPaymentEmail({
                    branch_id: branch_id,
                    transaction_id: transaction_id,
                    amount: amountNum,
                    party1_id: p1_id,
                    party1_type: p1_type,
                    party2_id: p2_id,
                    party2_type: p2_type,
                    transaction_date: txnDate,
                    remark: remarkVal,
                    invoice_no: invoice_no
                });
            }
            if (shouldNotifySms) {
                // SMS notification hook is not wired for payment yet.
            }
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }

        return res.status(200).json({
            success: true,
            message: "Payment recorded successfully",
            data: { transaction_id, amount: amountNum, party1_type: p1_type, party1_id: p1_id, party2_type: p2_type, party2_id: p2_id, transaction_date: txnDate }
        });
    } catch (error) {
        console.error("Payment (payment) error:", error);
        return res.status(500).json({ success: false, message: "Failed to record payment", error: error.message });
    }
});

router.post("/payment/journal", auth, validateBranch, async (req, res) => {
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
        const p1_id = String(party1_id).trim();
        const p2_id = String(party2_id).trim();
        const p1_type = String(party1_type).trim();
        const p2_type = String(party2_type).trim();
        const remarkVal = remark != null ? String(remark).trim() : null;

        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            const transaction_id = await UNIQUE_RANDOM_STRING("transactions", "transaction_id", { length: ID_LENGTH, conn: connection });
            const journal_id = await UNIQUE_RANDOM_STRING("journal_entries", "journal_id", { length: ID_LENGTH, conn: connection });
            const invoice_id = await UNIQUE_RANDOM_STRING("invoice", "invoice_id", { length: ID_LENGTH, conn: connection });

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
            const invoice_no = `${invoiceData?.prefix}${serial}`;

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
                amount: amountNum,
                party1_type: p1_type,
                party1_id: p1_id,
                party2_type: p2_type,
                party2_id: p2_id,
                transaction_date: txnDate
            }
        });
    } catch (error) {
        console.error("Payment (journal) error:", error);
        return res.status(500).json({ success: false, message: "Failed to record journal", error: error.message });
    }
});

router.put("/payment/payment/edit", auth, validateBranch, async (req, res) => {
    try {
        const username = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;
        const {
            transaction_id,
            amount,
            party1_id,
            party2_id,
            party1_type,
            party2_type,
            remark,
            transaction_date,
        } = req.body || {};

        if (!transaction_id || String(transaction_id).trim() === "") {
            return res.status(400).json({ success: false, message: "transaction_id is required" });
        }
        if (amount == null || Number(amount) <= 0) {
            return res.status(400).json({ success: false, message: "Valid amount is required" });
        }
        if (!party1_id || !party2_id || !party1_type || !party2_type) {
            return res.status(400).json({ success: false, message: "party fields are required" });
        }

        const amountNum = Number(amount);
        const txnDate = transaction_date ? String(transaction_date).trim().slice(0, 10) : new Date().toISOString().slice(0, 10);
        const remarkVal = remark != null ? String(remark).trim() : null;
        const p1_id = String(party1_id).trim();
        const p2_id = String(party2_id).trim();
        const p1_type = String(party1_type).trim();
        const p2_type = String(party2_type).trim();

        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            await updateInvoiceLinkedTransaction(connection, {
                branch_id,
                username,
                transaction_id: String(transaction_id).trim(),
                expectedInvoiceType: "payment",
                amountNum,
                txnDate,
                remarkVal,
                p1_id,
                p1_type,
                p2_id,
                p2_type,
            });
            await connection.commit();
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }

        return res.status(200).json({
            success: true,
            message: "Payment updated successfully",
            data: {
                transaction_id: String(transaction_id).trim(),
                amount: amountNum,
                party1_type: p1_type,
                party1_id: p1_id,
                party2_type: p2_type,
                party2_id: p2_id,
                transaction_date: txnDate,
            },
        });
    } catch (error) {
        console.error("Payment (edit) error:", error);
        const status = error.statusCode || 500;
        return res.status(status).json({
            success: false,
            message: error.statusCode ? error.message : "Failed to update payment",
            error: error.message,
        });
    }
});

router.put("/payment/receive/edit", auth, validateBranch, async (req, res) => {
    try {
        const username = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;
        const {
            transaction_id,
            amount,
            party1_id,
            party2_id,
            party1_type,
            party2_type,
            remark,
            transaction_date,
        } = req.body || {};

        if (!transaction_id || String(transaction_id).trim() === "") {
            return res.status(400).json({ success: false, message: "transaction_id is required" });
        }
        if (amount == null || Number(amount) <= 0) {
            return res.status(400).json({ success: false, message: "Valid amount is required" });
        }
        if (!party1_id || !party2_id || !party1_type || !party2_type) {
            return res.status(400).json({ success: false, message: "party fields are required" });
        }

        const amountNum = Number(amount);
        const txnDate = transaction_date ? String(transaction_date).trim().slice(0, 10) : new Date().toISOString().slice(0, 10);
        const remarkVal = remark != null ? String(remark).trim() : null;
        const p1_id = String(party1_id).trim();
        const p2_id = String(party2_id).trim();
        const p1_type = String(party1_type).trim();
        const p2_type = String(party2_type).trim();

        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            await updateInvoiceLinkedTransaction(connection, {
                branch_id,
                username,
                transaction_id: String(transaction_id).trim(),
                expectedInvoiceType: "payment receive",
                amountNum,
                txnDate,
                remarkVal,
                p1_id,
                p1_type,
                p2_id,
                p2_type,
            });
            await connection.commit();
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }

        return res.status(200).json({
            success: true,
            message: "Payment receive updated successfully",
            data: {
                transaction_id: String(transaction_id).trim(),
                amount: amountNum,
                party1_type: p1_type,
                party1_id: p1_id,
                party2_type: p2_type,
                party2_id: p2_id,
                transaction_date: txnDate,
            },
        });
    } catch (error) {
        console.error("Payment receive (edit) error:", error);
        const status = error.statusCode || 500;
        return res.status(status).json({
            success: false,
            message: error.statusCode ? error.message : "Failed to update payment receive",
            error: error.message,
        });
    }
});

router.get("/report/payment", auth, validateBranch, async (req, res) => {
    try {
        const username = req.headers["username"] || req.headers["Username"] || "";
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
        const params = [branch_id, 'payment', from_date || '1970-01-01', to_date || '2099-12-31'];
        if (hasSearch) params.push(searchPattern, searchPattern);
        const listParams = [...params, limit, offset];

        const [rows] = await pool.query(
            `SELECT invoice.invoice_id, invoice.invoice_no, transactions.*
            FROM invoice
            LEFT JOIN transactions ON invoice.transaction_id = transactions.transaction_id
            WHERE ${whereClause}
            ORDER BY transactions.transaction_date DESC, transactions.id DESC
            LIMIT ? OFFSET ?`,
            listParams
        );

        const [[{ total: totalRows }]] = await pool.query(
            `SELECT COUNT(*) AS total FROM invoice
            LEFT JOIN transactions ON invoice.transaction_id = transactions.transaction_id
            WHERE ${whereClause}`,
            params
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
            if (party1_type == 'bank') {
                party1 = await BANK_SNIPPED_DATA(party1_id);
            }
            if (party1_type == 'capital') {
                party1 = await CAPITAL_SNIPPED_DATA(party1_id);
            }
            const party2 = await USER_SNIPPED_DATA(party2_id);

            data.push({
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
        console.error("Payment (report) error:", error);
        return res.status(500).json({ success: false, message: "Failed to get payment report", error: error.message });
    }
});

router.get("/report/journal", auth, validateBranch, async (req, res) => {
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
            `SELECT invoice.invoice_id, invoice.invoice_no, transactions.*
            FROM invoice
            LEFT JOIN transactions ON invoice.transaction_id = transactions.transaction_id
            WHERE ${whereClause}
            ORDER BY transactions.transaction_date DESC, transactions.id DESC
            LIMIT ? OFFSET ?`,
            listParams
        );

        const [[{ total: totalRows }]] = await pool.query(
            `SELECT COUNT(*) AS total FROM invoice
            LEFT JOIN transactions ON invoice.transaction_id = transactions.transaction_id
            WHERE ${whereClause}`,
            params
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
        console.error("Journal (report) error:", error);
        return res.status(500).json({ success: false, message: "Failed to get journal report", error: error.message });
    }
});

router.get("/report/receive", auth, validateBranch, async (req, res) => {
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
        const params = [branch_id, "payment receive", from_date || "1970-01-01", to_date || "2099-12-31"];
        if (hasSearch) params.push(searchPattern, searchPattern);
        const listParams = [...params, limit, offset];

        const [rows] = await pool.query(
            `SELECT invoice.invoice_id, invoice.invoice_no, transactions.*
            FROM invoice
            LEFT JOIN transactions ON invoice.transaction_id = transactions.transaction_id
            WHERE ${whereClause}
            ORDER BY transactions.transaction_date DESC, transactions.id DESC
            LIMIT ? OFFSET ?`,
            listParams
        );

        const [[{ total: totalRows }]] = await pool.query(
            `SELECT COUNT(*) AS total FROM invoice
            LEFT JOIN transactions ON invoice.transaction_id = transactions.transaction_id
            WHERE ${whereClause}`,
            params
        );
        const total = Number(totalRows) || 0;

        const statsParams = [branch_id, "payment receive", from_date || "1970-01-01", to_date || "2099-12-31"];
        const [[statsRow]] = await pool.query(
            `SELECT
                COUNT(*) AS count,
                COALESCE(SUM(transactions.amount), 0) AS amount
             FROM invoice
             LEFT JOIN transactions ON invoice.transaction_id = transactions.transaction_id
             WHERE invoice.branch_id = ? AND invoice.type = ?
               AND (transactions.transaction_date >= ? AND transactions.transaction_date <= ?)`,
            statsParams
        );
        const stats = {
            count: Number(statsRow?.count) || 0,
            amount: Number(Number(statsRow?.amount ?? 0).toFixed(2)),
        };

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

            // Receive report switches party mapping:
            // from = party1 (sender), to = party2 (receiver)
            const receive_from = await USER_SNIPPED_DATA(party1_id);
            let receive_to = {};
            if (party2_type == "bank") {
                receive_to = await BANK_SNIPPED_DATA(party2_id);
            }
            if (party2_type == "capital") {
                receive_to = await CAPITAL_SNIPPED_DATA(party2_id);
            }

            data.push({
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
                    details: receive_from
                },
                payment_to: {
                    type: party2_type,
                    details: receive_to
                }
            });
        }

        return res.status(200).json({
            success: true,
            data,
            stats,
            meta: {
                page_no,
                limit,
                total,
                count: data.length,
                is_last_page: offset + data.length >= total
            }
        });
    } catch (error) {
        console.error("Receive (report) error:", error);
        return res.status(500).json({ success: false, message: "Failed to get receive report", error: error.message });
    }
});

router.post("/set-opening-balance", auth, validateBranch, async (req, res) => {
    try {
        const username = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;

        const {
            amount,
            type,
            party_type,
            party_id,
            remark,
            transaction_date
        } = req.body || {};

        if (amount == null || Number(amount) <= 0) {
            return res.status(400).json({ success: false, message: "Valid amount is required" });
        }

        if (!party_type || String(party_type).trim() === "") {
            return res.status(400).json({ success: false, message: "party_type is required" });
        }
        if (!party_id || String(party_id).trim() === "") {
            return res.status(400).json({ success: false, message: "party_id is required" });
        }

        if (type == null || String(type).trim() === "") {
            return res.status(400).json({ success: false, message: "type is required" });
        }

        if (type != "credit" && type != "debit") {
            return res.status(400).json({ success: false, message: "type must be credit or debit" });
        }

        if (transaction_date == null || String(transaction_date).trim() === "") {
            return res.status(400).json({ success: false, message: "transaction_date is required" });
        }

        const txnDate = String(transaction_date).trim();

        const [check_opening_balance_exist] = await pool.query(
            `SELECT * FROM transactions 
             WHERE branch_id = ? 
               AND ((party1_type = ? AND party1_id = ?) OR (party2_type = ? AND party2_id = ?)) 
               AND transaction_type = 'opening balance'`,
            [branch_id, party_type, party_id, party_type, party_id]
        );

        let party1_id = "";
        let party1_type = "";
        let party2_id = "";
        let party2_type = "";

        if (type == "credit") {
            party1_id = party_id;
            party1_type = party_type;
        } else {
            party2_id = party_id;
            party2_type = party_type;
        }

        const remarkVal = remark != null && String(remark).trim() !== "" ? String(remark).trim() : null;
        const amountNum = Number(amount);
        const absAmount = Math.abs(amountNum);
        const signedAmount = type === "credit" ? -absAmount : absAmount;

        if (check_opening_balance_exist.length > 0) {
            const transaction_id = check_opening_balance_exist[0].transaction_id;

            await pool.query(
                "UPDATE transactions SET remark = ?, modify_by = ?, modify_date = ?, transaction_date = ?, party1_id = ?, party1_type = ?, party2_id = ?, party2_type = ?, amount = ? WHERE transaction_id = ?",
                [remarkVal, username, TIMESTAMP(), txnDate, party1_id || null, party1_type || null, party2_id || null, party2_type || null, absAmount, transaction_id]
            );

            await pool.query(
                "UPDATE `invoice` SET `modify_date` = ?, `modify_by` = ?, `create_date` = ?, `subtotal` = ?, `total` = ?, `grand_total` = ? WHERE transaction_id = ?",
                [TIMESTAMP(), username, txnDate, absAmount, absAmount, absAmount, transaction_id]
            );

            return res.status(200).json({
                success: true,
                message: "Opening balance updated successfully",
                data: { transaction_id, amount: amountNum, type, party_type, party_id, transaction_date: txnDate }
            });
        }

        let connection;
        try {
            connection = await pool.getConnection();
            await connection.beginTransaction();

            const [invoicePrefixRows] = await connection.query(
                "SELECT * FROM `invoice_prefix` WHERE `branch_id` = ? AND `type` = ? AND `is_deleted` = ? AND `issue_date` <= ? AND `expire_date` >= ?",
                [branch_id, "opening balance", "0", TODAY_DATE(), TODAY_DATE()]
            );

            if (!invoicePrefixRows || invoicePrefixRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ success: false, message: "Invoice prefix not set for opening balance." });
            }

            const invoiceData = invoicePrefixRows[0];
            const invoicePrimaryId = invoiceData?.id;
            const serial = Number(invoiceData?.current || 0) + 1;
            const invoice_no = `${invoiceData?.prefix}${serial}`;

            const transaction_id = await UNIQUE_RANDOM_STRING("transactions", "transaction_id", { length: ID_LENGTH, conn: connection });
            const invoice_id = await UNIQUE_RANDOM_STRING("invoice", "invoice_id", { length: ID_LENGTH, conn: connection });

            const grandTotal = absAmount;
            await connection.query(
                `INSERT INTO invoice (invoice_id, branch_id, invoice_no, create_by, modify_by, type, transaction_id, subtotal, total, grand_total)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [invoice_id, branch_id, invoice_no, username, username, "opening balance", transaction_id, absAmount, absAmount, grandTotal]
            );

            await connection.query(
                `INSERT INTO transactions (branch_id, transaction_id, create_by, modify_by, transaction_date, amount, transaction_type, invoice_id, invoice_no, party1_type, party1_id, party2_type, party2_id, remark)
                 VALUES (?, ?, ?, ?, ?, ?, 'opening balance', ?, ?, ?, ?, ?, ?, ?)`,
                [branch_id, transaction_id, username, username, txnDate, grandTotal, invoice_id, invoice_no, party1_type || null, party1_id || null, party2_type || null, party2_id || null, remarkVal]
            );

            await connection.query("UPDATE `invoice_prefix` SET `current` = ? WHERE `id` = ?", [serial, invoicePrimaryId]);

            await connection.commit();
            connection.release();

            return res.status(200).json({
                success: true,
                message: "Opening balance set successfully",
                data: { transaction_id, invoice_id, invoice_no, amount: amountNum, type, party_type, party_id, transaction_date: txnDate }
            });
        } catch (err) {
            if (connection) {
                await connection.rollback();
                connection.release();
            }
            throw err;
        }
    } catch (error) {
        console.error("Set opening balance error:", error);
        return res.status(500).json({ success: false, message: "Failed to set opening balance", error: error.message });
    }
});

router.get("/get-opening-balance", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;

        const {
            party_type,
            party_id,
        } = req.query || {};

        if (!party_type || String(party_type).trim() === "") {
            return res.status(400).json({ success: false, message: "party_type is required" });
        }
        if (!party_id || String(party_id).trim() === "") {
            return res.status(400).json({ success: false, message: "party_id is required" });
        }


        const [check_opening_balance_exist] = await pool.query(
            `SELECT * FROM transactions 
             WHERE branch_id = ? 
               AND ((party1_type = ? AND party1_id = ?) OR (party2_type = ? AND party2_id = ?)) 
               AND transaction_type = 'opening balance'`,
            [branch_id, party_type, party_id, party_type, party_id]
        );

        if (check_opening_balance_exist.length > 0) {
            const opening_balance_data = check_opening_balance_exist[0];
            let type = "";
            if (opening_balance_data.party1_type == party_type && String(opening_balance_data.party1_id) === String(party_id)) {
                type = "credit";
            } else {
                type = "debit";
            }

            return res.status(200).json({
                success: true,
                message: "Opening balance fetched successfully",
                data: {
                    transaction_id: opening_balance_data.transaction_id,
                    amount: Math.abs(Number(opening_balance_data.amount) || 0),
                    type,
                    party_type,
                    party_id,
                    transaction_date: opening_balance_data.transaction_date,
                    remark: opening_balance_data.remark ?? null,
                    invoice_no: opening_balance_data.invoice_no ?? null
                }
            });
        } else {
            return res.status(200).json({
                success: true,
                message: "Opening balance not set",
                data: null
            });
        }

    } catch (error) {
        console.error("Get opening balance error:", error);
        return res.status(500).json({ success: false, message: "Failed to get opening balance", error: error.message });
    }
});

// Add this route to your existing transactions.js file
router.get("/download/ledger", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const {
            from_date,
            to_date,
            party_type,
            party_id,
            format = 'pdf'
        } = req.query || {};

        // Validate required fields
        const requiredFields = [
            { key: 'from_date', label: 'from_date' },
            { key: 'to_date', label: 'to_date' },
            { key: 'party_type', label: 'party_type' },
            { key: 'party_id', label: 'party_id' }
        ];

        for (const field of requiredFields) {
            const value = req.query?.[field.key];
            if (!value || String(value).trim() === "") {
                return res.status(400).json({ success: false, message: `${field.label} is required` });
            }
        }

        const fromDate = String(from_date).trim();
        const toDate = String(to_date).trim();
        const partyType = String(party_type).trim();
        const partyId = String(party_id).trim();

        // Get party details for header
        let partyDetails = {
            name: partyId,
            type: partyType === 'client' ? 'Client' : 'Bank',
            id: partyId
        };

        if (partyType === "client") {
            const [rows] = await pool.query(
                `SELECT p.name, p.email, p.mobile, c.username
                 FROM clients c
                 LEFT JOIN profile p ON p.username = c.username AND p.id = (SELECT MAX(p2.id) FROM profile p2 WHERE p2.username = c.username)
                 WHERE c.username = ? AND c.branch_id = ? AND c.is_deleted = '0' LIMIT 1`,
                [partyId, branch_id]
            );
            if (rows[0]) {
                partyDetails = {
                    name: rows[0].name || rows[0].username,
                    email: rows[0].email,
                    mobile: rows[0].mobile,
                    type: "Client",
                    id: rows[0].username
                };
            }
        } else if (partyType === "bank") {
            const [rows] = await pool.query(
                "SELECT bank_id, account_no, holder, ifsc, bank, branch, type FROM banks WHERE branch_id = ? AND bank_id = ? LIMIT 1",
                [branch_id, partyId]
            );
            if (rows[0]) {
                partyDetails = {
                    name: rows[0].holder || rows[0].bank,
                    account_no: rows[0].account_no,
                    ifsc: rows[0].ifsc,
                    bank: rows[0].bank,
                    type: "Bank",
                    id: rows[0].bank_id
                };
            }
        }

        // Get opening balance - MATCHING /transaction/list LOGIC
        const [[openingRow]] = await pool.query(
            `SELECT
                SUM(CASE
                    WHEN \`party1_type\` = ? AND \`party1_id\` = ? AND \`party2_id\` IS NULL AND amount > 0 THEN ABS(amount)
                    WHEN \`party2_type\` = ? AND \`party2_id\` = ? THEN ABS(amount)
                    ELSE 0
                END) AS debit,
                SUM(CASE
                    WHEN \`party1_type\` = ? AND \`party1_id\` = ? AND (\`party2_id\` IS NULL AND amount < 0 OR \`party2_id\` IS NOT NULL) THEN ABS(amount)
                    ELSE 0
                END) AS credit
            FROM \`transactions\` WHERE \`branch_id\` = ? AND (\`party1_type\` = ? AND \`party1_id\` = ? OR \`party2_type\` = ? AND \`party2_id\` = ?) AND \`transaction_date\` < ?`,
            [partyType, partyId, partyType, partyId, partyType, partyId, partyType, partyId, branch_id, partyType, partyId, partyType, partyId, fromDate]
        );

        const balanceBefore = (Number(openingRow?.debit ?? 0) || 0) - (Number(openingRow?.credit ?? 0) || 0);
        const openingDebit = balanceBefore >= 0 ? balanceBefore : 0;
        const openingCredit = balanceBefore < 0 ? Math.abs(balanceBefore) : 0;

        // Get transactions - MATCHING /transaction/list LOGIC
        const [transactions] = await pool.query(
            `SELECT transaction_id, transaction_date, transaction_type, amount, 
                    invoice_no, party1_type, party1_id, party2_type, party2_id, remark 
             FROM \`transactions\` 
             WHERE branch_id = ? 
               AND (party1_type = ? AND party1_id = ? OR party2_type = ? AND party2_id = ?) 
               AND transaction_date >= ? 
               AND transaction_date <= ?
             ORDER BY transaction_date ASC, id ASC`,
            [branch_id, partyType, partyId, partyType, partyId, fromDate, toDate]
        );

        // Get opposite party snippets - MATCHING /transaction/list LOGIC
        const oppositeKeys = new Set();
        for (const row of transactions) {
            const isParty2 = (row.party2_type === partyType && String(row.party2_id) === partyId);
            const oppType = isParty2 ? row.party1_type : row.party2_type;
            const oppId = isParty2 ? row.party1_id : row.party2_id;
            if (oppType && oppId) oppositeKeys.add(`${oppType}|${oppId}`);
        }

        const oppositeCache = new Map();
        await Promise.all([...oppositeKeys].map(async (key) => {
            const [oppType, oppId] = key.split("|");
            const snippet = await getOppositePartySnippet(branch_id, oppType, oppId);
            oppositeCache.set(key, snippet);
        }));

        // Process transactions - MATCHING /transaction/list LOGIC
        let runningBalance = balanceBefore;
        const statementData = [];

        for (const row of transactions) {
            const amount = Math.abs(Number(row.amount) || 0);
            const isParty1 = (row.party1_type === partyType && String(row.party1_id) === partyId);
            const isParty2 = (row.party2_type === partyType && String(row.party2_id) === partyId);

            let rowDebit = 0, rowCredit = 0;
            if (row.party2_id == null) {
                const amt = Number(row.amount) || 0;
                if (amt > 0) rowDebit = amt;
                else rowCredit = Math.abs(amt);
            } else if (isParty1) {
                rowCredit = amount;
            } else if (isParty2) {
                rowDebit = amount;
            }

            runningBalance = runningBalance + (rowDebit - rowCredit);

            // Get opposite party details
            const oppType = isParty2 ? row.party1_type : row.party2_type;
            const oppId = isParty2 ? row.party1_id : row.party2_id;
            const hasOppositeParty = oppType && oppId;
            const oppKey = hasOppositeParty ? `${oppType}|${oppId}` : null;
            const oppositeSnippet = oppKey ? (oppositeCache.get(oppKey) || {}) : {};
            const details = oppositeSnippet.bank || oppositeSnippet.client || {};

            let particular = "";
            if (hasOppositeParty) {
                if (oppType === "client") {
                    particular = details.name || details.username || "";
                } else if (oppType === "bank") {
                    particular = details.holder || details.bank || "";
                }
            }

            if (!particular && row.remark) {
                particular = row.remark;
            }

            if (!particular) {
                particular = "-";
            }

            statementData.push({
                date: row.transaction_date,
                particular: particular,
                invoice_no: row.invoice_no || "-",
                debit: rowDebit,
                credit: rowCredit,
                balance: runningBalance
            });
        }

        // Generate filename
        const filename = `ledger_${partyType}_${partyId}_${fromDate}_to_${toDate}`;

        // Generate file based on format
        switch (format.toLowerCase()) {
            case 'excel':
                await generateExcel(res, statementData, partyDetails, fromDate, toDate, openingDebit, openingCredit, balanceBefore, filename);
                break;
            case 'csv':
                await generateCSV(res, statementData, partyDetails, fromDate, toDate, openingDebit, openingCredit, balanceBefore, filename);
                break;
            case 'pdf':
            default:
                await generatePDF(res, statementData, partyDetails, fromDate, toDate, openingDebit, openingCredit, balanceBefore, filename);
                break;
        }

    } catch (error) {
        console.error("Ledger download error:", error);
        if (!res.headersSent) {
            return res.status(500).json({
                success: false,
                message: "Failed to generate ledger statement",
                error: error.message
            });
        }
    }
});

// Helper function to format date
function formatDateForDisplay(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return dateString;
    return date.toISOString().split('T')[0];
}

function formatDateForReport(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return dateString;
    return date.toLocaleDateString('en-GB');
}

async function generatePDF(res, data, partyDetails, fromDate, toDate, openingDebit, openingCredit, openingBalance, filename) {
    try {
        // Input validation
        if (!res || typeof res.setHeader !== 'function') {
            throw new Error('Invalid response object');
        }

        // Professional PDF configuration
        const doc = new PDFDocument({
            margin: 50,
            size: 'A4',
            bufferPages: true,
            layout: 'portrait',
            info: {
                Title: `Ledger Statement - ${partyDetails.name || 'Account'}`,
                Author: 'Accounting System',
                Subject: 'Ledger Statement Report',
                Keywords: 'ledger, statement, accounting'
            }
        });

        // Set response headers
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=${filename}.pdf`);
        res.setHeader('Cache-Control', 'no-cache');

        doc.pipe(res);

        // Calculate table width and margins for professional centering
        const pageWidth = doc.page.width - 100; // A4 width is 595, minus margins (50 each side) = 495
        const tableWidth = 540; // Increased table width for better use of space
        const leftMargin = (doc.page.width - tableWidth) / 2; // Center the table

        // Define table column positions and widths (professional layout with balanced margins)
        const tableConfig = {
            startX: leftMargin,
            columns: {
                date: {
                    x: leftMargin,
                    width: 80,
                    label: 'DATE',
                    align: 'left'
                },
                particulars: {
                    x: leftMargin + 85,
                    width: 170,
                    label: 'PARTICULARS',
                    align: 'left'
                },
                invoiceNo: {
                    x: leftMargin + 260,
                    width: 85,
                    label: 'INVOICE NO.',
                    align: 'left'
                },
                debit: {
                    x: leftMargin + 350,
                    width: 85,
                    label: 'DEBIT (₹)',
                    align: 'right'
                },
                credit: {
                    x: leftMargin + 440,
                    width: 85,
                    label: 'CREDIT (₹)',
                    align: 'right'
                },
                balance: {
                    x: leftMargin + 530,
                    width: 90,
                    label: 'BALANCE (₹)',
                    align: 'right'
                }
            },
            rowHeight: 24,
            headerHeight: 35,
            footerMargin: 60
        };

        // Helper function to format currency
        function formatCurrency(amount) {
            return '₹' + amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        }

        // Helper function to format date for display
        function formatDateForDisplay(date) {
            if (!date) return '-';
            const d = new Date(date);
            return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
        }

        // Helper function to format date for report
        function formatDateForReport(date) {
            if (!date) return '-';
            const d = new Date(date);
            return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
        }

        // Helper function to draw table header
        function drawTableHeader(y) {
            // Background for header with gradient effect
            doc.rect(tableConfig.startX, y, tableWidth, tableConfig.headerHeight)
                .fill('#1e3c72');

            doc.fillColor('#ffffff')
                .font('Helvetica-Bold')
                .fontSize(10);

            // Draw header text with proper alignment
            Object.keys(tableConfig.columns).forEach(col => {
                const colConfig = tableConfig.columns[col];
                doc.text(
                    colConfig.label,
                    colConfig.x,
                    y + 12,
                    {
                        width: colConfig.width,
                        align: colConfig.align || 'left',
                        lineBreak: false
                    }
                );
            });

            doc.fillColor('#000000');
            return y + tableConfig.headerHeight;
        }

        // Helper function to draw table row
        function drawTableRow(row, y, isAlternate = false, rowNumber = 0) {
            // Alternate row background for better readability
            if (isAlternate) {
                doc.rect(tableConfig.startX, y, tableWidth, tableConfig.rowHeight)
                    .fill('#f8f9fc');
            }

            // Draw row border with subtle color
            doc.rect(tableConfig.startX, y, tableWidth, tableConfig.rowHeight)
                .stroke('#e2e8f0');

            doc.font('Helvetica')
                .fontSize(9)
                .fillColor('#1a202c');

            // Date with proper formatting
            const dateText = formatDateForDisplay(row.date) || '-';
            doc.text(
                dateText,
                tableConfig.columns.date.x,
                y + 7,
                { width: tableConfig.columns.date.width, align: 'left' }
            );

            // Particulars with professional truncation
            let particulars = row.particular || row.description || '-';
            if (particulars.length > 40) {
                particulars = particulars.substring(0, 37) + '...';
            }
            doc.text(
                particulars,
                tableConfig.columns.particulars.x,
                y + 7,
                { width: tableConfig.columns.particulars.width, align: 'left' }
            );

            // Invoice No
            const invoiceText = row.invoice_no || row.invoiceNumber || '-';
            doc.text(
                invoiceText,
                tableConfig.columns.invoiceNo.x,
                y + 7,
                { width: tableConfig.columns.invoiceNo.width, align: 'left' }
            );

            // Debit amount with professional formatting
            const debitAmount = row.debit || 0;
            if (debitAmount > 0) {
                doc.fillColor('#dc2626');
                doc.text(
                    formatCurrency(debitAmount),
                    tableConfig.columns.debit.x,
                    y + 7,
                    { width: tableConfig.columns.debit.width, align: 'right' }
                );
                doc.fillColor('#1a202c');
            } else {
                doc.text(
                    '-',
                    tableConfig.columns.debit.x,
                    y + 7,
                    { width: tableConfig.columns.debit.width, align: 'right' }
                );
            }

            // Credit amount with professional formatting
            const creditAmount = row.credit || 0;
            if (creditAmount > 0) {
                doc.fillColor('#10b981');
                doc.text(
                    formatCurrency(creditAmount),
                    tableConfig.columns.credit.x,
                    y + 7,
                    { width: tableConfig.columns.credit.width, align: 'right' }
                );
                doc.fillColor('#1a202c');
            } else {
                doc.text(
                    '-',
                    tableConfig.columns.credit.x,
                    y + 7,
                    { width: tableConfig.columns.credit.width, align: 'right' }
                );
            }

            // Balance with conditional formatting
            let balance = row.balance || 0;
            if (balance < 0) {
                doc.fillColor('#dc2626');
            } else if (balance > 0) {
                doc.fillColor('#10b981');
            }
            doc.font('Helvetica-Bold');
            doc.text(
                formatCurrency(Math.abs(balance)),
                tableConfig.columns.balance.x,
                y + 7,
                { width: tableConfig.columns.balance.width, align: 'right' }
            );
            doc.font('Helvetica');
            doc.fillColor('#1a202c');

            return y + tableConfig.rowHeight;
        }

        // Professional Header Section
        let currentY = 40;

        // Company Header with border
        doc.rect(40, currentY, 515, 70)
            .fill('#ffffff')
            .stroke('#e2e8f0');

        // Main Title
        doc.font('Helvetica-Bold')
            .fontSize(24)
            .fillColor('#1e3c72')
            .text('LEDGER STATEMENT', 40, currentY + 20, { align: 'center', width: 515 });

        currentY += 85;

        // Party Details Card - Professional Grid Layout
        doc.rect(40, currentY, 515, 85)
            .fill('#ffffff')
            .stroke('#e2e8f0');

        doc.fillColor('#1e3c72')
            .font('Helvetica-Bold')
            .fontSize(12)
            .text('PARTY INFORMATION', 55, currentY + 12);

        doc.font('Helvetica')
            .fontSize(9);

        // Left Column - Party Details
        let detailsY = currentY + 38;
        doc.fillColor('#4a5568');
        doc.text('Party Name:', 55, detailsY, { continued: true });
        doc.fillColor('#1a202c')
            .font('Helvetica-Bold')
            .text(` ${partyDetails.name || partyDetails.id || 'N/A'}`, { continued: false });

        doc.fillColor('#4a5568');
        doc.text('Party Type:', 55, detailsY + 18, { continued: true });
        doc.fillColor('#1a202c')
            .font('Helvetica-Bold')
            .text(` ${partyDetails.type || 'Customer'}`, { continued: false });

        // Right Column - Account Details
        if (partyDetails.account_no) {
            doc.fillColor('#4a5568');
            doc.text('Account No:', 290, detailsY, { continued: true });
            doc.fillColor('#1a202c')
                .font('Helvetica-Bold')
                .text(` ${partyDetails.account_no}`, { continued: false });

            doc.fillColor('#4a5568');
            doc.text('IFSC Code:', 290, detailsY + 18, { continued: true });
            doc.fillColor('#1a202c')
                .font('Helvetica-Bold')
                .text(` ${partyDetails.ifsc || 'N/A'}`, { continued: false });
        }

        currentY += 100;

        // Period and Opening Balance Section
        // Period Information
        doc.fillColor('#4a5568')
            .font('Helvetica')
            .fontSize(10);
        doc.text('Statement Period:', 40, currentY, { continued: true });
        doc.fillColor('#1e3c72')
            .font('Helvetica-Bold')
            .text(` ${formatDateForReport(fromDate)} to ${formatDateForReport(toDate)}`);

        currentY += 25;

        // Opening Balance Card
        doc.rect(40, currentY, 515, 45)
            .fill('#f7fafc')
            .stroke('#e2e8f0');

        doc.fillColor('#1e3c72')
            .font('Helvetica-Bold')
            .fontSize(11)
            .text('OPENING BALANCE', 55, currentY + 12);

        doc.font('Helvetica')
            .fontSize(10);

        // Opening Balance Details with professional alignment
        const openingBalanceValue = openingDebit - openingCredit;
        doc.fillColor('#4a5568');
        doc.text('Debit:', 300, currentY + 14, { continued: true });
        doc.fillColor('#dc2626')
            .text(` ${formatCurrency(openingDebit)}`, { continued: false });

        doc.fillColor('#4a5568');
        doc.text('Credit:', 400, currentY + 14, { continued: true });
        doc.fillColor('#10b981')
            .text(` ${formatCurrency(openingCredit)}`, { continued: false });

        doc.fillColor('#4a5568');
        doc.text('Balance:', 500, currentY + 14, { continued: true });
        doc.fillColor(openingBalanceValue >= 0 ? '#10b981' : '#dc2626')
            .font('Helvetica-Bold')
            .text(` ${formatCurrency(openingBalanceValue)}`, { continued: false });

        currentY += 60;

        // Check for data
        if (!data || data.length === 0) {
            doc.fontSize(12)
                .fillColor('#718096')
                .text('No transactions found for the selected period.', 40, currentY + 50, { align: 'center' });
            doc.end();
            return;
        }

        // Draw Table Header
        currentY = drawTableHeader(currentY);

        // Draw Table Rows
        let rowCount = 0;
        let runningBalance = openingBalanceValue;

        for (const row of data) {
            // Check for page break with professional margin
            if (currentY > doc.page.height - 80) {
                // Add page number to current page
                const totalPages = doc.bufferedPageRange().count;
                doc.switchToPage(doc.page - 1);
                doc.fontSize(8)
                    .fillColor('#a0aec0')
                    .text(
                        `Generated on: ${new Date().toLocaleString('en-IN')} | Page ${doc.page} of ${totalPages}`,
                        40,
                        doc.page.height - 30,
                        { align: 'center' }
                    );

                // Add new page
                doc.addPage();
                currentY = 40;

                // Redraw header on new page
                currentY = drawTableHeader(currentY);
            }

            // Update running balance if not provided
            if (!row.balance && row.balance !== 0) {
                if (row.debit) runningBalance += row.debit;
                if (row.credit) runningBalance -= row.credit;
                row.balance = runningBalance;
            }

            // Draw row with alternate background
            currentY = drawTableRow(row, currentY, rowCount % 2 === 1, rowCount);
            rowCount++;
        }

        // Draw Footer Summary
        currentY += 15;

        // Summary Card
        const lastRow = data[data.length - 1];
        const closingBalance = lastRow ? lastRow.balance : openingBalanceValue;
        const totalDebit = data.reduce((sum, row) => sum + (row.debit || 0), 0);
        const totalCredit = data.reduce((sum, row) => sum + (row.credit || 0), 0);

        doc.rect(40, currentY, 515, 70)
            .fill('#ffffff')
            .stroke('#e2e8f0');

        doc.fillColor('#1e3c72')
            .font('Helvetica-Bold')
            .fontSize(11)
            .text('TRANSACTION SUMMARY', 55, currentY + 12);

        doc.font('Helvetica')
            .fontSize(10);

        // Summary Details
        doc.fillColor('#4a5568');
        doc.text('Total Debit:', 300, currentY + 35, { continued: true });
        doc.fillColor('#dc2626')
            .font('Helvetica-Bold')
            .text(` ${formatCurrency(totalDebit)}`, { continued: false });

        doc.fillColor('#4a5568');
        doc.text('Total Credit:', 430, currentY + 35, { continued: true });
        doc.fillColor('#10b981')
            .font('Helvetica-Bold')
            .text(` ${formatCurrency(totalCredit)}`, { continued: false });

        doc.fillColor('#4a5568');
        doc.text('Closing Balance:', 55, currentY + 55, { continued: true });
        doc.fillColor(closingBalance >= 0 ? '#10b981' : '#dc2626')
            .font('Helvetica-Bold')
            .fontSize(11)
            .text(` ${formatCurrency(closingBalance)}`, { continued: false });

        // Add page numbers to all pages
        const totalPages = doc.bufferedPageRange().count;
        for (let i = 0; i < totalPages; i++) {
            doc.switchToPage(i);
            doc.fontSize(8)
                .fillColor('#a0aec0')
                .text(
                    `Generated on: ${new Date().toLocaleString('en-IN')} | Page ${i + 1} of ${totalPages}`,
                    40,
                    doc.page.height - 30,
                    { align: 'center' }
                );
        }

        doc.end();

    } catch (error) {
        console.error('PDF Generation Error:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to generate PDF', details: error.message });
        }
    }
}



// Excel Generation Function
async function generateExcel(res, data, partyDetails, fromDate, toDate, openingDebit, openingCredit, openingBalance, filename) {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Ledger Statement');

    const titleStyle = { font: { bold: true, size: 14 }, alignment: { horizontal: 'center' } };
    const headerStyle = {
        font: { bold: true, size: 11, color: { argb: 'FFFFFFFF' } },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } },
        alignment: { horizontal: 'center', vertical: 'middle' }
    };

    worksheet.mergeCells('A1:F1');
    worksheet.getCell('A1').value = 'Ledger Statement';
    worksheet.getCell('A1').style = titleStyle;

    worksheet.addRow([]);
    worksheet.addRow(['Party Type:', partyDetails.type || 'Unknown']);
    worksheet.addRow(['Party:', partyDetails.name || partyDetails.id || 'N/A']);
    if (partyDetails.account_no) {
        worksheet.addRow(['Account No:', partyDetails.account_no]);
        worksheet.addRow(['IFSC:', partyDetails.ifsc || 'N/A']);
    }
    worksheet.addRow(['Period:', `${formatDateForReport(fromDate)} to ${formatDateForReport(toDate)}`]);
    worksheet.addRow([]);

    worksheet.addRow(['Opening Balance:']);
    worksheet.addRow(['Debit:', openingDebit.toFixed(2)]);
    worksheet.addRow(['Credit:', openingCredit.toFixed(2)]);
    worksheet.addRow(['Balance:', openingBalance.toFixed(2)]);
    worksheet.addRow([]);

    const headers = ['Date', 'Particulars', 'Invoice No', 'Debit (₹)', 'Credit (₹)', 'Balance (₹)'];
    const headerRow = worksheet.addRow(headers);
    headerRow.eachCell((cell) => { cell.style = headerStyle; });

    for (const row of data) {
        worksheet.addRow([
            formatDateForDisplay(row.date),
            row.particular,
            row.invoice_no,
            row.debit !== 0 ? row.debit : null,
            row.credit !== 0 ? row.credit : null,
            row.balance
        ]);
    }

    worksheet.columns.forEach(column => {
        column.eachCell({ includeEmpty: true }, (cell, rowNumber) => {
            if (rowNumber > 10 && typeof cell.value === 'number') {
                cell.numFmt = '#,##0.00';
            }
        });
        let maxLength = 0;
        column.eachCell({ includeEmpty: true }, cell => {
            const columnLength = cell.value ? cell.value.toString().length : 10;
            if (columnLength > maxLength) maxLength = columnLength;
        });
        column.width = Math.min(maxLength + 2, 50);
    });

    worksheet.addRow([]);
    worksheet.addRow([`Generated on: ${new Date().toLocaleString()}`]);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}.xlsx`);

    await workbook.xlsx.write(res);
    res.end();
}

// CSV Generation Function
async function generateCSV(res, data, partyDetails, fromDate, toDate, openingDebit, openingCredit, openingBalance, filename) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}.csv`);

    const rows = [
        ['Ledger Statement'],
        [],
        ['Party Type:', partyDetails.type || 'Unknown'],
        ['Party:', partyDetails.name || partyDetails.id || 'N/A'],
        ...(partyDetails.account_no ? [
            ['Account No:', partyDetails.account_no],
            ['IFSC:', partyDetails.ifsc || 'N/A']
        ] : []),
        ['Period:', `${formatDateForReport(fromDate)} to ${formatDateForReport(toDate)}`],
        [],
        ['Opening Balance:'],
        ['Debit:', openingDebit.toFixed(2)],
        ['Credit:', openingCredit.toFixed(2)],
        ['Balance:', openingBalance.toFixed(2)],
        [],
        ['Date', 'Particulars', 'Invoice No', 'Debit (₹)', 'Credit (₹)', 'Balance (₹)']
    ];

    for (const row of data) {
        rows.push([
            formatDateForDisplay(row.date),
            row.particular,
            row.invoice_no,
            row.debit !== 0 ? row.debit.toFixed(2) : '',
            row.credit !== 0 ? row.credit.toFixed(2) : '',
            row.balance.toFixed(2)
        ]);
    }

    if (data.length === 0) {
        rows.push(['No transactions found for the selected period.']);
    }

    if (data.length > 0) {
        rows.push([]);
        rows.push(['', '', '', '', 'Closing Balance:', data[data.length - 1].balance.toFixed(2)]);
    }

    rows.push([]);
    rows.push([`Generated on: ${new Date().toLocaleString()}`]);

    const csvContent = rows.map(row => row.map(cell => {
        if (cell === null || cell === undefined) return '';
        const stringCell = String(cell);
        if (stringCell.includes(',') || stringCell.includes('"') || stringCell.includes('\n')) {
            return `"${stringCell.replace(/"/g, '""')}"`;
        }
        return stringCell;
    }).join(',')).join('\n');

    res.send(csvContent);
}






router.post("/capital/create", auth, validateBranch, async (req, res) => {
    try {
        const username = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;

        const {
            name,
            remark,
            opening_balance = {}
        } = req.body || {};


        const capital_id = await UNIQUE_RANDOM_STRING("capitals", "capital_id", { length: ID_LENGTH });
        await pool.query(
            "INSERT INTO `capitals` (`branch_id`, `capital_id`, `create_by`, `modify_by`, `name`, `remark`) VALUES (?,?,?,?,?,?)",
            [
                branch_id,
                capital_id,
                username,     // create_by
                username,     // modify_by
                name,
                remark
            ]
        );


        const amount = opening_balance?.amount;
        const transaction_date = opening_balance?.date;
        const transaction_type = opening_balance?.type;

        try {
            await SET_OPENING_BALANCE({
                req,
                type: transaction_type == "credit" ? "1" : "0",
                party_type: "capital",
                party_id: capital_id,
                amount,
                remark: "",
                transaction_date
            });
        } catch (err) {
            return res.status(400).json({ success: false, message: err.message || "Opening balance not set" });
        }

        const { balance } = await GET_BALANCE({ party_type: "capital", party_id: capital_id, branch_id });
        const data = capitalRowToItem({ capital_id, name, remark, branch_id }, balance);

        return res.status(200).json({
            success: true,
            message: 'Capital created successfully',
            data
        });

    } catch (error) {
        console.error("Create capital fatal error:", error);
        return res.status(500).json({ success: false, message: "Failed to create capital", error: error.message });
    }
});

router.put("/capital/edit", auth, validateBranch, async (req, res) => {
    try {
        const username = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;

        const {
            capital_id,
            name,
            remark,
            opening_balance = {}
        } = req.body || {};

        if (!capital_id || String(capital_id).trim() === "") {
            return res.status(400).json({ success: false, message: "capital_id is required" });
        }

        const [capitalRows] = await pool.query(
            "SELECT id, branch_id, capital_id, create_by, modify_by, name, remark, create_date, modify_date FROM `capitals` WHERE `branch_id` = ? AND `capital_id` = ? LIMIT 1",
            [branch_id, capital_id]
        );

        if (!capitalRows || capitalRows.length === 0) {
            return res.status(404).json({ success: false, message: "Capital not found for this branch" });
        }

        await pool.query(
            "UPDATE `capitals` SET `modify_by` = ?, `name` = ?, `remark` = ? WHERE `branch_id` = ? AND `capital_id` = ?",
            [username, name, remark, branch_id, capital_id]
        );

        const amount = opening_balance?.amount;
        const transaction_date = opening_balance?.date;
        const transaction_type = opening_balance?.type;

        if (opening_balance && (amount != null || transaction_date != null || transaction_type != null)) {
            const [txRows] = await pool.query(
                "SELECT `transaction_id`, `transaction_date`, `amount` FROM `transactions` WHERE `branch_id` = ? AND `party1_type` = ? AND `party1_id` = ? AND `transaction_type` = ? ORDER BY `id` DESC LIMIT 1",
                [branch_id, "capital", capital_id, "opening balance"]
            );

            if (txRows && txRows.length > 0) {
                const existing = txRows[0];
                const existingAmount = Number(existing.amount) || 0;
                const derivedType = existingAmount >= 0 ? "0" : "1"; // positive=debit, negative=credit
                try {
                    await EDIT_OPENING_BALANCE({
                        req,
                        transaction_id: existing.transaction_id,
                        type: transaction_type === "credit" ? "1" : transaction_type === "debit" ? "0" : derivedType,
                        party_type: "capital",
                        party_id: capital_id,
                        amount: amount != null ? Number(amount) : Math.abs(existingAmount),
                        remark: remark ?? "",
                        transaction_date: transaction_date ?? existing.transaction_date
                    });
                } catch (err) {
                    return res.status(400).json({ success: false, message: err.message || "Failed to update opening balance" });
                }
            }
        }

        const { balance } = await GET_BALANCE({ party_type: "capital", party_id: capital_id, branch_id });
        const [updated] = await pool.query(
            "SELECT id, branch_id, capital_id, create_by, modify_by, name, remark, create_date, modify_date FROM `capitals` WHERE `branch_id` = ? AND `capital_id` = ? LIMIT 1",
            [branch_id, capital_id]
        );
        const data = capitalRowToItem(updated[0], balance);

        return res.status(200).json({
            success: true,
            message: "Capital updated successfully",
            data
        });
    } catch (error) {
        console.error("Edit capital fatal error:", error);
        return res.status(500).json({ success: false, message: "Failed to update capital", error: error.message });
    }
});

router.get('/capital/list', auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { page_no = 1, limit: limitParam = 10, search = "" } = req.query || {};
        const pageNum = Math.max(1, Number(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limitParam) || 10));
        const offset = (pageNum - 1) * limitNum;
        const searchTerm = String(search || "").trim();
        const search_sql = `%${searchTerm}%`;

        const countQuery = `
            SELECT COUNT(*) AS total FROM capitals
            WHERE branch_id = ? AND (capital_id LIKE ? OR name LIKE ? OR remark LIKE ?)
        `;
        const [[{ total: totalRows }]] = await pool.query(countQuery, [
            branch_id, search_sql, search_sql, search_sql
        ]);
        const total = Number(totalRows) || 0;

        const [rows] = await pool.query(
            "SELECT id, branch_id, capital_id, create_by, modify_by, name, remark, create_date, modify_date FROM capitals WHERE branch_id = ? AND (capital_id LIKE ? OR name LIKE ? OR remark LIKE ?) ORDER BY capital_id LIMIT ? OFFSET ?",
            [branch_id, search_sql, search_sql, search_sql, limitNum, offset]
        );

        const capital_list = [];
        for (let i = 0; i < rows.length; i++) {
            const element = rows[i];
            const { balance } = await GET_BALANCE({ party_type: "capital", party_id: element.capital_id, branch_id });
            capital_list.push(capitalRowToItem(element, balance));
        }

        const count = capital_list.length;
        const is_last_page = offset + count >= total;

        return res.status(200).json({
            success: true,
            data: capital_list,
            meta: {
                page_no: pageNum,
                limit: limitNum,
                total,
                count,
                is_last_page
            }
        });


    } catch (error) {
        console.error('Error fetching bank list:', error);
        return res.status(500).json({ success: false, message: "Failed to fetch bank list", error: error.message });
    }
});

router.get("/capital/details", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { capital_id } = req.query || {};

        if (!capital_id || String(capital_id).trim() === "") {
            return res.status(400).json({ success: false, message: "capital_id is required" });
        }

        const [rows] = await pool.query(
            "SELECT id, branch_id, capital_id, create_by, modify_by, name, remark, create_date, modify_date FROM capitals WHERE branch_id = ? AND capital_id = ? LIMIT 1",
            [branch_id, String(capital_id).trim()]
        );

        if (!rows || rows.length === 0) {
            return res.status(404).json({ success: false, message: "Capital not found for this branch" });
        }

        const element = rows[0];
        const { balance } = await GET_BALANCE({ party_type: "capital", party_id: element.capital_id, branch_id });
        const data = capitalRowToItem(element, balance);

        return res.status(200).json({
            success: true,
            data
        });
    } catch (error) {
        console.error("Bank details error:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch bank details", error: error.message });
    }
});


router.post("/payment/discount", auth, validateBranch, async (req, res) => {
    try {
        const username = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;
        const { party_id, party_type, amount, remark, transaction_date } = req.body || {};

        if (!party_id || String(party_id).trim() === "") {
            return res.status(400).json({ success: false, message: "party_id is required" });
        }

        if (!party_type || String(party_type).trim() === "") {
            return res.status(400).json({ success: false, message: "party_type is required" });
        }

        if (!amount || Number(amount) <= 0) {
            return res.status(400).json({ success: false, message: "amount is required" });
        }

        if (!transaction_date || String(transaction_date).trim() === "") {
            return res.status(400).json({ success: false, message: "transaction_date is required" });
        }

        const amountNum = Number(amount);
        const absAmount = Math.abs(amountNum);
        const txnDate = String(transaction_date).trim();
        const discountDate = txnDate.length >= 10 ? txnDate.slice(0, 10) : txnDate;
        const partyTypeVal = String(party_type).trim();
        const partyIdVal = String(party_id).trim();
        const remarkVal = remark != null ? String(remark).trim() : null;

        // Store discount as a negative grand_total so ledger balance decreases.
        const grandTotal = -absAmount;

        let invoice_no = "";

        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            const transaction_id = await UNIQUE_RANDOM_STRING("transactions", "transaction_id", { length: ID_LENGTH, conn: connection });
            const invoice_id = await UNIQUE_RANDOM_STRING("invoice", "invoice_id", { length: ID_LENGTH, conn: connection });
            const discount_id = await UNIQUE_RANDOM_STRING("discount_entries", "discount_id", { length: ID_LENGTH, conn: connection });

            const [invoicePrefixRows] = await connection.query(
                "SELECT * FROM `invoice_prefix` WHERE `branch_id` = ? AND `type` = ? AND `is_deleted` = ? AND `issue_date` <= ? AND `expire_date` >= ?",
                [branch_id, "discount", "0", TODAY_DATE(), TODAY_DATE()]
            );

            if (!invoicePrefixRows || invoicePrefixRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ success: false, message: "Invoice prefix not set for discount." });
            }

            const invoiceData = invoicePrefixRows[0];
            const invoicePrimaryId = invoiceData?.id;
            const serial = Number(invoiceData?.current || 0) + 1;
            invoice_no = `${invoiceData?.prefix}${serial}`;

            // Invoice: discount invoice with negative grand_total.
            await connection.query(
                `INSERT INTO invoice (
                    invoice_id, branch_id, invoice_no, create_by, modify_by, type, transaction_id,
                    subtotal, discount_type, discount_perc_rate, discount_value,
                    tax_rate, tax_value, additional_charge, total, round_off, grand_total
                 )
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    invoice_id,
                    branch_id,
                    invoice_no,
                    username,
                    username,
                    "discount",
                    transaction_id,
                    absAmount,
                    "not applicable",
                    0,
                    0,
                    0,
                    0,
                    0,
                    grandTotal,
                    0,
                    grandTotal
                ]
            );

            // Transactions: put party into party1_type/party1_id. party2 is empty.
            await connection.query(
                `INSERT INTO transactions (
                    branch_id, transaction_id, create_by, modify_by, transaction_date,
                    amount, transaction_type, invoice_id, invoice_no,
                    party1_type, party1_id, party2_type, party2_id, remark
                 )
                 VALUES (?, ?, ?, ?, ?, ?, 'discount', ?, ?, ?, ?, ?, ?, ?)`,
                [
                    branch_id,
                    transaction_id,
                    username,
                    username,
                    txnDate,
                    grandTotal,
                    invoice_id,
                    invoice_no,
                    partyTypeVal,
                    partyIdVal,
                    null,
                    null,
                    remarkVal
                ]
            );

            await connection.query(
                `INSERT INTO discount_entries (
                    branch_id, discount_id, create_by, modify_by, discount_date,
                    party_type, party_id, amount,
                    invoice_id, invoice_no, transaction_id
                 )
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    branch_id,
                    discount_id,
                    username,
                    username,
                    discountDate,
                    partyTypeVal,
                    partyIdVal,
                    absAmount,
                    invoice_id,
                    invoice_no,
                    transaction_id
                ]
            );

            await connection.query(
                "UPDATE `invoice_prefix` SET `current` = ? WHERE `id` = ?",
                [serial, invoicePrimaryId]
            );

            await connection.commit();
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }

        return res.status(200).json({
            success: true,
            message: "Discount entry created successfully",
            data: {
                discount_id,
                transaction_id,
                invoice_id,
                invoice_no,
                party_type: partyTypeVal,
                party_id: partyIdVal,
                amount: absAmount,
                transaction_date: discountDate,
                remark: remarkVal
            }
        });
    } catch (error) {
        console.error("Discount entry creation error:", error);
        return res.status(500).json({ success: false, message: "Failed to create discount entry", error: error.message });
    }
});

export default router;