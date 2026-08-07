import PDFDocument from "pdfkit";
import pool from "../db.js";

function formatCurrency(amount, { signed = false } = {}) {
    const n = Number(amount) || 0;
    const formatted = Math.abs(n)
        .toFixed(2)
        .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    if (signed && n < 0) return `-${formatted}`;
    return formatted;
}

function pad2(n) {
    return String(n).padStart(2, "0");
}

/** DD-MM-YY */
function formatDateForDisplay(date) {
    if (!date) return "-";
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) {
        const s = String(date);
        const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m) return `${m[3]}-${m[2]}-${m[1].slice(-2)}`;
        return s.slice(0, 10);
    }
    return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${String(d.getFullYear()).slice(-2)}`;
}

function formatDateForReport(date) {
    return formatDateForDisplay(date);
}

function formatTypeLabel(type) {
    return String(type || "N/A")
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildBranchAddress(branch) {
    if (!branch) return "";
    const lines = [
        [branch.address_line_1, branch.address_line_2].filter(Boolean).join(", "),
        [branch.city, branch.state, branch.pincode].filter(Boolean).join(", "),
    ].filter(Boolean);
    return lines.join("\n");
}

function buildBranchContacts(branch) {
    if (!branch) return "";
    const phones = [branch.mobile_1, branch.mobile_2].filter(Boolean);
    const emails = [branch.email_1, branch.email_2].filter(Boolean);
    const parts = [];
    if (phones.length) parts.push(`Phone: ${phones.join(" / ")}`);
    if (emails.length) parts.push(`Email: ${emails.join(" / ")}`);
    return parts.join("\n");
}

/**
 * Collect ledger statement rows matching /transaction/list debit-credit logic.
 * `getOppositePartySnippet` is injected from transactions route to avoid circular imports.
 */
export async function collectLedgerStatement({
    branch_id,
    partyType,
    partyId,
    fromDate,
    toDate,
    getOppositePartySnippet,
}) {
    let partyDetails = {
        name: partyId,
        type: partyType === "client" ? "Client" : partyType === "bank" ? "Bank" : "Party",
        id: partyId,
    };

    let branchDetails = null;
    try {
        const [branchRows] = await pool.query(
            `SELECT name, legal_name, address_line_1, address_line_2, city, state, country,
                    pincode, mobile_1, mobile_2, email_1, email_2, gst, pan
             FROM branch_list
             WHERE branch_id = ? AND (is_deleted = '0' OR is_deleted = 0)
             LIMIT 1`,
            [branch_id]
        );
        if (branchRows[0]) branchDetails = branchRows[0];
    } catch (_) {
        branchDetails = null;
    }

    if (partyType === "client") {
        const [rows] = await pool.query(
            `SELECT p.name, p.email, p.mobile, p.pan_number, c.username
             FROM clients c
             LEFT JOIN profile p ON p.username = c.username
               AND p.id = (SELECT MAX(p2.id) FROM profile p2 WHERE p2.username = c.username)
             WHERE c.username = ? AND c.branch_id = ? AND c.is_deleted = '0'
             LIMIT 1`,
            [partyId, branch_id]
        );
        if (rows[0]) {
            partyDetails = {
                name: rows[0].name || rows[0].username,
                email: rows[0].email,
                mobile: rows[0].mobile,
                pan: rows[0].pan_number || null,
                type: "Client",
                id: rows[0].username,
            };
        }
    } else if (partyType === "bank") {
        const [rows] = await pool.query(
            `SELECT bank_id, account_no, holder, ifsc, bank, branch, type
             FROM banks
             WHERE branch_id = ? AND bank_id = ?
             LIMIT 1`,
            [branch_id, partyId]
        );
        if (rows[0]) {
            partyDetails = {
                name: rows[0].holder || rows[0].bank,
                account_no: rows[0].account_no,
                ifsc: rows[0].ifsc,
                bank: rows[0].bank,
                type: "Bank",
                id: rows[0].bank_id,
            };
        }
    }

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
        FROM \`transactions\`
        WHERE \`branch_id\` = ?
          AND (\`party1_type\` = ? AND \`party1_id\` = ? OR \`party2_type\` = ? AND \`party2_id\` = ?)
          AND \`transaction_date\` < ?`,
        [
            partyType,
            partyId,
            partyType,
            partyId,
            partyType,
            partyId,
            branch_id,
            partyType,
            partyId,
            partyType,
            partyId,
            fromDate,
        ]
    );

    const balanceBefore =
        (Number(openingRow?.debit ?? 0) || 0) - (Number(openingRow?.credit ?? 0) || 0);
    const openingDebit = balanceBefore >= 0 ? balanceBefore : 0;
    const openingCredit = balanceBefore < 0 ? Math.abs(balanceBefore) : 0;

    const [transactions] = await pool.query(
        `SELECT transaction_id, transaction_date, transaction_type, amount,
                invoice_id, invoice_no, party1_type, party1_id, party2_type, party2_id, remark
         FROM \`transactions\`
         WHERE branch_id = ?
           AND (party1_type = ? AND party1_id = ? OR party2_type = ? AND party2_id = ?)
           AND transaction_date >= ?
           AND transaction_date <= ?
         ORDER BY transaction_date ASC, id ASC`,
        [branch_id, partyType, partyId, partyType, partyId, fromDate, toDate]
    );

    // Sale rows store party1 as type "sale" (invoice id) — resolve firm name for Particulars
    const saleInvoiceIds = [
        ...new Set(
            transactions
                .filter((r) => String(r.transaction_type || "").toLowerCase() === "sale" && r.invoice_id)
                .map((r) => String(r.invoice_id).trim())
                .filter(Boolean)
        ),
    ];
    const saleFirmByInvoiceId = new Map();
    if (saleInvoiceIds.length > 0) {
        const ph = saleInvoiceIds.map(() => "?").join(", ");
        try {
            const [firmRows] = await pool.query(
                `SELECT se.invoice_id, se.firm_id, f.firm_name
                 FROM sale_entries se
                 LEFT JOIN firms f
                   ON f.firm_id = se.firm_id
                  AND CAST(f.branch_id AS CHAR) = CAST(se.branch_id AS CHAR)
                  AND (f.is_deleted = '0' OR f.is_deleted = 0)
                 WHERE CAST(se.branch_id AS CHAR) = CAST(? AS CHAR)
                   AND se.invoice_id IN (${ph})`,
                [branch_id, ...saleInvoiceIds]
            );
            for (const fr of firmRows || []) {
                const inv = fr?.invoice_id != null ? String(fr.invoice_id).trim() : "";
                if (!inv) continue;
                const name = fr?.firm_name != null ? String(fr.firm_name).trim() : "";
                if (name) saleFirmByInvoiceId.set(inv, name);
            }
        } catch (_) {
            // leave map empty; particular falls back below
        }
    }

    // Also batch sale service names (comma-joined) as primary Particulars label
    const saleServiceByInvoiceId = new Map();
    if (saleInvoiceIds.length > 0) {
        const ph = saleInvoiceIds.map(() => "?").join(", ");
        try {
            const [svcRows] = await pool.query(
                `SELECT si.invoice_id, s.name
                 FROM sale_items si
                 JOIN services s ON s.service_id = si.service_id
                 WHERE CAST(si.branch_id AS CHAR) = CAST(? AS CHAR)
                   AND si.invoice_id IN (${ph})
                 ORDER BY si.id ASC`,
                [branch_id, ...saleInvoiceIds]
            );
            for (const sr of svcRows || []) {
                const inv = sr?.invoice_id != null ? String(sr.invoice_id).trim() : "";
                if (!inv) continue;
                const name = sr?.name != null ? String(sr.name).trim() : "";
                if (!name) continue;
                const existing = saleServiceByInvoiceId.get(inv);
                if (existing) {
                    saleServiceByInvoiceId.set(inv, `${existing}, ${name}`);
                } else {
                    saleServiceByInvoiceId.set(inv, name);
                }
            }
        } catch (_) {
            // optional fallback
        }
    }

    const oppositeKeys = new Set();
    for (const row of transactions) {
        const isParty2 = row.party2_type === partyType && String(row.party2_id) === partyId;
        const oppType = isParty2 ? row.party1_type : row.party2_type;
        const oppId = isParty2 ? row.party1_id : row.party2_id;
        if (oppType && oppId) oppositeKeys.add(`${oppType}|${oppId}`);
    }

    const oppositeCache = new Map();
    if (typeof getOppositePartySnippet === "function") {
        await Promise.all(
            [...oppositeKeys].map(async (key) => {
                const [oppType, oppId] = key.split("|");
                const snippet = await getOppositePartySnippet(branch_id, oppType, oppId);
                oppositeCache.set(key, snippet);
            })
        );
    }

    let runningBalance = balanceBefore;
    const statementData = [];
    let totalDebit = openingDebit;
    let totalCredit = openingCredit;

    for (const row of transactions) {
        const amount = Math.abs(Number(row.amount) || 0);
        const isParty1 = row.party1_type === partyType && String(row.party1_id) === partyId;
        const isParty2 = row.party2_type === partyType && String(row.party2_id) === partyId;

        let rowDebit = 0;
        let rowCredit = 0;
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
        totalDebit += rowDebit;
        totalCredit += rowCredit;

        const oppType = isParty2 ? row.party1_type : row.party2_type;
        const oppId = isParty2 ? row.party1_id : row.party2_id;
        const hasOppositeParty = oppType && oppId;
        const oppKey = hasOppositeParty ? `${oppType}|${oppId}` : null;
        const oppositeSnippet = oppKey ? oppositeCache.get(oppKey) || {} : {};
        const details = oppositeSnippet.bank || oppositeSnippet.client || {};

        let particular = "";
        let particularSub = "";
        let particularRemark = "";
        const isSale = String(row.transaction_type || "").toLowerCase() === "sale";
        if (isSale) {
            const inv = row.invoice_id != null ? String(row.invoice_id).trim() : "";
            particular = (inv && saleServiceByInvoiceId.get(inv)) || "";
            particularSub = (inv && saleFirmByInvoiceId.get(inv)) || "";
            if (!particular && particularSub) {
                particular = particularSub;
                particularSub = "";
            }
            if (row.remark) particularRemark = String(row.remark).trim();
        } else if (hasOppositeParty) {
            if (oppType === "client") {
                particular = details.name || details.username || "";
            } else if (oppType === "bank") {
                particular = details.holder || details.bank || "";
            }
        }
        if (!isSale && row.remark) {
            particular = particular
                ? `${particular}\n${row.remark}`
                : row.remark;
        }
        if (!particular) particular = particularRemark || "-";

        statementData.push({
            date: row.transaction_date,
            particular,
            particular_sub: particularSub || "",
            particular_remark: particularRemark || "",
            type: row.transaction_type || "",
            invoice_no: row.invoice_no || "N/A",
            debit: rowDebit,
            credit: rowCredit,
            balance: runningBalance,
        });
    }

    return {
        partyDetails,
        branchDetails,
        openingDebit,
        openingCredit,
        openingBalance: balanceBefore,
        statementData,
        summary: {
            totalDebit,
            totalCredit,
            closingBalance: runningBalance,
        },
        fromDate,
        toDate,
    };
}

/**
 * PDF table columns match Client Ledger UI:
 * # | Date | Particulars | Type | Voucher | Debit | Credit | Balance
 */
export function generateLedgerPdfBuffer({
    partyDetails,
    branchDetails,
    fromDate,
    toDate,
    openingDebit,
    openingCredit,
    openingBalance,
    statementData,
    summary,
}) {
    return new Promise((resolve, reject) => {
        try {
            const margin = 40;
            const footerReserve = 48;
            const cellPadX = 4;
            const cellPadY = 6;
            const stripeColor = "#f1f5f9";
            const borderColor = "#94a3b8";
            const doc = new PDFDocument({
                margin,
                size: "A4",
                layout: "portrait",
                bufferPages: true,
                autoFirstPage: true,
                info: {
                    Title: `Ledger Statement - ${partyDetails?.name || "Account"}`,
                    Author: "OOMS",
                    Subject: "Ledger Statement",
                },
            });

            const chunks = [];
            doc.on("data", (chunk) => chunks.push(chunk));
            doc.on("end", () => resolve(Buffer.concat(chunks)));
            doc.on("error", reject);

            const pageWidth = doc.page.width - margin * 2;
            const startX = margin;
            const contentBottom = () => doc.page.height - footerReserve;

            // Portrait column layout (A4 ~515pt usable width)
            const cols = {
                serial: { x: startX, width: 28, label: "#", align: "left" },
                date: { x: startX + 28, width: 52, label: "Date", align: "left" },
                particular: { x: startX + 80, width: 136, label: "Particulars", align: "left" },
                type: { x: startX + 216, width: 58, label: "Type", align: "left" },
                voucher: { x: startX + 274, width: 62, label: "Voucher", align: "left" },
                debit: { x: startX + 336, width: 58, label: "Debit", align: "right" },
                credit: { x: startX + 394, width: 58, label: "Credit", align: "right" },
                balance: { x: startX + 452, width: 63, label: "Balance", align: "right" },
            };
            const colList = Object.values(cols);
            const tableWidth = pageWidth;
            const minRowH = 22;
            const headerH = 26;
            const bodyFontSize = 10;
            const headerFontSize = 10;
            let tableTopY = null;

            const textOpts = (col, extra = {}) => ({
                width: Math.max(8, col.width - cellPadX * 2),
                align: col.align,
                lineGap: 1,
                ...extra,
            });

            const textX = (col) => col.x + cellPadX;

            const measureH = (text, col, font = "Helvetica", size = bodyFontSize) => {
                doc.font(font).fontSize(size);
                return doc.heightOfString(String(text ?? ""), textOpts(col));
            };

            const drawOuterBorder = (topY, bottomY) => {
                doc.rect(startX, topY, tableWidth, bottomY - topY)
                    .strokeColor(borderColor)
                    .lineWidth(1)
                    .stroke();
                colList.slice(0, -1).forEach((col) => {
                    const vx = col.x + col.width;
                    doc.moveTo(vx, topY)
                        .lineTo(vx, bottomY)
                        .strokeColor(borderColor)
                        .lineWidth(0.6)
                        .stroke();
                });
                doc.lineWidth(1);
            };

            const drawRowChrome = (rowTop, rowHeight, { stripe = false } = {}) => {
                if (stripe) {
                    doc.save();
                    doc.rect(startX, rowTop, tableWidth, rowHeight).fill(stripeColor);
                    doc.restore();
                }
                doc.moveTo(startX, rowTop + rowHeight)
                    .lineTo(startX + tableWidth, rowTop + rowHeight)
                    .strokeColor(borderColor)
                    .lineWidth(0.6)
                    .stroke();
                doc.lineWidth(1);
            };

            const drawHeader = (y) => {
                if (tableTopY == null) tableTopY = y;
                doc.save();
                doc.rect(startX, y, tableWidth, headerH).fill("#e2e8f0");
                doc.restore();
                doc.fillColor("#0f766e")
                    .font("Helvetica-Bold")
                    .fontSize(headerFontSize);
                colList.forEach((col) => {
                    doc.text(col.label, textX(col), y + 8, {
                        ...textOpts(col),
                        lineBreak: false,
                    });
                });
                doc.moveTo(startX, y + headerH)
                    .lineTo(startX + tableWidth, y + headerH)
                    .strokeColor("#0f766e")
                    .lineWidth(1)
                    .stroke();
                doc.lineWidth(1);
                return y + headerH;
            };

            const ensureSpace = (y, needed = minRowH) => {
                if (y + needed <= contentBottom()) return y;
                if (tableTopY != null) {
                    drawOuterBorder(tableTopY, y);
                }
                doc.addPage();
                tableTopY = margin;
                return drawHeader(margin);
            };

            let y = margin;
            const halfW = (tableWidth - 16) / 2;
            const rightX = startX + halfW + 16;
            const headerStartY = y;

            // —— Left: branch · Right: client ——
            const branchName =
                branchDetails?.name || branchDetails?.legal_name || "Branch";
            doc.font("Helvetica-Bold")
                .fontSize(13)
                .fillColor("#0f172a")
                .text(branchName, startX, headerStartY, { width: halfW });

            let leftY = doc.y + 2;
            if (branchDetails?.legal_name && branchDetails.legal_name !== branchName) {
                doc.font("Helvetica")
                    .fontSize(8)
                    .fillColor("#64748b")
                    .text(branchDetails.legal_name, startX, leftY, { width: halfW });
                leftY = doc.y + 2;
            }
            const addressBlock = buildBranchAddress(branchDetails);
            if (addressBlock) {
                doc.font("Helvetica")
                    .fontSize(8)
                    .fillColor("#475569")
                    .text(addressBlock, startX, leftY, { width: halfW });
                leftY = doc.y + 2;
            }
            const contactBlock = buildBranchContacts(branchDetails);
            if (contactBlock) {
                doc.font("Helvetica")
                    .fontSize(8)
                    .fillColor("#0f766e")
                    .text(contactBlock, startX, leftY, { width: halfW });
                leftY = doc.y + 2;
            }
            const taxParts = [];
            if (branchDetails?.gst) taxParts.push(`GSTIN: ${branchDetails.gst}`);
            if (branchDetails?.pan) taxParts.push(`PAN: ${branchDetails.pan}`);
            if (taxParts.length) {
                doc.font("Helvetica")
                    .fontSize(8)
                    .fillColor("#475569")
                    .text(taxParts.join("\n"), startX, leftY, { width: halfW });
                leftY = doc.y;
            }

            const clientName = partyDetails?.name || partyDetails?.id || "Party";
            doc.font("Helvetica-Bold")
                .fontSize(11)
                .fillColor("#0f172a")
                .text(clientName, rightX, headerStartY, { width: halfW, align: "right" });
            let rightY = doc.y + 2;
            if (partyDetails?.mobile) {
                doc.font("Helvetica")
                    .fontSize(8)
                    .fillColor("#475569")
                    .text(`Mobile: ${partyDetails.mobile}`, rightX, rightY, {
                        width: halfW,
                        align: "right",
                    });
                rightY = doc.y + 1;
            }
            if (partyDetails?.email) {
                doc.font("Helvetica")
                    .fontSize(8)
                    .fillColor("#475569")
                    .text(`Email: ${partyDetails.email}`, rightX, rightY, {
                        width: halfW,
                        align: "right",
                    });
                rightY = doc.y + 1;
            }
            if (partyDetails?.pan) {
                doc.font("Helvetica")
                    .fontSize(8)
                    .fillColor("#475569")
                    .text(`PAN: ${partyDetails.pan}`, rightX, rightY, {
                        width: halfW,
                        align: "right",
                    });
                rightY = doc.y + 1;
            }
            if (partyDetails?.type) {
                doc.font("Helvetica")
                    .fontSize(8)
                    .fillColor("#64748b")
                    .text(partyDetails.type, rightX, rightY, {
                        width: halfW,
                        align: "right",
                    });
                rightY = doc.y;
            }

            y = Math.max(leftY, rightY, headerStartY) + 10;

            doc.font("Helvetica-Bold")
                .fontSize(14)
                .fillColor("#0369a1")
                .text("Ledger Statement", startX, y, {
                    width: tableWidth,
                    align: "center",
                });
            y = doc.y + 4;

            doc.font("Helvetica")
                .fontSize(9)
                .fillColor("#64748b")
                .text(
                    `Period: ${formatDateForReport(fromDate)} – ${formatDateForReport(toDate)}`,
                    startX,
                    y,
                    { width: tableWidth, align: "center" }
                );
            y = doc.y + 10;

            y = drawHeader(y);

            const drawAmountRow = (label, debit, credit, balance, opts = {}) => {
                const labelW =
                    cols.particular.width + cols.type.width + cols.voucher.width - cellPadX * 2;
                doc.font("Helvetica-Bold").fontSize(bodyFontSize);
                const labelH = doc.heightOfString(label, { width: Math.max(8, labelW), lineGap: 1 });
                const rowHeight = Math.max(minRowH, labelH + cellPadY * 2);
                y = ensureSpace(y, rowHeight);
                const rowTop = y;
                drawRowChrome(rowTop, rowHeight, { stripe: opts.stripe !== false });
                const textY = rowTop + cellPadY;
                doc.fillColor("#0f172a")
                    .font("Helvetica-Bold")
                    .fontSize(bodyFontSize)
                    .text(label, textX(cols.particular), textY, {
                        width: labelW,
                        lineGap: 1,
                    });
                doc.fillColor("#2563eb")
                    .font(opts.boldAmounts ? "Helvetica-Bold" : "Helvetica")
                    .text(formatCurrency(debit), textX(cols.debit), textY, textOpts(cols.debit));
                doc.fillColor("#c2410c").text(
                    formatCurrency(credit),
                    textX(cols.credit),
                    textY,
                    textOpts(cols.credit)
                );
                const bal = Number(balance) || 0;
                doc.fillColor(bal < 0 ? "#dc2626" : "#2563eb")
                    .font("Helvetica-Bold")
                    .text(
                        formatCurrency(bal, { signed: true }),
                        textX(cols.balance),
                        textY,
                        {
                            ...textOpts(cols.balance),
                            height: rowHeight - cellPadY,
                        }
                    );
                y = rowTop + rowHeight;
                doc.x = startX;
                doc.y = y;
            };

            drawAmountRow(
                "Opening Balance",
                openingDebit > 0 ? openingDebit : 0,
                openingCredit > 0 ? openingCredit : 0,
                openingBalance,
                { stripe: true }
            );

            const rows = Array.isArray(statementData) ? statementData : [];
            rows.forEach((row, index) => {
                const particularText = String(row.particular || "-");
                const particularSub = String(row.particular_sub || "").trim();
                const particularRemark = String(row.particular_remark || "").trim();
                const typeText = formatTypeLabel(row.type);
                const voucherText = String(row.invoice_no || "N/A");
                const dateText = formatDateForDisplay(row.date);
                const debit = Number(row.debit) || 0;
                const credit = Number(row.credit) || 0;
                const balance = Number(row.balance) || 0;
                const debitText = formatCurrency(debit);
                const creditText = formatCurrency(credit);
                const balanceText = formatCurrency(balance, { signed: true });
                const subFontSize = 8;
                const particularWidth = Math.max(8, cols.particular.width - cellPadX * 2);

                const particularH =
                    measureH(particularText, cols.particular) +
                    (particularSub
                        ? measureH(particularSub, cols.particular, "Helvetica", subFontSize) + 2
                        : 0) +
                    (particularRemark
                        ? measureH(particularRemark, cols.particular, "Helvetica", subFontSize) + 2
                        : 0);
                const contentH = Math.max(
                    measureH(String(index + 1), cols.serial),
                    measureH(dateText, cols.date),
                    particularH,
                    measureH(typeText, cols.type),
                    measureH(voucherText, cols.voucher),
                    measureH(debitText, cols.debit),
                    measureH(creditText, cols.credit),
                    measureH(balanceText, cols.balance, "Helvetica-Bold")
                );
                const rowHeight = Math.max(minRowH, Math.ceil(contentH + cellPadY * 2));

                y = ensureSpace(y, rowHeight);
                const rowTop = y;
                drawRowChrome(rowTop, rowHeight, { stripe: index % 2 === 1 });
                const textY = rowTop + cellPadY;

                // Absolute-position each cell so wrapping never shifts the next column
                doc.fillColor("#334155").font("Helvetica").fontSize(bodyFontSize);
                doc.text(String(index + 1), textX(cols.serial), textY, {
                    ...textOpts(cols.serial),
                    height: rowHeight - cellPadY,
                });
                doc.text(dateText, textX(cols.date), textY, {
                    ...textOpts(cols.date),
                    height: rowHeight - cellPadY,
                });
                let particularCursorY = textY;
                doc.fillColor("#0f172a").font("Helvetica").fontSize(bodyFontSize);
                doc.text(particularText, textX(cols.particular), particularCursorY, {
                    width: particularWidth,
                    align: cols.particular.align,
                    lineGap: 1,
                });
                particularCursorY += doc.heightOfString(particularText, {
                    width: particularWidth,
                    lineGap: 1,
                });
                if (particularSub) {
                    particularCursorY += 1;
                    doc.fillColor("#64748b")
                        .font("Helvetica")
                        .fontSize(subFontSize)
                        .text(particularSub, textX(cols.particular), particularCursorY, {
                            width: particularWidth,
                            align: cols.particular.align,
                            lineGap: 1,
                        });
                    particularCursorY += doc.heightOfString(particularSub, {
                        width: particularWidth,
                        lineGap: 1,
                    });
                }
                if (particularRemark) {
                    particularCursorY += 1;
                    doc.fillColor("#475569")
                        .font("Helvetica")
                        .fontSize(subFontSize)
                        .text(particularRemark, textX(cols.particular), particularCursorY, {
                            width: particularWidth,
                            align: cols.particular.align,
                            lineGap: 1,
                        });
                }
                doc.fillColor("#334155").font("Helvetica").fontSize(bodyFontSize);
                doc.text(typeText, textX(cols.type), textY, {
                    ...textOpts(cols.type),
                    height: rowHeight - cellPadY,
                });
                doc.text(voucherText, textX(cols.voucher), textY, {
                    ...textOpts(cols.voucher),
                    height: rowHeight - cellPadY,
                });

                doc.fillColor(debit > 0 ? "#2563eb" : "#64748b");
                doc.text(debitText, textX(cols.debit), textY, {
                    ...textOpts(cols.debit),
                    height: rowHeight - cellPadY,
                });
                doc.fillColor(credit > 0 ? "#c2410c" : "#64748b");
                doc.text(creditText, textX(cols.credit), textY, {
                    ...textOpts(cols.credit),
                    height: rowHeight - cellPadY,
                });
                doc.fillColor(balance < 0 ? "#dc2626" : "#2563eb")
                    .font("Helvetica-Bold")
                    .text(balanceText, textX(cols.balance), textY, {
                        ...textOpts(cols.balance),
                        height: rowHeight - cellPadY,
                    });

                // Reset flow cursor so PDFKit does not carry overflow into the next row
                y = rowTop + rowHeight;
                doc.x = startX;
                doc.y = y;
            });

            const totDebit = Number(summary?.totalDebit ?? openingDebit) || 0;
            const totCredit = Number(summary?.totalCredit ?? openingCredit) || 0;
            const closing = Number(summary?.closingBalance ?? openingBalance) || 0;
            drawAmountRow("Total", totDebit, totCredit, closing, {
                boldAmounts: true,
                stripe: true,
            });

            if (tableTopY != null) {
                drawOuterBorder(tableTopY, y);
            }

            // Footer on each existing page (reserved margin — no new pages)
            const range = doc.bufferedPageRange();
            const generatedAt = new Date().toLocaleString("en-IN");
            for (let i = 0; i < range.count; i += 1) {
                doc.switchToPage(range.start + i);
                const footerY = doc.page.height - 32;
                doc.font("Helvetica")
                    .fontSize(8)
                    .fillColor("#64748b")
                    .text(
                        `Generated ${generatedAt}  ·  Page ${i + 1} of ${range.count}`,
                        startX,
                        footerY,
                        {
                            width: tableWidth,
                            align: "center",
                            lineBreak: false,
                            height: 12,
                        }
                    );
            }

            doc.end();
        } catch (error) {
            reject(error);
        }
    });
}
