import express from "express";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { RANDOM_STRING, TODAY_DATE, USER_SNIPPED_DATA, BANK_SNIPPED_DATA, CAPITAL_SNIPPED_DATA, USER_DATA } from "../helpers/function.js";

const router = express.Router();

const EXPENSE_ITEM_TYPES_ALLOWED = ["direct", "indirect", "reimbursement"];

const mapExpenseItemRow = async (element, expenseEntryCount = null) => {
    const create_by_user = await USER_DATA(element?.create_by);
    const modify_by_user = await USER_DATA(element?.modify_by);
    const entryCount =
        expenseEntryCount != null
            ? Number(expenseEntryCount) || 0
            : Number(element?.expense_entry_count) || 0;

    return {
        item_id: element.item_id,
        create_by: {
            username: create_by_user?.username,
            name: create_by_user?.name,
            mobile: create_by_user?.mobile,
            email: create_by_user?.email,
        },
        modify_by: {
            username: modify_by_user?.username,
            name: modify_by_user?.name,
            mobile: modify_by_user?.mobile,
            email: modify_by_user?.email,
        },
        name: element.name,
        type: element.type,
        remark: element.remark,
        create_date: element.create_date,
        modify_date: element.modify_date,
        expense_entry_count: entryCount,
        can_delete: entryCount === 0,
    };
};

const getExpenseItemListFilters = (req) => {
    const search = req.query?.search || "";
    const searchSql = `%${String(search).trim()}%`;
    const typeVal =
        req.query?.type && String(req.query.type).trim() !== ""
            ? String(req.query.type).trim().toLowerCase()
            : null;
    const hasType = typeVal != null;

    if (hasType && !EXPENSE_ITEM_TYPES_ALLOWED.includes(typeVal)) {
        const err = new Error(`type must be one of: ${EXPENSE_ITEM_TYPES_ALLOWED.join(", ")}`);
        err.statusCode = 400;
        throw err;
    }

    const whereClause = `ei.branch_id = ? AND ei.is_deleted = '0'
        AND (ei.name LIKE ? OR ei.type LIKE ? OR ei.remark LIKE ?)
        ${hasType ? "AND ei.type = ?" : ""}`;

    const params = [req.branch_id, searchSql, searchSql, searchSql];
    if (hasType) params.push(typeVal);

    return { whereClause, params };
};

router.post("/item/create", auth, validateBranch, async (req, res) => {
    try {
        const {
            name,
            remark,
            type
        } = req.body || {};

        const username = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;

        if (!name || String(name).trim() === "") {
            return res.status(400).json({ success: false, message: "name is required" });
        }

        const itemName = String(name).trim();
        const itemRemark = remark != null ? String(remark).trim() : null;
        const itemType = type != null && String(type).trim() !== "" ? String(type).trim().toLowerCase() : "direct";
        const allowedTypes = ["direct", "indirect", "reimbursement"];
        if (!allowedTypes.includes(itemType)) {
            return res.status(400).json({
                success: false,
                message: `type must be one of: ${allowedTypes.join(", ")}`
            });
        }

        const item_id = RANDOM_STRING(30);
        await pool.query(
            `INSERT INTO expense_items (branch_id, item_id, create_by, modify_by, name, type, remark, is_deleted)
             VALUES (?, ?, ?, ?, ?, ?, ?, '0')`,
            [branch_id, item_id, username, username, itemName, itemType, itemRemark]
        );

        return res.status(200).json({
            success: true,
            message: "Expense item created successfully",
            data: {
                item_id,
                name: itemName,
                type: itemType,
                remark: itemRemark
            }
        });
    } catch (error) {
        console.error("Create expense item error:", error);
        return res.status(500).json({ success: false, message: "Failed to create expense item", error: error.message });
    }
});

router.put("/item/edit", auth, validateBranch, async (req, res) => {
    try {
        const {
            item_id,
            name,
            remark,
            type
        } = req.body || {};

        const username = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;

        if (!item_id || String(item_id).trim() === "") {
            return res.status(400).json({ success: false, message: "item_id is required" });
        }

        const [rows] = await pool.query(
            "SELECT id, branch_id, item_id, create_by, modify_by, name, type, remark, create_date, modify_date FROM expense_items WHERE branch_id = ? AND item_id = ? AND is_deleted = '0' LIMIT 1",
            [branch_id, String(item_id).trim()]
        );

        if (!rows || rows.length === 0) {
            return res.status(404).json({ success: false, message: "Expense item not found for this branch" });
        }

        const existing = rows[0];
        const nextName = name != null ? String(name).trim() : existing.name;
        const nextRemark = remark != null ? String(remark).trim() : existing.remark;
        const nextType = type != null && String(type).trim() !== "" ? String(type).trim().toLowerCase() : existing.type;
        const allowedTypes = ["direct", "indirect", "reimbursement"];

        if (!nextName || nextName === "") {
            return res.status(400).json({ success: false, message: "name cannot be empty" });
        }
        if (!allowedTypes.includes(nextType)) {
            return res.status(400).json({
                success: false,
                message: `type must be one of: ${allowedTypes.join(", ")}`
            });
        }

        await pool.query(
            "UPDATE expense_items SET modify_by = ?, name = ?, type = ?, remark = ? WHERE branch_id = ? AND item_id = ?",
            [username, nextName, nextType, nextRemark, branch_id, String(item_id).trim()]
        );

        return res.status(200).json({
            success: true,
            message: "Expense item updated successfully",
            data: {
                item_id: String(item_id).trim(),
                name: nextName,
                type: nextType,
                remark: nextRemark
            }
        });
    } catch (error) {
        console.error("Edit expense item error:", error);
        return res.status(500).json({ success: false, message: "Failed to edit expense item", error: error.message });
    }
});

router.get("/item/list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const page_no = Math.max(1, Number(req.query?.page_no) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 10));
        const offset = (page_no - 1) * limit;

        let filters;
        try {
            filters = getExpenseItemListFilters(req);
        } catch (filterErr) {
            if (filterErr.statusCode === 400) {
                return res.status(400).json({ success: false, message: filterErr.message });
            }
            throw filterErr;
        }

        const { whereClause, params } = filters;

        const countWhere = whereClause;
        const [[{ total: totalRows }]] = await pool.query(
            `SELECT COUNT(*) AS total FROM expense_items ei WHERE ${countWhere}`,
            params
        );
        const total = Number(totalRows) || 0;

        const [rows] = await pool.query(
            `SELECT
                ei.id, ei.branch_id, ei.item_id, ei.create_by, ei.modify_by,
                ei.name, ei.type, ei.remark, ei.create_date, ei.modify_date,
                (
                    SELECT COUNT(*)
                    FROM expense_entries ee
                    WHERE ee.branch_id = ei.branch_id AND ee.item_id = ei.item_id
                ) AS expense_entry_count
             FROM expense_items ei
             WHERE ${whereClause}
             ORDER BY ei.id DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        const data = [];
        for (let index = 0; index < rows.length; index++) {
            data.push(await mapExpenseItemRow(rows[index]));
        }

        return res.status(200).json({
            success: true,
            data: data,
            meta: {
                page_no,
                limit,
                total,
                count: data.length,
                is_last_page: offset + rows.length >= total
            }
        });
    } catch (error) {
        console.error("Expense item list error:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch expense item list", error: error.message });
    }
});

router.get("/item/details", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const item_id = req.query?.item_id;

        if (!item_id || String(item_id).trim() === "") {
            return res.status(400).json({ success: false, message: "item_id is required" });
        }

        const itemIdVal = String(item_id).trim();

        const [rows] = await pool.query(
            `SELECT
                ei.id, ei.branch_id, ei.item_id, ei.create_by, ei.modify_by,
                ei.name, ei.type, ei.remark, ei.create_date, ei.modify_date,
                (
                    SELECT COUNT(*)
                    FROM expense_entries ee
                    WHERE ee.branch_id = ei.branch_id AND ee.item_id = ei.item_id
                ) AS expense_entry_count
             FROM expense_items ei
             WHERE ei.branch_id = ? AND ei.item_id = ? AND ei.is_deleted = '0'
             LIMIT 1`,
            [branch_id, itemIdVal]
        );

        if (!rows || rows.length === 0) {
            return res.status(404).json({ success: false, message: "Expense item not found for this branch" });
        }

        const data = await mapExpenseItemRow(rows[0]);

        return res.status(200).json({
            success: true,
            data,
        });
    } catch (error) {
        console.error("Expense item details error:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch expense item details", error: error.message });
    }
});

router.delete("/item/delete", auth, validateBranch, async (req, res) => {
    try {
        const username = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;
        const item_id = req.body?.item_id || req.query?.item_id;

        if (!item_id || String(item_id).trim() === "") {
            return res.status(400).json({ success: false, message: "item_id is required" });
        }

        const itemIdVal = String(item_id).trim();

        const [rows] = await pool.query(
            "SELECT item_id FROM expense_items WHERE branch_id = ? AND item_id = ? AND is_deleted = '0' LIMIT 1",
            [branch_id, itemIdVal]
        );

        if (!rows || rows.length === 0) {
            return res.status(404).json({ success: false, message: "Expense item not found for this branch" });
        }

        const [[{ usage_count: usageCount }]] = await pool.query(
            `SELECT COUNT(*) AS usage_count
             FROM expense_entries
             WHERE branch_id = ? AND item_id = ?`,
            [branch_id, itemIdVal]
        );

        if (Number(usageCount) > 0) {
            return res.status(400).json({
                success: false,
                message: "Cannot delete this item because expense entries already exist for it",
                data: { expense_entry_count: Number(usageCount) || 0 },
            });
        }

        await pool.query(
            "UPDATE expense_items SET is_deleted = '1', modify_by = ? WHERE branch_id = ? AND item_id = ?",
            [username, branch_id, itemIdVal]
        );

        return res.status(200).json({
            success: true,
            message: "Expense item deleted successfully",
            data: { item_id: itemIdVal },
        });
    } catch (error) {
        console.error("Delete expense item error:", error);
        return res.status(500).json({ success: false, message: "Failed to delete expense item", error: error.message });
    }
});

router.post("/entry/create", auth, validateBranch, async (req, res) => {
    try {
        const {
            item_id,
            remark,
            amount,
            transaction_date,
            party_id,
            party_type
        } = req.body || {};

        const username = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;

        if (!item_id || String(item_id).trim() === "") {
            return res.status(400).json({ success: false, message: "item_id is required" });
        }

        if (!party_id || String(party_id).trim() === "") {
            return res.status(400).json({ success: false, message: "party_id is required" });
        }

        if (!party_type || String(party_type).trim() === "") {
            return res.status(400).json({ success: false, message: "party_type is required" });
        }

        if (!transaction_date || String(transaction_date).trim() === "") {
            return res.status(400).json({ success: false, message: "transaction_date is required" });
        }

        if (!amount || Number(amount) <= 0) {
            return res.status(400).json({ success: false, message: "Valid amount is required" });
        }

        const partyTypeVal = String(party_type).trim().toLowerCase();
        const allowedPartyTypes = ["bank", "capital"];
        if (!allowedPartyTypes.includes(partyTypeVal)) {
            return res.status(400).json({
                success: false,
                message: `party_type must be one of: ${allowedPartyTypes.join(", ")}`
            });
        }

        const itemIdVal = String(item_id).trim();
        const partyIdVal = String(party_id).trim();
        const txnDate = String(transaction_date).trim();
        const expenseDate = txnDate.length >= 10 ? txnDate.slice(0, 10) : txnDate;
        const amountNum = Math.abs(Number(amount));
        const remarkVal = remark != null ? String(remark).trim() : null;

        const [itemRows] = await pool.query(
            "SELECT item_id FROM expense_items WHERE branch_id = ? AND item_id = ? AND is_deleted = '0' LIMIT 1",
            [branch_id, itemIdVal]
        );
        if (!itemRows || itemRows.length === 0) {
            return res.status(404).json({ success: false, message: "Expense item not found for this branch" });
        }

        const transaction_id = RANDOM_STRING(30);
        const invoice_id = RANDOM_STRING(30);
        const expense_id = RANDOM_STRING(30);
        let invoice_no = "";

        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            const [invoicePrefixRows] = await connection.query(
                "SELECT * FROM `invoice_prefix` WHERE `branch_id` = ? AND `type` = ? AND `is_deleted` = ? AND `issue_date` <= ? AND `expire_date` >= ?",
                [branch_id, "expense", "0", TODAY_DATE(), TODAY_DATE()]
            );

            if (!invoicePrefixRows || invoicePrefixRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ success: false, message: "Invoice prefix not set for expense." });
            }

            const invoiceData = invoicePrefixRows[0];
            const invoicePrimaryId = invoiceData?.id;
            const serial = Number(invoiceData?.current || 0) + 1;
            invoice_no = `${invoiceData?.prefix}${serial}`;

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
                    "expense",
                    transaction_id,
                    amountNum,
                    "not applicable",
                    0,
                    0,
                    0,
                    0,
                    0,
                    amountNum,
                    0,
                    amountNum
                ]
            );

            // Party goes on party1 columns in transactions.
            await connection.query(
                `INSERT INTO transactions (
                    branch_id, transaction_id, create_by, modify_by, transaction_date,
                    amount, transaction_type, invoice_id, invoice_no,
                    party1_type, party1_id, remark
                 )
                 VALUES (?, ?, ?, ?, ?, ?, 'expense', ?, ?, ?, ?, ?)`,
                [
                    branch_id,
                    transaction_id,
                    username,
                    username,
                    txnDate,
                    amountNum,
                    invoice_id,
                    invoice_no,
                    partyTypeVal,
                    partyIdVal,
                    remarkVal
                ]
            );

            await connection.query(
                `INSERT INTO expense_entries (
                    branch_id, expense_id, item_id, create_by, modify_by, expense_date,
                    party_type, party_id, amount, invoice_id, invoice_no, transaction_id
                 )
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    branch_id,
                    expense_id,
                    itemIdVal,
                    username,
                    username,
                    expenseDate,
                    partyTypeVal,
                    partyIdVal,
                    amountNum,
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
            message: "Expense entry created successfully",
            data: {
                expense_id,
                transaction_id,
                invoice_id,
                invoice_no,
                item_id: itemIdVal,
                party_type: partyTypeVal,
                party_id: partyIdVal,
                amount: amountNum,
                transaction_date: expenseDate,
                remark: remarkVal
            }
        });
    } catch (error) {
        console.error("Create expense entry error:", error);
        return res.status(500).json({ success: false, message: "Failed to create expense entry", error: error.message });
    }
});

router.put("/entry/edit", auth, validateBranch, async (req, res) => {
    try {
        const username = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;
        const {
            expense_id,
            item_id,
            remark,
            amount,
            transaction_date,
            party_id,
            party_type,
        } = req.body || {};

        if (!expense_id || String(expense_id).trim() === "") {
            return res.status(400).json({ success: false, message: "expense_id is required" });
        }
        if (!item_id || String(item_id).trim() === "") {
            return res.status(400).json({ success: false, message: "item_id is required" });
        }
        if (!party_id || String(party_id).trim() === "") {
            return res.status(400).json({ success: false, message: "party_id is required" });
        }
        if (!party_type || String(party_type).trim() === "") {
            return res.status(400).json({ success: false, message: "party_type is required" });
        }
        if (!transaction_date || String(transaction_date).trim() === "") {
            return res.status(400).json({ success: false, message: "transaction_date is required" });
        }
        if (!amount || Number(amount) <= 0) {
            return res.status(400).json({ success: false, message: "Valid amount is required" });
        }

        const partyTypeVal = String(party_type).trim().toLowerCase();
        const allowedPartyTypes = ["bank", "capital"];
        if (!allowedPartyTypes.includes(partyTypeVal)) {
            return res.status(400).json({
                success: false,
                message: `party_type must be one of: ${allowedPartyTypes.join(", ")}`,
            });
        }

        const expenseIdVal = String(expense_id).trim();
        const itemIdVal = String(item_id).trim();
        const partyIdVal = String(party_id).trim();
        const txnDate = String(transaction_date).trim().slice(0, 10);
        const expenseDate = txnDate;
        const amountNum = Math.abs(Number(amount));
        const remarkVal = remark != null ? String(remark).trim() : null;

        const [itemRows] = await pool.query(
            "SELECT item_id FROM expense_items WHERE branch_id = ? AND item_id = ? AND is_deleted = '0' LIMIT 1",
            [branch_id, itemIdVal]
        );
        if (!itemRows?.length) {
            return res.status(404).json({ success: false, message: "Expense item not found for this branch" });
        }

        const [expenseRows] = await pool.query(
            `SELECT expense_id, transaction_id, invoice_id FROM expense_entries
             WHERE branch_id = ? AND expense_id = ? LIMIT 1`,
            [branch_id, expenseIdVal]
        );
        if (!expenseRows?.length) {
            return res.status(404).json({ success: false, message: "Expense entry not found" });
        }
        const expenseRow = expenseRows[0];
        const transaction_id = expenseRow.transaction_id;
        const invoice_id = expenseRow.invoice_id;

        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            await connection.query(
                `UPDATE expense_entries
                 SET modify_by = ?, item_id = ?, expense_date = ?, party_type = ?, party_id = ?, amount = ?
                 WHERE branch_id = ? AND expense_id = ?`,
                [username, itemIdVal, expenseDate, partyTypeVal, partyIdVal, amountNum, branch_id, expenseIdVal]
            );

            await connection.query(
                `UPDATE transactions
                 SET modify_by = ?, transaction_date = ?, amount = ?, remark = ?, party1_type = ?, party1_id = ?
                 WHERE branch_id = ? AND transaction_id = ?`,
                [username, txnDate, amountNum, remarkVal, partyTypeVal, partyIdVal, branch_id, transaction_id]
            );

            await connection.query(
                `UPDATE invoice
                 SET modify_by = ?, subtotal = ?, total = ?, grand_total = ?
                 WHERE branch_id = ? AND invoice_id = ?`,
                [username, amountNum, amountNum, amountNum, branch_id, invoice_id]
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
            message: "Expense entry updated successfully",
            data: {
                expense_id: expenseIdVal,
                transaction_id,
                invoice_id,
                item_id: itemIdVal,
                party_type: partyTypeVal,
                party_id: partyIdVal,
                amount: amountNum,
                transaction_date: expenseDate,
                remark: remarkVal,
            },
        });
    } catch (error) {
        console.error("Edit expense entry error:", error);
        return res.status(500).json({ success: false, message: "Failed to update expense entry", error: error.message });
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
        const item_id = req.query?.item_id || null;
        const type = req.query?.type || null;

        const searchRaw = search && String(search).trim() !== "" ? String(search).trim() : null;
        const searchPattern = searchRaw != null ? `%${searchRaw}%` : null;
        const itemIdVal = item_id && String(item_id).trim() !== "" ? String(item_id).trim() : null;
        const typeVal = type && String(type).trim() !== "" ? String(type).trim().toLowerCase() : null;
        const hasSearch = searchPattern != null;
        const hasItemId = itemIdVal != null;
        const hasType = typeVal != null;

        if (hasType) {
            const allowedTypes = ["direct", "indirect", "reimbursement"];
            if (!allowedTypes.includes(typeVal)) {
                return res.status(400).json({
                    success: false,
                    message: `type must be one of: ${allowedTypes.join(", ")}`
                });
            }
        }

        const searchClause = hasSearch
            ? `AND (
                ei.name LIKE ?
                OR IFNULL(ei.remark, '') LIKE ?
                OR IFNULL(t.remark, '') LIKE ?
                OR ei.type LIKE ?
                OR CONCAT(ei.type, ' expense') LIKE ?
                OR ee.invoice_no LIKE ?
                OR CAST(ee.amount AS CHAR) LIKE ?
            )`
            : "";

        const whereClause = `ee.branch_id = ?
            AND (ee.expense_date >= ? AND ee.expense_date <= ?)
            ${hasItemId ? "AND ee.item_id = ?" : ""}
            ${hasType ? "AND ei.type = ?" : ""}
            ${searchClause}`;

        const params = [branch_id, from_date || "1970-01-01", to_date || "2099-12-31"];
        if (hasItemId) params.push(itemIdVal);
        if (hasType) params.push(typeVal);
        if (hasSearch) {
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

        const [rows] = await pool.query(
            `SELECT
                ee.expense_id, ee.expense_date, ee.party_type, ee.party_id, ee.amount, ee.item_id, ee.invoice_id, ee.invoice_no, ee.transaction_id,
                ee.create_by, ee.modify_by, ee.create_date, ee.modify_date,
                ei.name AS item_name, ei.type AS item_type,
                t.remark, t.transaction_date
             FROM expense_entries ee
             LEFT JOIN expense_items ei ON ee.item_id = ei.item_id AND ee.branch_id = ei.branch_id
             LEFT JOIN transactions t ON ee.transaction_id = t.transaction_id AND ee.branch_id = t.branch_id
             WHERE ${whereClause}
             ORDER BY ee.expense_date DESC, ee.id DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        const [[{ total: totalRows }]] = await pool.query(
            `SELECT COUNT(*) AS total
             FROM expense_entries ee
             LEFT JOIN expense_items ei ON ee.item_id = ei.item_id AND ee.branch_id = ei.branch_id
             LEFT JOIN transactions t ON ee.transaction_id = t.transaction_id AND ee.branch_id = t.branch_id
             WHERE ${whereClause}`,
            params
        );
        const total = Number(totalRows) || 0;

        const [[{ total_amount: totalAmountRows }]] = await pool.query(
            `SELECT COALESCE(SUM(ee.amount), 0) AS total_amount
             FROM expense_entries ee
             LEFT JOIN expense_items ei ON ee.item_id = ei.item_id AND ee.branch_id = ei.branch_id
             LEFT JOIN transactions t ON ee.transaction_id = t.transaction_id AND ee.branch_id = t.branch_id
             WHERE ${whereClause}`,
            params
        );
        const total_amount = Number(totalAmountRows) || 0;

        const data = [];
        for (let index = 0; index < rows.length; index++) {
            const row = rows[index];
            let party = {};
            if (row.party_type === "bank") {
                party = await BANK_SNIPPED_DATA(row.party_id);
            } else if (row.party_type === "capital") {
                party = await CAPITAL_SNIPPED_DATA(row.party_id);
            }

            const create_by = await USER_SNIPPED_DATA(row.create_by);
            const modify_by = await USER_SNIPPED_DATA(row.modify_by);

            data.push({
                expense_id: row.expense_id,
                transaction_id: row.transaction_id,
                transaction_date: row.transaction_date || row.expense_date,
                expense_date: row.expense_date,
                amount: Number(row.amount) || 0,
                remark: row.remark ?? null,
                invoice_id: row.invoice_id,
                invoice_no: row.invoice_no,
                item: {
                    item_id: row.item_id,
                    name: row.item_name,
                    type: row.item_type
                },
                expense_party: {
                    type: row.party_type,
                    details: party
                },
                create_by,
                modify_by,
                create_date: row.create_date,
                modify_date: row.modify_date
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
        console.error("Expense list error:", error);
        return res.status(500).json({ success: false, message: "Failed to get expense list", error: error.message });
    }
});

export default router;
