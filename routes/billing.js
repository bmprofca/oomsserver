import express from "express";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { GET_BALANCE, UNIQUE_RANDOM_STRING, ID_LENGTH, SET_OPENING_BALANCE, EDIT_OPENING_BALANCE, USER_SNIPPED_DATA, TODAY_DATE, TIMESTAMP, CAPITAL_SNIPPED_DATA, BANK_SNIPPED_DATA, SINGLE_FIRM_DATA, SINGLE_SERVICE_DATA, SINGLE_TASK_STAFF_LIST } from "../helpers/function.js";
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { resolveSaleEntriesBranchId } from "../helpers/saleEntriesBranch.js";
import { fetchBranchGstSettings, resolveGst, toDateOnly } from "../helpers/gst.js";

const router = express.Router();

function normalizeDiscountAndTotals({
    subtotal,
    taxRateNum,
    discount_type,
    discount_perc_rate,
    discount_value,
    additional_charge,
    round_off
}) {
    const allowedDiscountTypes = ["not applicable", "percentage", "flat"];
    const discountType = discount_type != null && String(discount_type).trim() !== ""
        ? String(discount_type).trim().toLowerCase()
        : "not applicable";

    if (!allowedDiscountTypes.includes(discountType)) {
        throw new Error("discount_type must be one of: not applicable, percentage, flat");
    }

    let discountPercRate = 0;
    let discountValue = 0;

    if (discountType === "percentage") {
        const rate = Number(discount_perc_rate);
        if (!Number.isFinite(rate) || rate < 0) {
            throw new Error("discount_perc_rate is required when discount_type is percentage");
        }
        discountPercRate = Number(rate.toFixed(2));
        discountValue = Number(((subtotal * discountPercRate) / 100).toFixed(2));
    } else if (discountType === "flat") {
        const value = Number(discount_value);
        if (!Number.isFinite(value) || value < 0) {
            throw new Error("discount_value is required when discount_type is flat");
        }
        discountValue = Number(value.toFixed(2));
    }

    if (discountValue > subtotal) {
        discountValue = subtotal;
    }

    const additionalCharge = additional_charge == null || String(additional_charge).trim?.() === ""
        ? 0
        : Number(additional_charge);
    if (!Number.isFinite(additionalCharge) || additionalCharge < 0) {
        throw new Error("additional_charge must be a valid number greater than or equal to 0");
    }

    const taxableSubtotal = Number((subtotal - discountValue).toFixed(2));
    const taxValue = Number(((taxableSubtotal * taxRateNum) / 100).toFixed(2));
    const totalBeforeRound = Number((taxableSubtotal + taxValue + additionalCharge).toFixed(2));

    const applyRoundOff = Boolean(round_off);
    const grandTotal = applyRoundOff ? Math.floor(totalBeforeRound) : totalBeforeRound;
    const roundOffValue = Number((grandTotal - totalBeforeRound).toFixed(2));

    return {
        discountType,
        discountPercRate,
        discountValue: Number(discountValue.toFixed(2)),
        additionalCharge: Number(additionalCharge.toFixed(2)),
        taxValue,
        totalBeforeRound,
        roundOffValue,
        grandTotal: Number(grandTotal.toFixed(2))
    };
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

function normFirm(f) {
    if (f == null || String(f).trim() === "") return null;
    return String(f).trim();
}

/**
 * One invoice + sale entry + transaction + one sale line for a single task (caller must hold an open transaction).
 */
async function generateBillForSingleTask(connection, { username, branch_id, taskRow }) {
    const clientUsername = String(taskRow.username || "").trim();
    if (!clientUsername) {
        const e = new Error("Task client username is missing");
        e.httpStatus = 400;
        throw e;
    }

    const firm0 = normFirm(taskRow.firm_id);

    const [profileRows] = await connection.query(
        `SELECT user_type FROM profile WHERE username = ? AND (status = '1' OR status = 1) LIMIT 1`,
        [clientUsername]
    );
    const party2_type =
        profileRows[0]?.user_type != null && String(profileRows[0].user_type).trim() !== ""
            ? String(profileRows[0].user_type).trim()
            : "client";

    const amountTotal = Number(Number(taskRow.fees || 0).toFixed(2));
    const gstSettings = await fetchBranchGstSettings(connection, branch_id);
    const asOfDate = toDateOnly(TODAY_DATE()) || toDateOnly(new Date());
    const gst = resolveGst({ fees: amountTotal, asOfDate, settings: gstSettings });
    const effectiveTaxRate = gst.tax_rate;

    let pricing;
    try {
        pricing = normalizeDiscountAndTotals({
            subtotal: amountTotal,
            taxRateNum: effectiveTaxRate,
            discount_type: "not applicable",
            discount_perc_rate: 0,
            discount_value: 0,
            additional_charge: 0,
            round_off: false
        });
    } catch (validationErr) {
        const e = new Error(validationErr.message);
        e.httpStatus = 400;
        throw e;
    }

    const invoice_id = await UNIQUE_RANDOM_STRING("invoice", "invoice_id", { length: ID_LENGTH, conn: connection });
    const transaction_id = await UNIQUE_RANDOM_STRING("transactions", "transaction_id", { length: ID_LENGTH, conn: connection });
    const txnDate = TODAY_DATE();

    const [invoicePrefixRows] = await connection.query(
        "SELECT * FROM `invoice_prefix` WHERE `branch_id` = ? AND `type` = ? AND `is_deleted` = ? AND `issue_date` <= ? AND `expire_date` >= ?",
        [branch_id, "sale", "0", TODAY_DATE(), TODAY_DATE()]
    );

    if (!invoicePrefixRows || invoicePrefixRows.length === 0) {
        const e = new Error("Invoice prefix not set for sale.");
        e.httpStatus = 400;
        throw e;
    }

    const invoiceData = invoicePrefixRows[0];
    const invoicePrimaryId = invoiceData?.id;
    const serial = Number(invoiceData?.current || 0) + 1;
    const invoice_no = `${invoiceData?.prefix}${serial}`;

    await connection.query(
        `INSERT INTO invoice (invoice_id, branch_id, invoice_no, create_by, modify_by, type, transaction_id, subtotal, discount_type, discount_perc_rate, discount_value, additional_charge, total, round_off, grand_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            invoice_id,
            branch_id,
            invoice_no,
            username,
            username,
            "sale",
            transaction_id,
            amountTotal,
            pricing.discountType,
            pricing.discountPercRate,
            pricing.discountValue,
            pricing.additionalCharge,
            pricing.totalBeforeRound,
            pricing.roundOffValue,
            pricing.grandTotal
        ]
    );

    const saleEntriesBranchId = await resolveSaleEntriesBranchId(connection, branch_id);
    if (saleEntriesBranchId == null) {
        const e = new Error(`Invalid branch_id for sale_entries (branch "${branch_id}" not found in branch_list)`);
        e.httpStatus = 400;
        throw e;
    }

    const sale_entry_id = await UNIQUE_RANDOM_STRING("sale_entries", "sale_id", { length: ID_LENGTH, conn: connection });
    await insertRow(connection, "sale_entries", {
        branch_id: saleEntriesBranchId,
        sale_id: sale_entry_id,
        invoice_id,
        party_id: clientUsername,
        party_type: party2_type,
        firm_id: firm0,
        sale_date: txnDate,
        create_by: username,
        modify_by: username,
        total: pricing.grandTotal,
        is_task: "1"
    });

    await connection.query(
        `INSERT INTO transactions (branch_id, transaction_id, create_by, modify_by, transaction_date, amount, transaction_type, invoice_id, invoice_no, party1_type, party1_id, party2_type, party2_id, remark)
         VALUES (?, ?, ?, ?, ?, ?, 'sale', ?, ?, ?, ?, ?, ?, ?)`,
        [
            branch_id,
            transaction_id,
            username,
            username,
            txnDate,
            pricing.grandTotal,
            invoice_id,
            invoice_no,
            "sale",
            invoice_id,
            party2_type,
            clientUsername,
            null
        ]
    );

    const item_id = await UNIQUE_RANDOM_STRING("sale_items", "item_id", { length: ID_LENGTH, conn: connection });
    const fees = Number(Number(taskRow.fees).toFixed(2));
    const lineGst = resolveGst({ fees, asOfDate, settings: gstSettings });
    const lineTotal = lineGst.total;
    const itemRemark = `task:${taskRow.task_id}`;
    await connection.query(
        `INSERT INTO sale_items (branch_id, item_id, sale_id, invoice_id, service_id, fees, total, remark)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [branch_id, item_id, sale_entry_id, invoice_id, taskRow.service_id, fees, lineTotal, itemRemark]
    );

    await connection.query("UPDATE `invoice_prefix` SET `current` = ? WHERE `id` = ?", [serial, invoicePrimaryId]);

    const [updResult] = await connection.query(
        `UPDATE tasks SET invoice_id = ?, invoice_no = ?, billing_status = '1' WHERE branch_id = ? AND task_id = ? AND billing_status = '0' AND status = 'complete'`,
        [invoice_id, invoice_no, branch_id, taskRow.task_id]
    );

    if (updResult.affectedRows !== 1) {
        const e = new Error("Could not update task (possible concurrent billing). Try again.");
        e.httpStatus = 409;
        throw e;
    }

    return {
        invoice_id,
        transaction_id,
        invoice_no,
        username: clientUsername,
        user_type: party2_type,
        firm_id: firm0,
        transaction_date: txnDate,
        task_ids: [taskRow.task_id],
        subtotal: amountTotal,
        discount_type: pricing.discountType,
        discount_perc_rate: pricing.discountPercRate,
        discount_value: pricing.discountValue,
        tax_rate: effectiveTaxRate,
        gst_value: pricing.taxValue,
        additional_charge: pricing.additionalCharge,
        total: pricing.totalBeforeRound,
        round_off: pricing.roundOffValue,
        grand_total: pricing.grandTotal,
        remark: null
    };
}

function formatBillingStatus(raw) {
    if (raw == "0") return "pending";
    if (raw == "1") return "generated";
    if (raw == "2") return "non billable";
    return "unknown";
}

const BILLING_STATUS_FILTER_MAP = {
    pending: "0",
    generated: "1",
    nonbillable: "2",
    "non billable": "2",
    "non-billable": "2",
};

function parseBillingStatusFilter(statusRaw) {
    if (statusRaw == null || String(statusRaw).trim() === "") {
        return { billingStatuses: ["0", "1", "2"] };
    }

    const key = String(statusRaw).trim().toLowerCase();
    const code = BILLING_STATUS_FILTER_MAP[key];
    if (!code) {
        return {
            error: "Invalid status. Allowed: pending, generated, nonbillable (omit for all)",
        };
    }

    return { billingStatuses: [code] };
}

/**
 * Complete tasks filtered by billing_status ('0' pending, '1' generated, '2' non-billable).
 * Optional query `status` — empty/null returns all billing statuses.
 * Optional query `username` — exact match on task client username when provided.
 */
async function handleBillingTaskList(req, res) {
    try {
        const branch_id = req.branch_id;
        const {
            page_no = 1,
            limit = 20,
            search = "",
            status,
            username,
        } = req.query || {};

        const statusFilter = parseBillingStatusFilter(status);
        if (statusFilter.error) {
            return res.status(400).json({
                success: false,
                message: statusFilter.error,
            });
        }

        const pageNum = Math.max(1, Number(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
        const offset = (pageNum - 1) * limitNum;

        const searchRaw = search != null ? String(search) : "";
        const hasSearch = String(searchRaw).trim() !== "";
        const usernameFilter =
            username != null && String(username).trim() !== "" ? String(username).trim() : "";

        const billingPlaceholders = statusFilter.billingStatuses.map(() => "?").join(", ");
        const params = [branch_id, ...statusFilter.billingStatuses];
        let baseQuery = `
            FROM tasks t
            LEFT JOIN firms f
                ON f.firm_id = t.firm_id
                AND (f.is_deleted = '0' OR f.is_deleted = 0)
            LEFT JOIN services s
                ON s.service_id = t.service_id
            LEFT JOIN users u
                ON u.username = t.username
            WHERE t.branch_id = ?
                AND t.status = 'complete'
                AND t.billing_status IN (${billingPlaceholders})
        `;

        if (usernameFilter !== "") {
            baseQuery += " AND t.username = ?";
            params.push(usernameFilter);
        }

        if (hasSearch) {
            const searchPattern = `%${String(searchRaw).trim()}%`;
            baseQuery += `
              AND (
                  t.task_id LIKE ?
                  OR t.username LIKE ?
                  OR t.firm_id LIKE ?
                  OR t.service_id LIKE ?
                  OR IFNULL(t.invoice_id, '') LIKE ?
                  OR CAST(t.fees AS CHAR) LIKE ?
                  OR CAST(t.total AS CHAR) LIKE ?
                  OR f.username LIKE ?
                  OR f.firm_name LIKE ?
                  OR IFNULL(f.gst_no, '') LIKE ?
                  OR IFNULL(f.pan_no, '') LIKE ?
                  OR IFNULL(f.city, '') LIKE ?
                  OR IFNULL(f.file_no, '') LIKE ?
                  OR s.name LIKE ?
                  OR s.service_id LIKE ?
                  OR IFNULL(u.remark, '') LIKE ?
                  OR EXISTS (
                      SELECT 1 FROM profile pr
                      WHERE pr.username = t.username
                        AND (pr.status = '1' OR pr.status = 1)
                        AND (
                            IFNULL(pr.name, '') LIKE ?
                            OR IFNULL(pr.email, '') LIKE ?
                            OR IFNULL(pr.mobile, '') LIKE ?
                        )
                  )
              )
            `;
            for (let i = 0; i < 16; i++) {
                params.push(searchPattern);
            }
            params.push(searchPattern, searchPattern, searchPattern);
        }

        const countQuery = `SELECT COUNT(*) AS total ${baseQuery}`;
        const [countRows] = await pool.query(countQuery, params);
        const total = countRows[0]?.total || 0;

        const listQuery = `
            SELECT
                t.task_id,
                t.invoice_id,
                t.invoice_no,
                t.username,
                t.firm_id,
                t.service_id,
                t.has_ca,
                t.ca_id,
                t.has_agent,
                t.agent_id,
                t.fees,
                t.total,
                t.due_date,
                t.target_date,
                t.billing_status,
                t.status,
                t.create_date,
                t.create_by,
                t.is_recurring,
                f.username AS firm_username,
                f.firm_name,
                s.name AS service_name
            ${baseQuery}
            ORDER BY t.create_date DESC, t.id DESC
            LIMIT ? OFFSET ?
        `;

        const listParams = [...params, limitNum, offset];
        const [rows] = await pool.query(listQuery, listParams);

        const list = [];
        for (let index = 0; index < rows.length; index++) {
            const element = rows[index];

            const create_by = await USER_SNIPPED_DATA(element?.create_by);
            const modify_by = await USER_SNIPPED_DATA(element?.modify_by || element?.create_by);
            const client_profile = await USER_SNIPPED_DATA(element?.username);
            const firm_data = await SINGLE_FIRM_DATA(element?.firm_id);
            const service_data = await SINGLE_SERVICE_DATA(element?.service_id);

            const staffs = await SINGLE_TASK_STAFF_LIST(element?.task_id);
            const object = {
                task_id: element?.task_id,
                client: {
                    username: element?.username,
                    profile: client_profile
                },
                firm: {
                    firm_id: firm_data?.firm_id,
                    firm_name: firm_data?.firm_name
                },
                service: {
                    service_id: service_data?.service_id,
                    name: service_data?.name
                },
                charges: (() => {
                    const feesNum = Number(element?.fees) || 0;
                    const g = resolveGst({ fees: feesNum, asOfDate: element?.create_date, settings: gstSettingsList });
                    return { fees: feesNum, tax_rate: g.tax_rate, tax_value: g.tax_value, total: g.total };
                })(),
                dates: {
                    due_date: element?.due_date,
                    create_date: element?.create_date,
                    target_date: element?.target_date,
                },
                billing_status: formatBillingStatus(element?.billing_status),
                status: element?.status,
                create_by,
                modify_by,
                is_recurring: element?.is_recurring == "1",
                staffs
            };

            const has_ca = element?.has_ca == "1";
            object.has_ca = has_ca;
            if (has_ca) {
                const ca_data = await USER_SNIPPED_DATA(element?.ca_id);
                object.ca = ca_data;
            }

            const has_agent = element?.has_agent == "1";
            object.has_agent = has_agent;
            if (has_agent) {
                const agent_data = await USER_SNIPPED_DATA(element?.agent_id);
                object.agent = agent_data;
            }

            if (element?.billing_status == "1") {
                object.invoice_id = element?.invoice_id;
                object.invoice_no = element?.invoice_no;
            }

            list.push(object);
        }

        return res.status(200).json({
            success: true,
            message: "Billing task list retrieved successfully",
            data: list,
            pagination: {
                page_no: pageNum,
                limit: limitNum,
                total,
                total_pages: Math.ceil(total / limitNum),
                is_last_page: offset + rows.length >= total
            }
        });
    } catch (error) {
        console.error("Billing list error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch billing task list",
            error: error.message
        });
    }
}

router.get("/stats", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;

        const [pending_row] = await pool.query(`SELECT COUNT(*) AS total FROM tasks WHERE branch_id = ? AND status = 'complete' AND billing_status = '0'`, [branch_id]);

        const [generated_row] = await pool.query(`SELECT COUNT(*) AS total FROM tasks WHERE branch_id = ? AND status = 'complete' AND billing_status = '1'`, [branch_id]);

        const [non_billable_row] = await pool.query(`SELECT COUNT(*) AS total FROM tasks WHERE branch_id = ? AND status = 'complete' AND billing_status = '2'`, [branch_id]);

        return res.status(200).json({
            success: true,
            message: "Billing stats retrieved successfully",
            data: {
                total: Number(pending_row[0]?.total) + Number(generated_row[0]?.total) + Number(non_billable_row[0]?.total) || 0,
                pending: Number(pending_row[0]?.total) || 0,
                generated: Number(generated_row[0]?.total) || 0,
                non_billable: Number(non_billable_row[0]?.total) || 0,
            }
        });
    } catch (error) {
        console.error("Billing stats error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch billing stats",
            error: error.message
        });
    }
});

router.get("/list", auth, validateBranch, async (req, res) => {
    return handleBillingTaskList(req, res);
});

router.post("/generate/billable", auth, validateBranch, async (req, res) => {
    try {
        const username = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;
        const { task_ids } = req.body || {};

        if (!Array.isArray(task_ids) || task_ids.length === 0) {
            return res.status(400).json({ success: false, message: "task_ids is required and must be a non-empty array" });
        }

        const normalizedIds = [...new Set(
            task_ids.map((id) => (id != null ? String(id).trim() : "")).filter((s) => s !== "")
        )];
        if (normalizedIds.length === 0) {
            return res.status(400).json({ success: false, message: "task_ids must contain valid task id strings" });
        }

        const placeholders = normalizedIds.map(() => "?").join(", ");
        const [taskRows] = await pool.query(
            `SELECT task_id, username, firm_id, service_id, fees, total, status, billing_status
             FROM tasks
             WHERE branch_id = ?
               AND task_id IN (${placeholders})
               AND status = 'complete'
               AND billing_status = '0'
               AND (invoice_id IS NULL OR TRIM(IFNULL(invoice_id, '')) = '')
             ORDER BY FIELD(task_id, ${placeholders})`,
            [branch_id, ...normalizedIds, ...normalizedIds]
        );

        if (taskRows.length !== normalizedIds.length) {
            return res.status(400).json({
                success: false,
                message: "One or more tasks were not found, are not complete, already billed, or not pending billing"
            });
        }

        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            const invoices = [];
            for (let i = 0; i < taskRows.length; i++) {
                const summary = await generateBillForSingleTask(connection, {
                    username,
                    branch_id,
                    taskRow: taskRows[i]
                });
                invoices.push(summary);
            }

            await connection.commit();

            return res.status(200).json({
                success: true,
                message: "Bills generated successfully",
                data: {
                    invoices,
                    count: invoices.length
                }
            });
        } catch (err) {
            await connection.rollback();
            if (err.httpStatus) {
                return res.status(err.httpStatus).json({
                    success: false,
                    message: err.message
                });
            }
            throw err;
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error("Generate billable error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to generate bill",
            error: error.message
        });
    }
});

router.post("/generate/nonbillable", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { task_ids } = req.body || {};

        if (!Array.isArray(task_ids) || task_ids.length === 0) {
            return res.status(400).json({ success: false, message: "task_ids is required and must be a non-empty array" });
        }

        const normalizedIds = [...new Set(
            task_ids.map((id) => (id != null ? String(id).trim() : "")).filter((s) => s !== "")
        )];
        if (normalizedIds.length === 0) {
            return res.status(400).json({ success: false, message: "task_ids must contain valid task id strings" });
        }

        const placeholders = normalizedIds.map(() => "?").join(", ");
        const [updResult] = await pool.query(
            `UPDATE tasks SET billing_status = '2'
             WHERE branch_id = ?
               AND task_id IN (${placeholders})
               AND status = 'complete'
               AND billing_status = '0'
               AND (invoice_id IS NULL OR TRIM(IFNULL(invoice_id, '')) = '')`,
            [branch_id, ...normalizedIds]
        );

        if (updResult.affectedRows !== normalizedIds.length) {
            return res.status(400).json({
                success: false,
                message: "One or more tasks were not found, are not complete, already invoiced, or not pending billing"
            });
        }

        return res.status(200).json({
            success: true,
            message: "Tasks marked as non-billable successfully",
            data: {
                task_ids: normalizedIds,
                billing_status: "2"
            }
        });
    } catch (error) {
        console.error("Generate nonbillable error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to mark tasks as non-billable",
            error: error.message
        });
    }
});



export default router;