import express from "express";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { GET_BALANCE, UNIQUE_RANDOM_STRING, ID_LENGTH, SET_OPENING_BALANCE, EDIT_OPENING_BALANCE, USER_SNIPPED_DATA, TODAY_DATE, TIMESTAMP, CAPITAL_SNIPPED_DATA, BANK_SNIPPED_DATA } from "../helpers/function.js";
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { notifySaleInvoiceEmail, getSaleItems } from "../helpers/saleStaticEmail.js";
import { resolveSaleEntriesBranchId } from "../helpers/saleEntriesBranch.js";

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



router.post("/create/user", auth, validateBranch, async (req, res) => {
    try {
        const username = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;

        const {
            username: partyUsername,
            user_type,
            firm_id,
            transaction_date,
            remark,
            tax_rate,
            discount_type,
            discount_perc_rate,
            discount_value,
            additional_charge,
            round_off,
            items
        } = req.body || {};

        if (!partyUsername || String(partyUsername).trim() === "") {
            return res.status(400).json({ success: false, message: "username is required" });
        }
        if (!user_type || String(user_type).trim() === "") {
            return res.status(400).json({ success: false, message: "user_type is required" });
        }
        if (!transaction_date || String(transaction_date).trim() === "") {
            return res.status(400).json({ success: false, message: "transaction_date is required" });
        }
        if (tax_rate == null || String(tax_rate).trim?.() === "") {
            return res.status(400).json({ success: false, message: "tax_rate is required" });
        }
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ success: false, message: "items is required and must be a non-empty array" });
        }

        const party2_id = String(partyUsername).trim();
        const party2_type = String(user_type).trim();
        const txnDate = String(transaction_date).trim();
        const remarkVal = remark != null ? String(remark).trim() : null;
        const firmId = firm_id != null && String(firm_id).trim() !== "" ? String(firm_id).trim() : null;
        const taxRateNum = Number(tax_rate);

        if (!Number.isFinite(taxRateNum) || taxRateNum < 0) {
            return res.status(400).json({ success: false, message: "tax_rate must be a valid number greater than or equal to 0" });
        }

        const normalizedItems = [];
        for (let index = 0; index < items.length; index++) {
            const item = items[index] || {};
            const service_id = item?.service_id != null ? String(item.service_id).trim() : "";
            const feesNum = Number(item?.fees);
            const itemRemark = item?.remark != null ? String(item.remark).trim() : null;

            if (!service_id) {
                return res.status(400).json({ success: false, message: `items[${index}].service_id is required` });
            }
            if (!Number.isFinite(feesNum) || feesNum <= 0) {
                return res.status(400).json({ success: false, message: `items[${index}].fees must be greater than 0` });
            }

            normalizedItems.push({ service_id, feesNum, itemRemark });
        }

        const serviceIds = normalizedItems.map(el => el.service_id);
        const placeholders = serviceIds.map(() => "?").join(", ");
        const [serviceRows] = await pool.query(
            `SELECT service_id FROM branch_services WHERE branch_id = ? AND is_deleted = '0' AND service_id IN (${placeholders})`,
            [branch_id, ...serviceIds]
        );
        const serviceSet = new Set(serviceRows.map(row => String(row.service_id)));

        for (let index = 0; index < normalizedItems.length; index++) {
            if (!serviceSet.has(normalizedItems[index].service_id)) {
                return res.status(400).json({
                    success: false,
                    message: `Invalid service_id in items[${index}]: ${normalizedItems[index].service_id}`
                });
            }
        }

        const saleItemsToInsert = [];

        let amountTotal = 0;
        let itemsTaxTotal = 0;

        for (let index = 0; index < normalizedItems.length; index++) {
            const current = normalizedItems[index];
            const taxValue = Number(((current.feesNum * taxRateNum) / 100).toFixed(2));
            const itemTotal = Number((current.feesNum + taxValue).toFixed(2));

            amountTotal += current.feesNum;
            itemsTaxTotal += taxValue;

            saleItemsToInsert.push({
                service_id: current.service_id,
                fees: Number(current.feesNum.toFixed(2)),
                tax_perc: Number(taxRateNum.toFixed(2)),
                tax_value: taxValue,
                total: itemTotal,
                remark: current.itemRemark
            });
        }

        amountTotal = Number(amountTotal.toFixed(2));
        const effectiveTaxRate = Number(taxRateNum.toFixed(2));
        let pricing;
        try {
            pricing = normalizeDiscountAndTotals({
                subtotal: amountTotal,
                taxRateNum: effectiveTaxRate,
                discount_type,
                discount_perc_rate,
                discount_value,
                additional_charge,
                round_off
            });
        } catch (validationErr) {
            return res.status(400).json({ success: false, message: validationErr.message });
        }

        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            const invoice_id = await UNIQUE_RANDOM_STRING("invoice", "invoice_id", { length: ID_LENGTH, conn: connection });
            const transaction_id = await UNIQUE_RANDOM_STRING("transactions", "transaction_id", { length: ID_LENGTH, conn: connection });

            const [invoicePrefixRows] = await connection.query(
                "SELECT * FROM `invoice_prefix` WHERE `branch_id` = ? AND `type` = ? AND `is_deleted` = ? AND `issue_date` <= ? AND `expire_date` >= ?",
                [branch_id, "sale", "0", TODAY_DATE(), TODAY_DATE()]
            );

            if (!invoicePrefixRows || invoicePrefixRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ success: false, message: "Invoice prefix not set for sale." });
            }

            const invoiceData = invoicePrefixRows[0];
            const invoicePrimaryId = invoiceData?.id;
            const serial = Number(invoiceData?.current || 0) + 1;
            const invoice_no = `${invoiceData?.prefix}${serial}`;

            const [invoiceInsertResult] = await connection.query(
                `INSERT INTO invoice (invoice_id, branch_id, invoice_no, create_by, modify_by, type, transaction_id, subtotal, discount_type, discount_perc_rate, discount_value, tax_rate, tax_value, additional_charge, total, round_off, grand_total)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [invoice_id, branch_id, invoice_no, username, username, "sale", transaction_id, amountTotal, pricing.discountType, pricing.discountPercRate, pricing.discountValue, effectiveTaxRate, pricing.taxValue, pricing.additionalCharge, pricing.totalBeforeRound, pricing.roundOffValue, pricing.grandTotal]
            );

            const saleEntriesBranchId = await resolveSaleEntriesBranchId(connection, branch_id);
            if (saleEntriesBranchId == null) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({
                    success: false,
                    message: `Invalid branch_id for sale_entries (branch "${branch_id}" not found in branch_list)`,
                });
            }

            const sale_entry_id = await UNIQUE_RANDOM_STRING("sale_entries", "sale_id", { length: ID_LENGTH, conn: connection });
            await connection.query(
                `INSERT INTO sale_entries (branch_id, sale_id, invoice_id, party_id, party_type, firm_id, sale_date, create_by, modify_by, total)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [saleEntriesBranchId, sale_entry_id, invoice_id, party2_id, party2_type, firmId, txnDate, username, username, pricing.grandTotal]
            );

            await connection.query(
                `INSERT INTO transactions (branch_id, transaction_id, create_by, modify_by, transaction_date, amount, transaction_type, invoice_id, invoice_no, party1_type, party1_id, party2_type, party2_id, remark)
                 VALUES (?, ?, ?, ?, ?, ?, 'sale', ?, ?, ?, ?, ?, ?, ?)`,
                [branch_id, transaction_id, username, username, txnDate, pricing.grandTotal, invoice_id, invoice_no, "sale", invoice_id, party2_type, party2_id, remarkVal]
            );

            for (let index = 0; index < saleItemsToInsert.length; index++) {
                const row = saleItemsToInsert[index];
                const item_id = await UNIQUE_RANDOM_STRING("sale_items", "item_id", { length: ID_LENGTH, conn: connection });
                await connection.query(
                    `INSERT INTO sale_items (branch_id, item_id, sale_id, invoice_id, service_id, fees, tax_perc, tax_value, total, remark)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [branch_id, item_id, sale_entry_id, invoice_id, row.service_id, row.fees, row.tax_perc, row.tax_value, row.total, row.remark]
                );
            }

            await connection.query("UPDATE `invoice_prefix` SET `current` = ? WHERE `id` = ?", [serial, invoicePrimaryId]);

            await connection.commit();

            const saleItemsForEmail = await getSaleItems(sale_entry_id);

            await notifySaleInvoiceEmail({
                branch_id: branch_id,
                sale_id: sale_entry_id,
                invoice_id: invoice_id,
                invoice_no: invoice_no,
                party_id: party2_id,
                party_type: party2_type,
                sale_date: txnDate,
                grand_total: pricing.grandTotal,
                items: saleItemsForEmail,
                subtotal: amountTotal,
                discount_value: pricing.discountValue,
                tax_value: pricing.taxValue,
                total: pricing.totalBeforeRound
            });

            return res.status(200).json({
                success: true,
                message: "Sale created successfully",
                data: {
                    invoice_id,
                    transaction_id,
                    invoice_no,
                    username: party2_id,
                    user_type: party2_type,
                    firm_id: firmId,
                    transaction_date: txnDate,
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
                    remark: remarkVal,
                    items_tax_total: Number(itemsTaxTotal.toFixed(2)),
                    items: saleItemsToInsert
                }
            });
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }

    } catch (error) {
        console.error("Create sale fatal error:", error);
        return res.status(500).json({ success: false, message: "Failed to create sale", error: error.message });
    }
});

router.post("/create/bank", auth, validateBranch, async (req, res) => {
    try {
        const username = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;

        const {
            bank_id,
            transaction_date,
            remark,
            tax_rate,
            discount_type,
            discount_perc_rate,
            discount_value,
            additional_charge,
            round_off,
            items
        } = req.body || {};

        if (!bank_id || String(bank_id).trim() === "") {
            return res.status(400).json({ success: false, message: "bank_id is required" });
        }
        if (!transaction_date || String(transaction_date).trim() === "") {
            return res.status(400).json({ success: false, message: "transaction_date is required" });
        }
        if (tax_rate == null || String(tax_rate).trim?.() === "") {
            return res.status(400).json({ success: false, message: "tax_rate is required" });
        }
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ success: false, message: "items is required and must be a non-empty array" });
        }

        const party2_id = String(bank_id).trim();
        const party2_type = "bank";
        const txnDate = String(transaction_date).trim();
        const remarkVal = remark != null ? String(remark).trim() : null;
        const taxRateNum = Number(tax_rate);

        if (!Number.isFinite(taxRateNum) || taxRateNum < 0) {
            return res.status(400).json({ success: false, message: "tax_rate must be a valid number greater than or equal to 0" });
        }

        const [[bankRow]] = await pool.query(
            "SELECT bank_id FROM banks WHERE branch_id = ? AND bank_id = ? LIMIT 1",
            [branch_id, party2_id]
        );
        if (!bankRow) {
            return res.status(400).json({ success: false, message: "Invalid bank_id" });
        }

        const normalizedItems = [];
        for (let index = 0; index < items.length; index++) {
            const item = items[index] || {};
            const service_id = item?.service_id != null ? String(item.service_id).trim() : "";
            const feesNum = Number(item?.fees);
            const itemRemark = item?.remark != null ? String(item.remark).trim() : null;

            if (!service_id) {
                return res.status(400).json({ success: false, message: `items[${index}].service_id is required` });
            }
            if (!Number.isFinite(feesNum) || feesNum <= 0) {
                return res.status(400).json({ success: false, message: `items[${index}].fees must be greater than 0` });
            }

            normalizedItems.push({ service_id, feesNum, itemRemark });
        }

        const serviceIds = normalizedItems.map(el => el.service_id);
        const placeholders = serviceIds.map(() => "?").join(", ");
        const [serviceRows] = await pool.query(
            `SELECT service_id FROM branch_services WHERE branch_id = ? AND is_deleted = '0' AND service_id IN (${placeholders})`,
            [branch_id, ...serviceIds]
        );
        const serviceSet = new Set(serviceRows.map(row => String(row.service_id)));

        for (let index = 0; index < normalizedItems.length; index++) {
            if (!serviceSet.has(normalizedItems[index].service_id)) {
                return res.status(400).json({
                    success: false,
                    message: `Invalid service_id in items[${index}]: ${normalizedItems[index].service_id}`
                });
            }
        }

        const saleItemsToInsert = [];

        let amountTotal = 0;
        let itemsTaxTotal = 0;

        for (let index = 0; index < normalizedItems.length; index++) {
            const current = normalizedItems[index];
            const taxValue = Number(((current.feesNum * taxRateNum) / 100).toFixed(2));
            const itemTotal = Number((current.feesNum + taxValue).toFixed(2));

            amountTotal += current.feesNum;
            itemsTaxTotal += taxValue;

            saleItemsToInsert.push({
                service_id: current.service_id,
                fees: Number(current.feesNum.toFixed(2)),
                tax_perc: Number(taxRateNum.toFixed(2)),
                tax_value: taxValue,
                total: itemTotal,
                remark: current.itemRemark
            });
        }

        amountTotal = Number(amountTotal.toFixed(2));
        const effectiveTaxRate = Number(taxRateNum.toFixed(2));
        let pricing;
        try {
            pricing = normalizeDiscountAndTotals({
                subtotal: amountTotal,
                taxRateNum: effectiveTaxRate,
                discount_type,
                discount_perc_rate,
                discount_value,
                additional_charge,
                round_off
            });
        } catch (validationErr) {
            return res.status(400).json({ success: false, message: validationErr.message });
        }

        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            const invoice_id = await UNIQUE_RANDOM_STRING("invoice", "invoice_id", { length: ID_LENGTH, conn: connection });
            const transaction_id = await UNIQUE_RANDOM_STRING("transactions", "transaction_id", { length: ID_LENGTH, conn: connection });

            const [invoicePrefixRows] = await connection.query(
                "SELECT * FROM `invoice_prefix` WHERE `branch_id` = ? AND `type` = ? AND `is_deleted` = ? AND `issue_date` <= ? AND `expire_date` >= ?",
                [branch_id, "sale", "0", TODAY_DATE(), TODAY_DATE()]
            );

            if (!invoicePrefixRows || invoicePrefixRows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ success: false, message: "Invoice prefix not set for sale." });
            }

            const invoiceData = invoicePrefixRows[0];
            const invoicePrimaryId = invoiceData?.id;
            const serial = Number(invoiceData?.current || 0) + 1;
            const invoice_no = `${invoiceData?.prefix}${serial}`;

            await connection.query(
                `INSERT INTO invoice (invoice_id, branch_id, invoice_no, create_by, modify_by, type, transaction_id, subtotal, discount_type, discount_perc_rate, discount_value, tax_rate, tax_value, additional_charge, total, round_off, grand_total)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [invoice_id, branch_id, invoice_no, username, username, "sale", transaction_id, amountTotal, pricing.discountType, pricing.discountPercRate, pricing.discountValue, effectiveTaxRate, pricing.taxValue, pricing.additionalCharge, pricing.totalBeforeRound, pricing.roundOffValue, pricing.grandTotal]
            );

            const saleEntriesBranchId = await resolveSaleEntriesBranchId(connection, branch_id);
            if (saleEntriesBranchId == null) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({
                    success: false,
                    message: `Invalid branch_id for sale_entries (branch "${branch_id}" not found in branch_list)`,
                });
            }

            const sale_entry_id = await UNIQUE_RANDOM_STRING("sale_entries", "sale_id", { length: ID_LENGTH, conn: connection });
            await connection.query(
                `INSERT INTO sale_entries (branch_id, sale_id, invoice_id, party_id, party_type, firm_id, sale_date, create_by, modify_by, total)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [saleEntriesBranchId, sale_entry_id, invoice_id, party2_id, party2_type, null, txnDate, username, username, pricing.grandTotal]
            );

            await connection.query(
                `INSERT INTO transactions (branch_id, transaction_id, create_by, modify_by, transaction_date, amount, transaction_type, invoice_id, invoice_no, party1_type, party1_id, party2_type, party2_id, remark)
                 VALUES (?, ?, ?, ?, ?, ?, 'sale', ?, ?, ?, ?, ?, ?, ?)`,
                [branch_id, transaction_id, username, username, txnDate, pricing.grandTotal, invoice_id, invoice_no, "sale", invoice_id, party2_type, party2_id, remarkVal]
            );

            for (let index = 0; index < saleItemsToInsert.length; index++) {
                const row = saleItemsToInsert[index];
                const item_id = await UNIQUE_RANDOM_STRING("sale_items", "item_id", { length: ID_LENGTH, conn: connection });
                await connection.query(
                    `INSERT INTO sale_items (branch_id, item_id, sale_id, invoice_id, service_id, fees, tax_perc, tax_value, total, remark)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [branch_id, item_id, sale_entry_id, invoice_id, row.service_id, row.fees, row.tax_perc, row.tax_value, row.total, row.remark]
                );
            }

            await connection.query("UPDATE `invoice_prefix` SET `current` = ? WHERE `id` = ?", [serial, invoicePrimaryId]);

            await connection.commit();

            const saleItemsForEmail = await getSaleItems(sale_entry_id);

            await notifySaleInvoiceEmail({
                branch_id: branch_id,
                sale_id: sale_entry_id,
                invoice_id: invoice_id,
                invoice_no: invoice_no,
                party_id: party2_id,
                party_type: party2_type,
                sale_date: txnDate,
                grand_total: pricing.grandTotal,
                items: saleItemsForEmail,
                subtotal: amountTotal,
                discount_value: pricing.discountValue,
                tax_value: pricing.taxValue,
                total: pricing.totalBeforeRound
            });

            return res.status(200).json({
                success: true,
                message: "Sale created successfully",
                data: {
                    invoice_id,
                    transaction_id,
                    invoice_no,
                    bank_id: party2_id,
                    transaction_date: txnDate,
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
                    remark: remarkVal,
                    items_tax_total: Number(itemsTaxTotal.toFixed(2)),
                    items: saleItemsToInsert
                }
            });
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error("Create sale fatal error:", error);
        return res.status(500).json({ success: false, message: "Failed to create sale", error: error.message });
    }
});

router.get("/list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const saleEntriesBranchId = await resolveSaleEntriesBranchId(pool, branch_id);
        if (saleEntriesBranchId == null) {
            return res.status(400).json({
                success: false,
                message: "Invalid branch context for sales"
            });
        }

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

        const rawListUsername = req.query?.username;
        const filterUsername =
            rawListUsername != null && String(rawListUsername).trim() !== ""
                ? String(rawListUsername).trim()
                : null;

        if (filterUsername) {
            const [[taskUserRow]] = await pool.query(
                `SELECT 1 AS ok FROM tasks
                 WHERE CAST(branch_id AS CHAR) = CAST(? AS CHAR) AND username = ?
                 LIMIT 1`,
                [branch_id, filterUsername]
            );
            if (!taskUserRow) {
                return res.status(400).json({
                    success: false,
                    message: "username is not present on tasks for this branch"
                });
            }
        }

        const usernameFilterSql = filterUsername
            ? `AND COALESCE(transactions.party2_id, se.party_id) = ?`
            : "";

        /** When search is set: invoice/remark + line items (service_id, service name, SAC) + client profile + firms */
        let searchFilterSql = "";
        const searchFilterParams = [];
        if (hasSearch) {
            const sp = searchPattern;
            searchFilterSql = `AND (
                invoice.invoice_no LIKE ?
                OR IFNULL(transactions.remark, '') LIKE ?
                OR EXISTS (
                    SELECT 1 FROM sale_items si
                    LEFT JOIN services svc ON svc.service_id = si.service_id
                    WHERE si.sale_id = se.sale_id
                        AND (
                            IFNULL(si.service_id, '') LIKE ?
                            OR IFNULL(svc.name, '') LIKE ?
                            OR IFNULL(svc.sac_code, '') LIKE ?
                        )
                )
                OR (
                    COALESCE(LOWER(transactions.party2_type), LOWER(se.party_type), '') <> 'bank'
                    AND (
                        EXISTS (
                            SELECT 1 FROM profile prof
                            WHERE prof.username = COALESCE(transactions.party2_id, se.party_id)
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
                            WHERE f.username = COALESCE(transactions.party2_id, se.party_id)
                                AND f.branch_id = ?
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
            searchFilterParams.push(branch_id);
            for (let i = 0; i < 11; i++) searchFilterParams.push(sp);
        }

        const whereClause = `se.branch_id = ?
            AND invoice.invoice_id = se.invoice_id
            AND invoice.branch_id = ?
            AND invoice.type = ?
            AND (DATE(se.sale_date) >= ? AND DATE(se.sale_date) <= ?)
            ${usernameFilterSql}
            ${searchFilterSql}`;
        const params = [
            saleEntriesBranchId,
            branch_id,
            branch_id,
            "sale",
            fromD,
            toD,
            ...(filterUsername ? [filterUsername] : []),
            ...searchFilterParams
        ];
        const listParams = [...params, limit, offset];

        const listSelect = `
            SELECT invoice.invoice_id, invoice.invoice_no, invoice.subtotal, invoice.discount_type, invoice.discount_perc_rate, invoice.discount_value, invoice.tax_rate, invoice.tax_value, invoice.additional_charge, invoice.total, invoice.round_off, invoice.grand_total,
                se.sale_id, se.is_task, se.sale_date AS sale_entry_date, se.total AS sale_entry_total,
                se.party_id AS entry_party_id, se.party_type AS entry_party_type, se.firm_id AS entry_firm_id,
                se.create_by AS entry_create_by, se.modify_by AS entry_modify_by,
                transactions.transaction_id, transactions.transaction_date, transactions.amount, transactions.remark,
                transactions.party2_type, transactions.party2_id, transactions.create_by, transactions.modify_by
            FROM sale_entries se
            INNER JOIN invoice ON invoice.invoice_id = se.invoice_id
            LEFT JOIN transactions ON transactions.transaction_id = invoice.transaction_id
            WHERE ${whereClause}
            ORDER BY se.sale_date DESC, se.id DESC
            LIMIT ? OFFSET ?`;

        const [rows] = await pool.query(listSelect, listParams);

        const saleIds = [...new Set(rows.map(r => r.sale_id).filter(id => id != null && String(id).trim() !== ""))];
        const itemsBySaleId = new Map();
        if (saleIds.length > 0) {
            const ph = saleIds.map(() => "?").join(", ");
            const [itemRows] = await pool.query(
                `SELECT si.sale_id, si.item_id, si.service_id, si.fees, si.tax_perc, si.tax_value, si.total, si.remark,
                        svc.service_id AS svc_id, svc.name AS svc_name, svc.sac_code AS svc_sac_code, svc.type AS svc_type
                 FROM sale_items si
                 LEFT JOIN services svc ON svc.service_id = si.service_id
                 WHERE si.sale_id IN (${ph})
                 ORDER BY si.id ASC`,
                saleIds
            );
            for (let i = 0; i < itemRows.length; i++) {
                const ir = itemRows[i];
                const sid = ir.sale_id;
                if (!itemsBySaleId.has(sid)) itemsBySaleId.set(sid, []);
                const svc =
                    ir.svc_id != null && String(ir.svc_id).trim() !== ""
                        ? {
                            service_id: ir.svc_id,
                            name: ir.svc_name,
                            sac_code: ir.svc_sac_code,
                            type: ir.svc_type
                        }
                        : {};
                itemsBySaleId.get(sid).push({
                    item_id: ir.item_id,
                    service_id: ir.service_id,
                    fees: ir.fees != null ? Number(ir.fees) : null,
                    tax_perc: ir.tax_perc != null ? Number(ir.tax_perc) : null,
                    tax_value: ir.tax_value != null ? Number(ir.tax_value) : null,
                    total: ir.total != null ? Number(ir.total) : null,
                    remark: ir.remark,
                    service: svc
                });
            }
        }

        const firmIds = [...new Set(
            rows
                .map(r => r.entry_firm_id)
                .filter(fid => fid != null && String(fid).trim() !== "")
                .map(fid => String(fid).trim())
        )];
        const firmByFirmId = new Map();
        if (firmIds.length > 0) {
            const ph = firmIds.map(() => "?").join(", ");
            const [firmRows] = await pool.query(
                `SELECT firm_id, username, firm_name, firm_type, gst_no, pan_no, tan_no, vat_no, cin_no, file_no,
                        address_line_1, address_line_2, city, district, state, country, pincode
                 FROM firms
                 WHERE CAST(branch_id AS CHAR) = CAST(? AS CHAR)
                   AND firm_id IN (${ph})
                   AND (is_deleted = '0' OR is_deleted = 0)`,
                [branch_id, ...firmIds]
            );
            for (let i = 0; i < firmRows.length; i++) {
                const fr = firmRows[i];
                if (fr?.firm_id != null && String(fr.firm_id).trim() !== "") {
                    firmByFirmId.set(String(fr.firm_id).trim(), {
                        firm_id: fr.firm_id,
                        username: fr.username,
                        firm_name: fr.firm_name,
                        firm_type: fr.firm_type,
                        gst_no: fr.gst_no,
                        pan_no: fr.pan_no,
                        tan_no: fr.tan_no,
                        vat_no: fr.vat_no,
                        cin_no: fr.cin_no,
                        file_no: fr.file_no,
                        address: {
                            address_line_1: fr.address_line_1,
                            address_line_2: fr.address_line_2,
                            city: fr.city,
                            district: fr.district,
                            state: fr.state,
                            country: fr.country,
                            pincode: fr.pincode
                        }
                    });
                }
            }
        }

        const [[{ total: totalRows }]] = await pool.query(
            `SELECT COUNT(*) AS total
             FROM sale_entries se
             INNER JOIN invoice ON invoice.invoice_id = se.invoice_id
             LEFT JOIN transactions ON transactions.transaction_id = invoice.transaction_id
             WHERE ${whereClause}`,
            params
        );
        const total = Number(totalRows) || 0;
        const [[amountStats]] = await pool.query(
            `SELECT
                COALESCE(SUM(invoice.grand_total), 0) AS amount_total,
                COALESCE(SUM(invoice.tax_value), 0) AS amount_tax,
                COALESCE(SUM(invoice.total - invoice.tax_value), 0) AS amount_net
             FROM sale_entries se
             INNER JOIN invoice ON invoice.invoice_id = se.invoice_id
             LEFT JOIN transactions ON transactions.transaction_id = invoice.transaction_id
             WHERE ${whereClause}`,
            params
        );
        const statsAmount = {
            net: Number(Number(amountStats?.amount_net ?? 0).toFixed(2)),
            tax: Number(Number(amountStats?.amount_tax ?? 0).toFixed(2)),
            total: Number(Number(amountStats?.amount_total ?? 0).toFixed(2))
        };

        const data = [];
        for (let index = 0; index < rows.length; index++) {
            const row = rows[index];
            const sale_type = row.party2_type ?? row.entry_party_type;
            const partyId = row.party2_id ?? row.entry_party_id;
            const firmId = row.entry_firm_id != null && String(row.entry_firm_id).trim() !== "" ? String(row.entry_firm_id).trim() : null;

            let sale_party = {};
            if (sale_type === "bank") {
                sale_party = await BANK_SNIPPED_DATA(partyId);
            } else {
                sale_party = await USER_SNIPPED_DATA(partyId);
            }
            const firm = sale_type === "client" && firmId ? (firmByFirmId.get(firmId) || {}) : {};

            const createByKey = row.create_by ?? row.entry_create_by;
            const modifyByKey = row.modify_by ?? row.entry_modify_by;
            const create_by = createByKey ? await USER_SNIPPED_DATA(createByKey) : {};
            const modify_by = modifyByKey ? await USER_SNIPPED_DATA(modifyByKey) : {};

            data.push({
                transaction_id: row.transaction_id,
                transaction_date: row.transaction_date ?? row.sale_entry_date,
                amount: row.amount ?? row.sale_entry_total,
                remark: row.remark,
                create_by,
                modify_by,
                invoice_no: row.invoice_no,
                invoice_id: row.invoice_id,
                sale_id: row.sale_id,
                sale_type,
                sale_party,
                firm_id: firmId,
                firm,
                is_task: row.is_task === "1" || row.is_task === 1,
                items: itemsBySaleId.get(row.sale_id) || [],
                calculation: {
                    subtotal: row.subtotal,
                    discount_type: row.discount_type,
                    discount_perc_rate: row.discount_perc_rate,
                    discount_value: row.discount_value,
                    tax_rate: row.tax_rate,
                    gst_value: row.tax_value,
                    additional_charge: row.additional_charge,
                    total: row.total,
                    round_off: row.round_off,
                    grand_total: row.grand_total
                }
            });
        }

        return res.status(200).json({
            success: true,
            data,
            stats: {
                count: total,
                amount: statsAmount
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
        console.error("Sale list error:", error);
        return res.status(500).json({ success: false, message: "Failed to get sale list", error: error.message });
    }
});


export default router;