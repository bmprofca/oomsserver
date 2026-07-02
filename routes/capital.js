import express from "express";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import {
    GET_BALANCE,
    RANDOM_STRING,
    SET_OPENING_BALANCE,
    EDIT_OPENING_BALANCE,
    USER_SNIPPED_DATA,
} from "../helpers/function.js";

const router = express.Router();

const capitalRowToItem = (element, balance) => ({
    capital_id: element?.capital_id,
    name: element?.name,
    remark: element?.remark ?? null,
    status: String(element?.is_deleted ?? "0") !== "1",
    balance: balance ?? 0,
});

const mapCapitalRow = async (element, balance) => {
    const create_by = await USER_SNIPPED_DATA(element?.create_by);
    const modify_by = await USER_SNIPPED_DATA(element?.modify_by);

    return {
        ...capitalRowToItem(element, balance),
        create_by,
        modify_by,
        create_date: element?.create_date ?? null,
        modify_date: element?.modify_date ?? null,
    };
};

const fetchCapitalById = async (branch_id, capitalIdVal, includeDeleted = false) => {
    const deletedClause = includeDeleted ? "" : " AND IFNULL(is_deleted, '0') = '0'";
    const [rows] = await pool.query(
        `SELECT id, branch_id, capital_id, create_by, modify_by, name, remark,
                create_date, modify_date, is_deleted, deleted_by
         FROM capitals
         WHERE branch_id = ? AND capital_id = ?${deletedClause}
         LIMIT 1`,
        [branch_id, capitalIdVal]
    );
    return rows?.[0] || null;
};

const buildCapitalSearchWhere = (alias = "") => {
    const col = (name) => (alias ? `${alias}.${name}` : name);
    return `${col("branch_id")} = ?
        AND IFNULL(${col("is_deleted")}, '0') = '0'
        AND (${col("capital_id")} LIKE ? OR ${col("name")} LIKE ? OR IFNULL(${col("remark")}, '') LIKE ?)`;
};

const fetchCapitalListStats = async (branch_id, searchPattern) => {
    const whereClause = buildCapitalSearchWhere("cap");
    const params = [branch_id, branch_id, branch_id, searchPattern, searchPattern, searchPattern];

    const [[statsRow]] = await pool.query(
        `SELECT
            COUNT(DISTINCT cap.capital_id) AS total_accounts,
            COALESCE(SUM(bt.balance), 0) AS total_balance,
            COALESCE(SUM(bt.debit), 0) AS total_debit,
            COALESCE(SUM(bt.credit), 0) AS total_credit
         FROM capitals cap
         LEFT JOIN (
            SELECT
                capital_id,
                SUM(effect) AS balance,
                SUM(GREATEST(effect, 0)) AS debit,
                SUM(GREATEST(-effect, 0)) AS credit
            FROM (
                SELECT
                    party1_id AS capital_id,
                    CASE WHEN party2_id IS NULL THEN amount ELSE -amount END AS effect
                FROM transactions
                WHERE branch_id = ? AND party1_type = 'capital'
                UNION ALL
                SELECT
                    party2_id AS capital_id,
                    amount AS effect
                FROM transactions
                WHERE branch_id = ? AND party2_type = 'capital' AND party2_id IS NOT NULL
            ) effects
            GROUP BY capital_id
         ) bt ON bt.capital_id = cap.capital_id
         WHERE ${whereClause}`,
        params
    );

    return {
        total_accounts: Number(statsRow?.total_accounts) || 0,
        total_balance: Number(Number(statsRow?.total_balance ?? 0).toFixed(2)),
        total_debit: Number(Number(statsRow?.total_debit ?? 0).toFixed(2)),
        total_credit: Number(Number(statsRow?.total_credit ?? 0).toFixed(2)),
    };
};

const countCapitalUsage = async (branch_id, capitalIdVal) => {
    const [[{ usage_count: usageCount }]] = await pool.query(
        `SELECT COUNT(*) AS usage_count
         FROM transactions
         WHERE branch_id = ?
           AND (
                (party1_type = 'capital' AND party1_id = ?)
                OR (party2_type = 'capital' AND party2_id = ?)
           )`,
        [branch_id, capitalIdVal, capitalIdVal]
    );
    return Number(usageCount) || 0;
};

router.post("/create", auth, validateBranch, async (req, res) => {
    try {
        const username = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;
        const { name, remark, opening_balance = {} } = req.body || {};

        if (!name || String(name).trim() === "") {
            return res.status(400).json({ success: false, message: "name is required" });
        }

        const capitalName = String(name).trim();
        const capitalRemark = remark != null ? String(remark).trim() : null;
        const capital_id = RANDOM_STRING(30);

        await pool.query(
            `INSERT INTO capitals (
                branch_id, capital_id, create_by, modify_by, name, remark, is_deleted
             ) VALUES (?, ?, ?, ?, ?, ?, '0')`,
            [branch_id, capital_id, username, username, capitalName, capitalRemark]
        );

        const amount = opening_balance?.amount;
        const transaction_date = opening_balance?.date;
        const transaction_type = opening_balance?.type;

        if (amount != null && String(amount).trim() !== "") {
            try {
                await SET_OPENING_BALANCE({
                    req,
                    type: transaction_type === "credit" ? "1" : "0",
                    party_type: "capital",
                    party_id: capital_id,
                    amount,
                    remark: "",
                    transaction_date,
                });
            } catch (err) {
                await pool.query("DELETE FROM capitals WHERE branch_id = ? AND capital_id = ?", [
                    branch_id,
                    capital_id,
                ]);
                return res.status(400).json({
                    success: false,
                    message: err.message || "Opening balance not set",
                });
            }
        }

        const row = await fetchCapitalById(branch_id, capital_id);
        const { balance } = await GET_BALANCE({ party_type: "capital", party_id: capital_id, branch_id });
        const data = await mapCapitalRow(row, balance);

        return res.status(200).json({
            success: true,
            message: "Capital account created successfully",
            data,
        });
    } catch (error) {
        console.error("Create capital error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to create capital account",
            error: error.message,
        });
    }
});

router.put("/edit", auth, validateBranch, async (req, res) => {
    try {
        const username = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;
        const { capital_id, name, remark, opening_balance = {} } = req.body || {};

        if (!capital_id || String(capital_id).trim() === "") {
            return res.status(400).json({ success: false, message: "capital_id is required" });
        }

        const capitalIdVal = String(capital_id).trim();
        const existing = await fetchCapitalById(branch_id, capitalIdVal);

        if (!existing) {
            return res.status(404).json({ success: false, message: "Capital account not found for this branch" });
        }

        const nextName =
            name != null && String(name).trim() !== "" ? String(name).trim() : existing.name;
        const nextRemark = remark != null ? String(remark).trim() : existing.remark;

        if (!nextName || nextName === "") {
            return res.status(400).json({ success: false, message: "name cannot be empty" });
        }

        await pool.query(
            `UPDATE capitals
             SET modify_by = ?, name = ?, remark = ?
             WHERE branch_id = ? AND capital_id = ? AND IFNULL(is_deleted, '0') = '0'`,
            [username, nextName, nextRemark, branch_id, capitalIdVal]
        );

        const amount = opening_balance?.amount;
        const transaction_date = opening_balance?.date;
        const transaction_type = opening_balance?.type;

        if (opening_balance && (amount != null || transaction_date != null || transaction_type != null)) {
            const [txRows] = await pool.query(
                `SELECT transaction_id, transaction_date, amount
                 FROM transactions
                 WHERE branch_id = ? AND party1_type = ? AND party1_id = ? AND transaction_type = ?
                 ORDER BY id DESC
                 LIMIT 1`,
                [branch_id, "capital", capitalIdVal, "opening balance"]
            );

            if (txRows?.length) {
                const existingTx = txRows[0];
                const existingAmount = Number(existingTx.amount) || 0;
                const derivedType = existingAmount >= 0 ? "0" : "1";

                try {
                    await EDIT_OPENING_BALANCE({
                        req,
                        transaction_id: existingTx.transaction_id,
                        type:
                            transaction_type === "credit"
                                ? "1"
                                : transaction_type === "debit"
                                  ? "0"
                                  : derivedType,
                        party_type: "capital",
                        party_id: capitalIdVal,
                        amount: amount != null ? Number(amount) : Math.abs(existingAmount),
                        remark: nextRemark ?? "",
                        transaction_date: transaction_date ?? existingTx.transaction_date,
                    });
                } catch (err) {
                    return res.status(400).json({
                        success: false,
                        message: err.message || "Failed to update opening balance",
                    });
                }
            } else if (amount != null && String(amount).trim() !== "") {
                try {
                    await SET_OPENING_BALANCE({
                        req,
                        type: transaction_type === "credit" ? "1" : "0",
                        party_type: "capital",
                        party_id: capitalIdVal,
                        amount,
                        remark: nextRemark ?? "",
                        transaction_date,
                    });
                } catch (err) {
                    return res.status(400).json({
                        success: false,
                        message: err.message || "Failed to set opening balance",
                    });
                }
            }
        }

        const row = await fetchCapitalById(branch_id, capitalIdVal);
        const { balance } = await GET_BALANCE({
            party_type: "capital",
            party_id: capitalIdVal,
            branch_id,
        });
        const data = await mapCapitalRow(row, balance);

        return res.status(200).json({
            success: true,
            message: "Capital account updated successfully",
            data,
        });
    } catch (error) {
        console.error("Edit capital error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update capital account",
            error: error.message,
        });
    }
});

router.get("/list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const page_no = Math.max(1, Number(req.query?.page_no) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 10));
        const offset = (page_no - 1) * limit;
        const searchRaw = req.query?.search != null ? String(req.query.search).trim() : "";
        const searchPattern = `%${searchRaw}%`;

        const whereClause = buildCapitalSearchWhere();
        const params = [branch_id, searchPattern, searchPattern, searchPattern];

        const [[{ total: totalRows }]] = await pool.query(
            `SELECT COUNT(*) AS total FROM capitals WHERE ${whereClause}`,
            params
        );
        const total = Number(totalRows) || 0;

        const stats = await fetchCapitalListStats(branch_id, searchPattern);

        const [rows] = await pool.query(
            `SELECT id, branch_id, capital_id, create_by, modify_by, name, remark,
                    create_date, modify_date, is_deleted
             FROM capitals
             WHERE ${whereClause}
             ORDER BY create_date DESC, id DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        const data = [];
        for (let i = 0; i < rows.length; i++) {
            const element = rows[i];
            const { balance } = await GET_BALANCE({
                party_type: "capital",
                party_id: element.capital_id,
                branch_id,
            });
            data.push(await mapCapitalRow(element, balance));
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
                is_last_page: offset + data.length >= total,
            },
        });
    } catch (error) {
        console.error("Capital list error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch capital account list",
            error: error.message,
        });
    }
});

router.get("/details", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const capital_id = req.query?.capital_id;

        if (!capital_id || String(capital_id).trim() === "") {
            return res.status(400).json({ success: false, message: "capital_id is required" });
        }

        const row = await fetchCapitalById(branch_id, String(capital_id).trim());
        if (!row) {
            return res.status(404).json({ success: false, message: "Capital account not found for this branch" });
        }

        const { balance } = await GET_BALANCE({
            party_type: "capital",
            party_id: row.capital_id,
            branch_id,
        });
        const data = await mapCapitalRow(row, balance);

        return res.status(200).json({
            success: true,
            data,
        });
    } catch (error) {
        console.error("Capital details error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch capital account details",
            error: error.message,
        });
    }
});

router.delete("/delete", auth, validateBranch, async (req, res) => {
    try {
        const username = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;
        const capital_id = req.body?.capital_id || req.query?.capital_id;

        if (!capital_id || String(capital_id).trim() === "") {
            return res.status(400).json({ success: false, message: "capital_id is required" });
        }

        const capitalIdVal = String(capital_id).trim();
        const existing = await fetchCapitalById(branch_id, capitalIdVal);

        if (!existing) {
            return res.status(404).json({ success: false, message: "Capital account not found for this branch" });
        }

        const usageCount = await countCapitalUsage(branch_id, capitalIdVal);
        if (usageCount > 0) {
            return res.status(400).json({
                success: false,
                message: "Cannot delete this capital account because transactions exist for it",
                data: { transaction_count: usageCount },
            });
        }

        await pool.query(
            `UPDATE capitals
             SET is_deleted = '1', deleted_by = ?, modify_by = ?
             WHERE branch_id = ? AND capital_id = ?`,
            [username, username, branch_id, capitalIdVal]
        );

        return res.status(200).json({
            success: true,
            message: "Capital account deleted successfully",
            data: { capital_id: capitalIdVal },
        });
    } catch (error) {
        console.error("Delete capital error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to delete capital account",
            error: error.message,
        });
    }
});

export default router;
