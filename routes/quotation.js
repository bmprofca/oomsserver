import express from "express";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { BASE_DOMAIN } from "../helpers/Config.js";
import { buildQuotationPdfBuffer } from "../helpers/QuotationPdf.js";
import { RANDOM_STRING, SINGLE_FIRM_DATA, SINGLE_SERVICE_DATA, USER_DATA, USER_SNIPPED_DATA } from "../helpers/function.js";
import { createTaskFromQuotation } from "../helpers/taskCreateHelper.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const QUOTATION_PDF_DIR = path.join(__dirname, "..", "media", "quotation");

const router = express.Router();

function normalizeSingleQuotationItem(requestItems) {
    if (!Array.isArray(requestItems) || requestItems.length === 0) {
        return { error: "items is required and must contain exactly one service" };
    }
    if (requestItems.length > 1) {
        return { error: "Only one service is allowed per quotation" };
    }

    const item = requestItems[0] || {};
    const service_id = item?.service_id != null ? String(item.service_id).trim() : "";
    const feesNum = Number(item?.fees);
    const taxRateNum =
        item?.tax_rate == null || String(item.tax_rate).trim?.() === "" ? 0 : Number(item.tax_rate);

    if (!service_id) {
        return { error: "items[0].service_id is required" };
    }
    if (!Number.isFinite(feesNum) || feesNum < 0) {
        return { error: "items[0].fees must be a valid number greater than or equal to 0" };
    }
    if (!Number.isFinite(taxRateNum) || taxRateNum < 0) {
        return { error: "items[0].tax_rate must be a valid number greater than or equal to 0" };
    }

    const taxValue = Number(((feesNum * taxRateNum) / 100).toFixed(2));
    const total = Number((feesNum + taxValue).toFixed(2));

    return {
        item: {
            service_id,
            fees: Number(feesNum.toFixed(2)),
            tax_rate: Number(taxRateNum.toFixed(2)),
            tax_value: taxValue,
            total,
        },
    };
}

router.post("/create", auth, validateBranch, async (req, res) => {
    const connection = await pool.getConnection();
    let transactionStarted = false;
    try {
        const branch_id = req.branch_id;
        const createdBy = req.headers["username"] || "";
        const { username, firm_id, items: requestItems } = req.body || {};

        if (!username || String(username).trim() === "") {
            return res.status(400).json({ success: false, message: "username is required" });
        }

        const parsedItems = normalizeSingleQuotationItem(requestItems);
        if (parsedItems.error) {
            return res.status(400).json({ success: false, message: parsedItems.error });
        }
        const normalizedItems = [parsedItems.item];

        const serviceIds = normalizedItems.map(el => el.service_id);
        const placeholders = serviceIds.map(() => "?").join(", ");
        const [serviceRows] = await connection.query(
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

        const quotation_id = RANDOM_STRING(30);
        const normalizedStatus = "pending";

        await connection.beginTransaction();
        transactionStarted = true;

        await connection.query(
            `INSERT INTO quotations (branch_id, quotation_id, username, firm_id, create_by, modify_by, status)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                branch_id,
                quotation_id,
                String(username).trim(),
                firm_id != null && String(firm_id).trim() !== "" ? String(firm_id).trim() : null,
                createdBy,
                createdBy,
                normalizedStatus
            ]
        );

        for (let index = 0; index < normalizedItems.length; index++) {
            const item = normalizedItems[index];
            await connection.query(
                `INSERT INTO quotation_items (branch_id, quotation_id, service_id, create_by, modify_by, fees, tax_rate, tax_value, total)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    branch_id,
                    quotation_id,
                    item.service_id,
                    createdBy,
                    createdBy,
                    item.fees,
                    item.tax_rate,
                    item.tax_value,
                    item.total
                ]
            );
        }

        await connection.commit();

        const normalizedUsername = String(username).trim();
        const normalizedFirmId = firm_id != null && String(firm_id).trim() !== "" ? String(firm_id).trim() : null;
        const create_by = await USER_SNIPPED_DATA(createdBy);
        const modify_by = await USER_SNIPPED_DATA(createdBy);
        const firm_data = normalizedFirmId ? await SINGLE_FIRM_DATA(normalizedFirmId) : null;
        const client_data = await USER_DATA(normalizedUsername);

        let subtotal = 0;
        let tax_total = 0;
        let grand_total = 0;
        const items = [];

        for (let index = 0; index < normalizedItems.length; index++) {
            const item = normalizedItems[index];
            const service_data = await SINGLE_SERVICE_DATA(item.service_id);
            subtotal += Number(item.fees || 0);
            tax_total += Number(item.tax_value || 0);
            grand_total += Number(item.total || 0);
            items.push({
                quotation_id,
                service: {
                    service_id: service_data?.service_id,
                    name: service_data?.name,
                    amount: {
                        fees: Number(item.fees || 0),
                        tax_rate: Number(item.tax_rate || 0),
                        tax_value: Number(item.tax_value || 0),
                        total: Number(item.total || 0),
                    }
                },
            });
        }

        const [quotationRows] = await connection.query(
            `SELECT create_date, modify_date
             FROM quotations
             WHERE branch_id = ? AND quotation_id = ?
             LIMIT 1`,
            [branch_id, quotation_id]
        );
        const quotationRow = quotationRows?.[0] || {};

        return res.status(200).json({
            success: true,
            message: "Quotation created successfully",
            data: {
                quotation_id,
                client: {
                    username: client_data?.username,
                    name: client_data?.name,
                    email: client_data?.email,
                    mobile: client_data?.mobile,
                    pan_number: client_data?.pan_number,
                },
                firm: {
                    firm_id: firm_data?.firm_id,
                    firm_name: firm_data?.firm_name,
                    pan_no: firm_data?.pan_no,
                    firm_type: firm_data?.firm_type,
                },
                status: normalizedStatus,
                amount: {
                    fees: Number(subtotal.toFixed(2)),
                    tax_value: Number(tax_total.toFixed(2)),
                    total: Number(grand_total.toFixed(2)),
                },
                create_date: quotationRow.create_date || null,
                modify_date: quotationRow.modify_date || null,
                create_by,
                modify_by,
                items
            }
        });
    } catch (error) {
        if (transactionStarted) {
            await connection.rollback();
        }
        console.error("Error creating quotation:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to create quotation",
            error: error.message
        });
    } finally {
        connection.release();
    }
});

router.put("/edit", auth, validateBranch, async (req, res) => {
    const connection = await pool.getConnection();
    let transactionStarted = false;
    try {
        const branch_id = req.branch_id;
        const modifiedBy = req.headers["username"] || "";
        const { quotation_id, username, firm_id, items: requestItems } = req.body || {};

        if (!quotation_id || String(quotation_id).trim() === "") {
            return res.status(400).json({ success: false, message: "quotation_id is required" });
        }

        if (!username || String(username).trim() === "") {
            return res.status(400).json({ success: false, message: "username is required" });
        }

        const parsedItems = normalizeSingleQuotationItem(requestItems);
        if (parsedItems.error) {
            return res.status(400).json({ success: false, message: parsedItems.error });
        }
        const normalizedItems = [parsedItems.item];

        const normalizedQuotationId = String(quotation_id).trim();
        const serviceIds = normalizedItems.map(el => el.service_id);
        const placeholders = serviceIds.map(() => "?").join(", ");
        const [serviceRows] = await connection.query(
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

        await connection.beginTransaction();
        transactionStarted = true;

        const [existingRows] = await connection.query(
            `SELECT quotation_id
             FROM quotations
             WHERE branch_id = ? AND quotation_id = ?
             LIMIT 1`,
            [branch_id, normalizedQuotationId]
        );
        if (!existingRows || existingRows.length === 0) {
            return res.status(404).json({ success: false, message: "Quotation not found" });
        }

        await connection.query(
            `UPDATE quotations
             SET username = ?, firm_id = ?, modify_by = ?
             WHERE branch_id = ? AND quotation_id = ?`,
            [
                String(username).trim(),
                firm_id != null && String(firm_id).trim() !== "" ? String(firm_id).trim() : null,
                modifiedBy,
                branch_id,
                normalizedQuotationId
            ]
        );

        await connection.query(
            `DELETE FROM quotation_items
             WHERE branch_id = ? AND quotation_id = ?`,
            [branch_id, normalizedQuotationId]
        );

        for (let index = 0; index < normalizedItems.length; index++) {
            const item = normalizedItems[index];
            await connection.query(
                `INSERT INTO quotation_items (branch_id, quotation_id, service_id, create_by, modify_by, fees, tax_rate, tax_value, total)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    branch_id,
                    normalizedQuotationId,
                    item.service_id,
                    modifiedBy,
                    modifiedBy,
                    item.fees,
                    item.tax_rate,
                    item.tax_value,
                    item.total
                ]
            );
        }

        await connection.commit();

        const normalizedUsername = String(username).trim();
        const normalizedFirmId = firm_id != null && String(firm_id).trim() !== "" ? String(firm_id).trim() : null;
        const firm_data = normalizedFirmId ? await SINGLE_FIRM_DATA(normalizedFirmId) : null;
        const client_data = await USER_DATA(normalizedUsername);

        let subtotal = 0;
        let tax_total = 0;
        let grand_total = 0;
        const items = [];

        for (let index = 0; index < normalizedItems.length; index++) {
            const item = normalizedItems[index];
            const service_data = await SINGLE_SERVICE_DATA(item.service_id);
            subtotal += Number(item.fees || 0);
            tax_total += Number(item.tax_value || 0);
            grand_total += Number(item.total || 0);
            items.push({
                quotation_id: normalizedQuotationId,
                service: {
                    service_id: service_data?.service_id,
                    name: service_data?.name,
                    amount: {
                        fees: Number(item.fees || 0),
                        tax_rate: Number(item.tax_rate || 0),
                        tax_value: Number(item.tax_value || 0),
                        total: Number(item.total || 0),
                    }
                },
            });
        }

        const [quotationRows] = await connection.query(
            `SELECT create_by, modify_by, status, create_date, modify_date
             FROM quotations
             WHERE branch_id = ? AND quotation_id = ?
             LIMIT 1`,
            [branch_id, normalizedQuotationId]
        );
        const quotationRow = quotationRows?.[0] || {};
        const create_by = await USER_SNIPPED_DATA(quotationRow.create_by);
        const modify_by = await USER_SNIPPED_DATA(quotationRow.modify_by);

        return res.status(200).json({
            success: true,
            message: "Quotation updated successfully",
            data: {
                quotation_id: normalizedQuotationId,
                client: {
                    username: client_data?.username,
                    name: client_data?.name,
                    email: client_data?.email,
                    mobile: client_data?.mobile,
                    pan_number: client_data?.pan_number,
                },
                firm: {
                    firm_id: firm_data?.firm_id,
                    firm_name: firm_data?.firm_name,
                    pan_no: firm_data?.pan_no,
                    firm_type: firm_data?.firm_type,
                },
                status: quotationRow.status,
                amount: {
                    fees: Number(subtotal.toFixed(2)),
                    tax_value: Number(tax_total.toFixed(2)),
                    total: Number(grand_total.toFixed(2)),
                },
                create_date: quotationRow.create_date || null,
                modify_date: quotationRow.modify_date || null,
                create_by,
                modify_by,
                items
            }
        });
    } catch (error) {
        if (transactionStarted) {
            await connection.rollback();
        }
        console.error("Error editing quotation:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to edit quotation",
            error: error.message
        });
    } finally {
        connection.release();
    }
});

router.put("/change-status", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const modifiedBy = req.headers["username"] || "";
        const body = req.body || {};
        const { quotation_id, status } = body;

        if (!quotation_id || String(quotation_id).trim() === "") {
            return res.status(400).json({ success: false, message: "quotation_id is required" });
        }

        if (!status || String(status).trim() === "") {
            return res.status(400).json({ success: false, message: "status is required" });
        }

        const normalizedStatus = String(status).trim().toLowerCase();
        const allowedStatus = ["approved", "rejected"];
        if (!allowedStatus.includes(normalizedStatus)) {
            return res.status(400).json({
                success: false,
                message: "status must be approved or rejected",
            });
        }

        const normalizedQuotationId = String(quotation_id).trim();

        if (normalizedStatus === "approved") {
            const result = await createTaskFromQuotation({
                branch_id,
                quotation_id: normalizedQuotationId,
                createdBy: modifiedBy,
                taskPayload: body,
            });

            if (result.error) {
                return res.status(result.error.status).json({
                    success: false,
                    message: result.error.message,
                });
            }

            return res.status(200).json({
                success: true,
                message: "Quotation approved and task created successfully",
                data: result.data,
            });
        }

        const [existingRows] = await pool.query(
            `SELECT quotation_id, status
             FROM quotations
             WHERE branch_id = ? AND quotation_id = ?
             LIMIT 1`,
            [branch_id, normalizedQuotationId]
        );

        if (!existingRows || existingRows.length === 0) {
            return res.status(404).json({ success: false, message: "Quotation not found" });
        }

        const currentStatus =
            existingRows[0].status != null ? String(existingRows[0].status).trim().toLowerCase() : "";
        if (currentStatus === "approved") {
            return res.status(400).json({
                success: false,
                message: "Approved quotations cannot be rejected",
            });
        }

        await pool.query(
            `UPDATE quotations
             SET status = ?, modify_by = ?
             WHERE branch_id = ? AND quotation_id = ?`,
            [normalizedStatus, modifiedBy, branch_id, normalizedQuotationId]
        );

        const [rows] = await pool.query(
            `SELECT status, modify_date, task_id
             FROM quotations
             WHERE branch_id = ? AND quotation_id = ?
             LIMIT 1`,
            [branch_id, normalizedQuotationId]
        );
        const updated = rows?.[0] || {};

        return res.status(200).json({
            success: true,
            message: "Quotation status updated successfully",
            data: {
                quotation_id: normalizedQuotationId,
                status: updated.status || normalizedStatus,
                task_id: updated.task_id || null,
                modify_date: updated.modify_date || null,
            },
        });
    } catch (error) {
        console.error("Error changing quotation status:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to change quotation status",
            error: error.message,
        });
    }
});

router.get("/list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { page_no, limit, username, firm_id, search, status } = req.query;

        const pageNoNum = Number(page_no);
        const limitNum = Number(limit);

        if (!Number.isInteger(pageNoNum) || pageNoNum <= 0) {
            return res.status(400).json({
                success: false,
                message: "page_no is required and must be a positive integer"
            });
        }

        if (!Number.isInteger(limitNum) || limitNum <= 0) {
            return res.status(400).json({
                success: false,
                message: "limit is required and must be a positive integer"
            });
        }

        const offset = (pageNoNum - 1) * limitNum;

        let whereClause = `WHERE q.branch_id = ?`;
        const params = [branch_id];

        if (username != null && String(username).trim() !== "") {
            whereClause += " AND q.username = ?";
            params.push(String(username).trim());
        }

        if (firm_id != null && String(firm_id).trim() !== "") {
            whereClause += " AND q.firm_id = ?";
            params.push(String(firm_id).trim());
        }

        if (status != null && String(status).trim() !== "") {
            const normalizedStatus = String(status).trim().toLowerCase();
            const allowedStatus = ["pending", "approved", "rejected"];
            if (!allowedStatus.includes(normalizedStatus)) {
                return res.status(400).json({
                    success: false,
                    message: "status must be empty, pending, approved, or rejected"
                });
            }
            whereClause += " AND q.status = ?";
            params.push(normalizedStatus);
        }

        if (search != null && String(search).trim() !== "") {
            const searchPattern = `%${String(search).trim()}%`;
            whereClause += `
                AND (
                    q.quotation_id LIKE ?
                    OR q.username LIKE ?
                    OR q.firm_id LIKE ?
                    OR EXISTS (
                        SELECT 1
                        FROM firms f
                        WHERE f.branch_id = q.branch_id
                          AND f.firm_id = q.firm_id
                          AND (
                            f.firm_name LIKE ?
                            OR f.gst_no LIKE ?
                            OR f.pan_no LIKE ?
                            OR f.file_no LIKE ?
                            OR f.cin_no LIKE ?
                            OR f.vat_no LIKE ?
                            OR f.tan_no LIKE ?
                          )
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM profile p
                        JOIN clients c2 ON c2.username = p.username
                        WHERE c2.branch_id = q.branch_id
                          AND c2.username = q.username
                          AND p.status = '1'
                          AND (
                            p.name LIKE ?
                            OR p.email LIKE ?
                            OR p.mobile LIKE ?
                            OR p.pan_number LIKE ?
                          )
                    )
                )
            `;
            params.push(
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern
            );
        }

        const countQuery = `
            SELECT COUNT(*) AS total_records
            FROM quotations q
            ${whereClause}
        `;
        const [countRows] = await pool.query(countQuery, params);
        const total_records = Number(countRows?.[0]?.total_records || 0);

        let query = `
            SELECT
                q.quotation_id,
                q.username,
                q.firm_id,
                q.status,
                q.create_by,
                q.create_date,
                q.modify_by,
                q.modify_date,
                COALESCE(SUM(qi.fees), 0) AS subtotal,
                COALESCE(SUM(qi.tax_value), 0) AS tax_total,
                COALESCE(SUM(qi.total), 0) AS grand_total
            FROM quotations q
            LEFT JOIN quotation_items qi ON q.branch_id = qi.branch_id AND q.quotation_id = qi.quotation_id
            ${whereClause}
        `;

        query += `
            GROUP BY
                q.quotation_id, q.username, q.firm_id, q.status,
                q.create_by, q.create_date, q.modify_by, q.modify_date
            ORDER BY q.create_date DESC
            LIMIT ? OFFSET ?
        `;

        const [rows] = await pool.query(query, [...params, limitNum, offset]);
        const quotationList = [];

        for (let index = 0; index < rows.length; index++) {
            const row = rows[index];
            const create_by = await USER_SNIPPED_DATA(row.create_by);
            const modify_by = await USER_SNIPPED_DATA(row.modify_by);

            const [itemRows] = await pool.query(
                `SELECT quotation_id, service_id, fees, tax_rate, tax_value, total, create_date
                 FROM quotation_items
                 WHERE branch_id = ? AND quotation_id = ?
                 ORDER BY id ASC`,
                [branch_id, row.quotation_id]
            );

            const firm_data = await SINGLE_FIRM_DATA(row.firm_id);
            const client_data = await USER_DATA(row.username);

            const items = [];
            for (let index = 0; index < itemRows.length; index++) {
                const item = itemRows[index];
                const service_data = await SINGLE_SERVICE_DATA(item.service_id);
                items.push({
                    quotation_id: item.quotation_id,
                    service: {
                        service_id: service_data?.service_id,
                        name: service_data?.name,
                        amount: {
                            fees: Number(item.fees || 0),
                            tax_rate: Number(item.tax_rate || 0),
                            tax_value: Number(item.tax_value || 0),
                            total: Number(item.total || 0),
                        }
                    },
                });
            }

            quotationList.push({
                quotation_id: row.quotation_id,
                client: {
                    username: client_data?.username,
                    name: client_data?.name,
                    email: client_data?.email,
                    mobile: client_data?.mobile,
                    pan_number: client_data?.pan_number,
                },
                firm: {
                    firm_id: firm_data?.firm_id,
                    firm_name: firm_data?.firm_name,
                    pan_no: firm_data?.pan_no,
                    firm_type: firm_data?.firm_type,
                },
                status: row.status,
                amount: {
                    fees: Number(row.subtotal || 0),
                    tax_value: Number(row.tax_total || 0),
                    total: Number(row.grand_total || 0),
                },
                create_date: row.create_date,
                modify_date: row.modify_date,
                create_by,
                modify_by,
                items
            });
        }

        return res.status(200).json({
            success: true,
            message: "Quotations list retrieved successfully",
            data: quotationList,
            page_no: pageNoNum,
            limit: limitNum,
            total_records,
            total_pages: Math.ceil(total_records / limitNum)
        });
    } catch (error) {
        console.error("Error fetching quotations list:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch quotations list",
            error: error.message
        });
    }
});

router.post("/download", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { quotation_id } = req.body || {};

        if (!quotation_id || String(quotation_id).trim() === "") {
            return res.status(400).json({ success: false, message: "quotation_id is required" });
        }

        const qid = String(quotation_id).trim();

        const [qrows] = await pool.query(
            `SELECT quotation_id, username, firm_id, status, create_date, modify_date
             FROM quotations
             WHERE branch_id = ? AND quotation_id = ?
             LIMIT 1`,
            [branch_id, qid]
        );

        if (!qrows || qrows.length === 0) {
            return res.status(404).json({ success: false, message: "Quotation not found" });
        }

        const qrow = qrows[0];

        const [itemRows] = await pool.query(
            `SELECT service_id, fees, tax_rate, tax_value, total
             FROM quotation_items
             WHERE branch_id = ? AND quotation_id = ?
             ORDER BY id ASC`,
            [branch_id, qid]
        );

        let issuerCompany = null;
        try {
            const [branchRows] = await pool.query(
                `SELECT name, address_line_1, address_line_2, city, state, country, pincode,
                        gst, pan, mobile_1, mobile_2, email_1, email_2
                 FROM branch_list
                 WHERE branch_id = ? AND (is_deleted = '0' OR is_deleted = 0)
                 LIMIT 1`,
                [branch_id]
            );
            issuerCompany = branchRows?.[0] || null;
        } catch {
            const [branchRows] = await pool.query(
                `SELECT name, address_line_1, address_line_2, city, state, country, pincode,
                        gst, pan, mobile_1, mobile_2, email_1, email_2
                 FROM branch_list
                 WHERE branch_id = ?
                 LIMIT 1`,
                [branch_id]
            );
            issuerCompany = branchRows?.[0] || null;
        }

        const client = await USER_DATA(String(qrow.username || "").trim());
        const firmId = qrow.firm_id != null && String(qrow.firm_id).trim() !== "" ? String(qrow.firm_id).trim() : null;
        const firmRaw = firmId ? await SINGLE_FIRM_DATA(firmId) : null;
        const clientFirm = firmRaw && (firmRaw.firm_name || firmRaw.firm_id) ? firmRaw : null;

        const lineItems = [];
        let subtotalFees = 0;
        let taxTotal = 0;
        let grandTotal = 0;

        for (let i = 0; i < itemRows.length; i++) {
            const item = itemRows[i];
            const service_data = await SINGLE_SERVICE_DATA(item.service_id);
            const fees = Number(item.fees || 0);
            const tv = Number(item.tax_value || 0);
            const tot = Number(item.total || 0);
            subtotalFees += fees;
            taxTotal += tv;
            grandTotal += tot;
            lineItems.push({
                description: service_data?.name || String(item.service_id || "Service"),
                fees,
                tax_rate: Number(item.tax_rate || 0),
                tax_value: tv,
                total: tot,
            });
        }

        const buffer = await buildQuotationPdfBuffer({
            issuerCompany,
            quotation: {
                quotation_id: qrow.quotation_id,
                status: qrow.status,
                create_date: qrow.create_date,
            },
            client,
            clientFirm,
            lineItems,
            totals: {
                subtotalFees: Number(subtotalFees.toFixed(2)),
                taxTotal: Number(taxTotal.toFixed(2)),
                grandTotal: Number(grandTotal.toFixed(2)),
            },
        });

        await fs.mkdir(QUOTATION_PDF_DIR, { recursive: true });
        const safeBase = qid.replace(/[^a-zA-Z0-9._-]/g, "_");
        const filename = `${safeBase}.pdf`;
        const filePath = path.join(QUOTATION_PDF_DIR, filename);
        await fs.writeFile(filePath, buffer);

        const url = `${BASE_DOMAIN}/media/quotation/${filename}`;

        return res.status(200).json({
            success: true,
            message: "Quotation PDF generated successfully",
            data: {
                quotation_id: qid,
                filename,
                url,
            },
        });
    } catch (error) {
        console.error("Error generating quotation PDF:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to generate quotation PDF",
            error: error.message,
        });
    }
});

export default router;
