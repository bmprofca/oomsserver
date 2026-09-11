import express from "express";
import pool from "../db.js";
import {
    ALLOWED_GENERATE_TYPES,
    buildInvoicePdfBuffer,
    normInvoiceType,
    saveInvoicePdfLink,
} from "../services/invoiceGenerateService.js";
import { validateCaSession } from "../middleware/validateCaSession.js";
import {
    collectLedgerStatement,
    generateLedgerPdfBuffer,
} from "../helpers/ledgerReport.js";
import { buildLedgerDownloadFilename } from "../helpers/ledgerFilename.js";
import { USER_SNIPPED_DATA } from "../helpers/function.js";
import { formatPurchaseParticularsText } from "../helpers/purchaseParticulars.js";
import { formatCompliancePeriodLabel } from "../helpers/compliancePeriodLabel.js";
import { isSupportedGenerateType } from "../helpers/invoiceFormatMapping.js";

const router = express.Router();

const PARTY_TYPE = "ca";

async function getOppositePartySnippet(branch_id, party_type, party_id) {
    if (!party_type || !party_id) return {};
    const type = String(party_type).trim();
    const id = String(party_id).trim();

    // Staff-compatible: client (and ca/agent profile parties) use key `client` so
    // details = bank || client works with getParticularsDisplay.
    if (type === "client" || type === "ca" || type === "agent") {
        const [rows] = await pool.query(
            `SELECT p.name, c.username
             FROM clients c
             LEFT JOIN profile p ON p.username = c.username
                AND p.id = (SELECT MAX(p2.id) FROM profile p2 WHERE p2.username = c.username)
             WHERE c.username = ? AND c.branch_id = ? AND c.is_deleted = '0'
             LIMIT 1`,
            [id, branch_id]
        );
        const r = rows?.[0];
        if (!r) return {};
        const profileSnippet = {
            username: r.username,
            name: r.name ?? null,
        };
        // Always expose under `client` for staff TransactionTable compatibility;
        // also keep type-keyed entry for CA list details fallback.
        if (type === "client") {
            return { client: profileSnippet };
        }
        return {
            client: profileSnippet,
            [type]: profileSnippet,
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
                bank_id: r.bank_id,
                bank: r.bank ?? null,
                account_no: r.account_no ?? null,
                holder: r.holder ?? null,
                ifsc: r.ifsc ?? null,
                branch: r.branch ?? null,
                type: r.type ?? null,
            },
        };
    }

    if (type === "branch" || type === "company") {
        const [rows] = await pool.query(
            "SELECT branch_id, name FROM branch_list WHERE branch_id = ? LIMIT 1",
            [id]
        );
        const r = rows?.[0];
        if (!r) return {};
    return {
            branch: {
                branch_id: r.branch_id,
                name: r.name ?? null,
            },
        };
    }

    return {};
}

router.get("/list", validateCaSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.ca_username;
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

        const listSql = `
            SELECT
                id,
                transaction_id,
                create_date,
                create_by,
                modify_date,
                modify_by,
                transaction_date,
                transaction_type,
                amount,
                invoice_id,
                invoice_no,
                party1_type,
                party1_id,
                party2_type,
                party2_id,
                remark
            FROM transactions
            WHERE ${partyFilter}
              AND transaction_date >= ?
              AND transaction_date <= ?
            ORDER BY transaction_date ASC, id ASC
        `;
        const [rows] = await pool.query(listSql, [...partyParams, fromDate, toDate]);

        const oppositeKeys = new Set();
        for (const row of rows) {
            const isParty2 = row.party2_type === PARTY_TYPE && String(row.party2_id) === username;
            const oppType = isParty2 ? row.party1_type : row.party2_type;
            const oppId = isParty2 ? row.party1_id : row.party2_id;
            if (oppType && oppId) oppositeKeys.add(`${oppType}|${oppId}`);
        }

        const oppositeCache = new Map();
        await Promise.all(
            [...oppositeKeys].map(async (key) => {
                const [oppType, oppId] = key.split("|");
                oppositeCache.set(key, await getOppositePartySnippet(branch_id, oppType, oppId));
            })
        );

        let runningBalance = balanceBefore;
        const fullList = [];
        for (const row of rows) {
            const amount = Math.abs(Number(row.amount) || 0);
            const isParty1 = row.party1_type === PARTY_TYPE && String(row.party1_id) === username;
            const isParty2 = row.party2_type === PARTY_TYPE && String(row.party2_id) === username;
            // Staff ledger rule: party1 => credit, party2 => debit
            let rowDebit = 0;
            let rowCredit = 0;
            if (isParty2) rowDebit = amount;
            if (isParty1) rowCredit = amount;
            runningBalance = runningBalance + (rowDebit - rowCredit);

            const oppType = isParty2 ? row.party1_type : row.party2_type;
            const oppId = isParty2 ? row.party1_id : row.party2_id;
            const hasOpposite = Boolean(oppType && oppId);
            const snippet = hasOpposite ? oppositeCache.get(`${oppType}|${oppId}`) || {} : {};
            const details =
                snippet.bank ||
                snippet.client ||
                snippet.ca ||
                snippet.agent ||
                snippet.branch ||
                {};
            const particular = hasOpposite
                ? { type: oppType, details, remark: row.remark ?? null }
                : { remark: row.remark ?? null };

            const create_by = await USER_SNIPPED_DATA(row.create_by);
            const modify_by = await USER_SNIPPED_DATA(row.modify_by);
            let saleIsTask = false;

            if (row.transaction_type === "sale") {
                const [saleRows] = await pool.query(
                    "SELECT services.name, sale_items.fees, sale_items.total, sale_items.remark FROM `sale_items` JOIN `services` ON `sale_items`.`service_id` = `services`.`service_id` WHERE `sale_items`.`branch_id` = ? AND `sale_items`.`invoice_id` = ? ORDER BY `sale_items`.`id` ASC",
                    [branch_id, row.invoice_id]
                );
                const sale_items = saleRows.map((item) => ({
                    name: item.name,
                    fees: Number(item.fees),
                    tax_rate: 0,
                    tax_value: 0,
                    total: Number(item.total),
                    remark: item.remark ?? null,
                }));
                particular.sale_items = sale_items;

                // Prefer linked firm (client sale) for ledger Particulars when present
                try {
                    const [firmLinkRows] = await pool.query(
                        `SELECT se.firm_id, se.is_task, f.firm_name, f.firm_type, f.gst_no, f.pan_no
                         FROM sale_entries se
                         LEFT JOIN firms f
                           ON f.firm_id = se.firm_id
                          AND CAST(f.branch_id AS CHAR) = CAST(se.branch_id AS CHAR)
                          AND (f.is_deleted = '0' OR f.is_deleted = 0)
                         WHERE CAST(se.branch_id AS CHAR) = CAST(? AS CHAR)
                           AND se.invoice_id = ?
                         LIMIT 1`,
                        [branch_id, row.invoice_id]
                    );
                    const firmLink = firmLinkRows?.[0];
                    saleIsTask = firmLink?.is_task === "1" || firmLink?.is_task === 1;
                    const firmId =
                        firmLink?.firm_id != null && String(firmLink.firm_id).trim() !== ""
                            ? String(firmLink.firm_id).trim()
                            : null;
                    if (firmId) {
                        particular.firm_id = firmId;
                        particular.firm = {
                            firm_id: firmId,
                            firm_name: firmLink.firm_name ?? null,
                            firm_type: firmLink.firm_type ?? null,
                            gst_no: firmLink.gst_no ?? null,
                            pan_no: firmLink.pan_no ?? null,
                        };
                    }
                } catch (_) {
                    // keep sale_items-only particular if firm lookup fails
                }

                // Compliance period for task-billed sales (same label as task table)
                try {
                    let taskRow = null;
                    const [taskByInvoice] = await pool.query(
                        `SELECT t.task_id, t.task_type, t.compliance_period, t.compliance_year,
                                t.is_recurring, s.frequency
                         FROM tasks t
                         LEFT JOIN services s
                           ON s.service_id = t.service_id
                         WHERE CAST(t.branch_id AS CHAR) = CAST(? AS CHAR)
                           AND t.invoice_id = ?
                         LIMIT 1`,
                        [branch_id, row.invoice_id]
                    );
                    taskRow = taskByInvoice?.[0] || null;

                    if (!taskRow) {
                        let taskIdFromRemark = null;
                        for (const item of sale_items) {
                            const itemRemark =
                                item?.remark != null ? String(item.remark).trim() : "";
                            if (/^task:/i.test(itemRemark)) {
                                const tid = itemRemark.replace(/^task:/i, "").trim();
                                if (tid) {
                                    taskIdFromRemark = tid;
                                    break;
                                }
                            }
                        }
                        if (taskIdFromRemark) {
                            const [taskById] = await pool.query(
                                `SELECT t.task_id, t.task_type, t.compliance_period, t.compliance_year,
                                        t.is_recurring, s.frequency
                                 FROM tasks t
                                 LEFT JOIN services s
                                   ON s.service_id = t.service_id
                                 WHERE CAST(t.branch_id AS CHAR) = CAST(? AS CHAR)
                                   AND t.task_id = ?
                                 LIMIT 1`,
                                [branch_id, taskIdFromRemark]
                            );
                            taskRow = taskById?.[0] || null;
                        }
                    }

                    if (taskRow?.task_id) {
                        particular.task_id = String(taskRow.task_id).trim();
                        particular.task_type = taskRow.task_type ?? null;
                        saleIsTask = true;
                        const periodLabel = formatCompliancePeriodLabel({
                            task_type: taskRow.task_type,
                            is_recurring: taskRow.is_recurring,
                            compliance_period: taskRow.compliance_period,
                            compliance_year: taskRow.compliance_year,
                            frequency: taskRow.frequency,
                        });
                        if (periodLabel) {
                            particular.compliance_period_label = periodLabel;
                        }
                    }
                } catch (_) {
                    // optional — leave sale particulars without period
                }
            }

            const saleTaskId = particular.task_id || null;
            const isTaskSale =
                row.transaction_type === "sale" && (saleIsTask || Boolean(saleTaskId));

            if (row.transaction_type === "purchase") {
                try {
                    const [purchaseRows] = await pool.query(
                        `SELECT services.name, purchase_items.amount, purchase_items.remark
                         FROM purchase_items
                         JOIN services ON purchase_items.service_id = services.service_id
                         WHERE CAST(purchase_items.branch_id AS CHAR) = CAST(? AS CHAR)
                           AND purchase_items.invoice_id = ?
                         ORDER BY purchase_items.id ASC`,
                        [branch_id, row.invoice_id]
                    );
                    particular.purchase_items = (purchaseRows || []).map((item) => ({
                        name: item.name,
                        fees: Number(item.amount) || 0,
                        tax_rate: 0,
                        tax_value: 0,
                        total: Number(item.amount) || 0,
                        remark: item.remark ?? null,
                    }));
                } catch (_) {
                    particular.purchase_items = [];
                }
                try {
                    const [peRows] = await pool.query(
                        `SELECT pe.task_id, f.firm_name
                         FROM purchase_entries pe
                         LEFT JOIN tasks t
                           ON t.task_id = pe.task_id
                          AND CAST(t.branch_id AS CHAR) = CAST(pe.branch_id AS CHAR)
                         LEFT JOIN firms f
                           ON f.firm_id = t.firm_id
                          AND CAST(f.branch_id AS CHAR) = CAST(t.branch_id AS CHAR)
                          AND (f.is_deleted = '0' OR f.is_deleted = 0)
                         WHERE CAST(pe.branch_id AS CHAR) = CAST(? AS CHAR)
                           AND pe.invoice_id = ?
                         LIMIT 1`,
                        [branch_id, row.invoice_id]
                    );
                    const tid =
                        peRows?.[0]?.task_id != null && String(peRows[0].task_id).trim() !== ""
                            ? String(peRows[0].task_id).trim()
                            : null;
                    const firmName =
                        peRows?.[0]?.firm_name != null && String(peRows[0].firm_name).trim() !== ""
                            ? String(peRows[0].firm_name).trim()
                            : null;
                    if (tid) particular.task_id = tid;
                    if (firmName) particular.firm_name = firmName;

                    const serviceNames = (particular.purchase_items || [])
                        .map((it) => (it?.name != null ? String(it.name).trim() : ""))
                        .filter(Boolean);
                    const partyLabel =
                        particular?.details?.name ||
                        particular?.details?.holder ||
                        particular?.details?.bank ||
                        "";
                    particular.summary = formatPurchaseParticularsText({
                        firmName,
                        partyName: firmName ? null : partyLabel,
                        serviceNames,
                        isTask: Boolean(tid),
                    });
                } catch (_) {
                    // optional
                }
            }

            const payment = {
                debit: rowDebit,
                credit: rowCredit,
                balance: Number(runningBalance.toFixed(2)),
            };
            const txType = String(row.transaction_type || "").toLowerCase();
            const item = {
                transaction_id: row.transaction_id,
                create_date: row.create_date,
                modify_date: row.modify_date,
                transaction_date: row.transaction_date,
                transaction_type: row.transaction_type,
                payment,
                invoice_id: row.invoice_id,
                invoice_no: row.invoice_no,
                downloadable: Boolean(
                    row.invoice_id && isSupportedGenerateType(row.transaction_type)
                ),
                is_task: Boolean(isTaskSale),
                task_id: saleTaskId,
                create_by,
                modify_by,
                particular,
            };
            // Staff TransactionTable also reads type-keyed amounts
            if (txType) {
                item[txType] = payment;
            }
            fullList.push(item);
        }

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
            // Staff CLIENT CAComponents also reads meta
            meta: {
                page_no: pageNum,
                limit: limitNum,
                total,
                count: data.length,
                is_last_page: offset + data.length >= total,
            },
        });
    } catch (error) {
        console.error("CA TRANSACTION LIST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch transaction ledger",
        });
    }
});

router.post("/generate-invoice", validateCaSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.ca_username;
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
        console.error("CA INVOICE GENERATE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to generate invoice",
        });
    }
});

router.get("/download/ledger", validateCaSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.ca_username;
        const { from_date, to_date, format = "pdf" } = req.query || {};

        if (!from_date || String(from_date).trim() === "") {
            return res.status(400).json({ success: false, message: "from_date is required" });
        }
        if (!to_date || String(to_date).trim() === "") {
            return res.status(400).json({ success: false, message: "to_date is required" });
        }

        const fromDate = String(from_date).trim();
        const toDate = String(to_date).trim();

        const ledger = await collectLedgerStatement({
            branch_id,
            partyType: PARTY_TYPE,
            partyId: username,
            fromDate,
            toDate,
            getOppositePartySnippet,
        });

        const {
            partyDetails,
            openingDebit,
            openingCredit,
            openingBalance,
            statementData,
            summary,
        } = ledger;

        const filenameBase = buildLedgerDownloadFilename({
            name: partyDetails?.name || username,
            fromDate,
            toDate,
            extension: "pdf",
        }).replace(/\.PDF$/i, "");

        if (String(format).toLowerCase() !== "pdf") {
            return res.status(400).json({
                success: false,
                message: "Only PDF format is supported for CA ledger download",
            });
        }

        const pdfBuffer = await generateLedgerPdfBuffer({
            partyDetails,
            branchDetails: ledger.branchDetails,
            fromDate,
            toDate,
            openingDebit,
            openingCredit,
            openingBalance,
            statementData,
            summary,
        });

        const pdfFilename = `${filenameBase}.PDF`;
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${pdfFilename}"`);
        res.setHeader("Cache-Control", "no-cache");
        return res.send(pdfBuffer);
    } catch (error) {
        console.error("CA LEDGER DOWNLOAD ERROR:", error);
        if (!res.headersSent) {
            return res.status(500).json({
                success: false,
                message: "Failed to generate ledger statement",
            });
        }
    }
});

export default router;
