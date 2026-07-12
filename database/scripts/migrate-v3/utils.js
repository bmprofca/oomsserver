import { BATCH_SIZE, NEW_BRANCH_ID, OLD_APP_ID, OLD_BRANCH_ID } from "./config.js";
import { stagingTable } from "./db.js";

export const BRANCH_FILTER_SQL = `(app_id = ? AND branch_id = ?)`;
export const BRANCH_FILTER_REVERSED_SQL = `(branch_id = ? AND app_id = ?)`;
export const BRANCH_FILTER_PARAMS = [OLD_APP_ID, OLD_BRANCH_ID];
export const BRANCH_FILTER_REVERSED_PARAMS = [OLD_BRANCH_ID, OLD_APP_ID];

export function mapPartyType(oldType) {
    const t = String(oldType || "").trim().toLowerCase();
    const map = {
        user: "client",
        admin: "staff",
        bank: "bank",
        expence: "expense",
        expense: "expense",
        asset: "asset",
        ca: "ca",
        agent: "agent",
        staff: "staff",
        client: "client",
        capital: "capital",
    };
    return map[t] || t || null;
}

export function mapTransactionType(oldType) {
    const t = String(oldType || "").trim().toLowerCase();
    if (t === "received") return "receive";
    if (t === "opening balance") return "opening balance";
    if (t === "asset purchase") return "purchase";
    return t;
}

/** v5 invoice.type for finance vouchers (differs from transactions.transaction_type for receive). */
export function mapInvoiceType(oldType) {
    const t = String(oldType || "").trim().toLowerCase();
    if (t === "received" || t === "receive") return "payment receive";
    return mapTransactionType(oldType);
}

export function safeDate(value) {
    if (!value) return null;
    const s = String(value);
    if (s.startsWith("0000-00-00")) return null;
    return value;
}

export function combineDateTime(dateVal, timeVal) {
    const date = safeDate(dateVal);
    if (!date) return null;
    const time = String(timeVal || "00:00:00").trim();
    if (time === "00:00:00" && String(date).includes(" ")) return String(date).slice(0, 19);
    return `${String(date).slice(0, 10)} ${time.length === 5 ? `${time}:00` : time}`;
}

export function calcTaxRateFromInvoice(inv) {
    const total = Number(inv.total) || 0;
    const igst = Number(inv.igst) || 0;
    const sgst = Number(inv.sgst) || 0;
    const cgst = Number(inv.cgst) || 0;
    const taxValue = igst + sgst + cgst;
    if (total <= 0) return { tax_rate: 0, tax_value: taxValue };
    const tax_rate = Number(((taxValue / total) * 100).toFixed(2));
    return { tax_rate, tax_value: taxValue };
}

export function permissionsFromOptions(options) {
    const permissions = options
        .filter((o) => String(o.value) === "1")
        .map((o) => String(o.name).trim())
        .filter(Boolean);
    return JSON.stringify({ permissions });
}

export async function queryBranchRows(staging, table, { reversed = false, extraWhere = "", extraParams = [] } = {}) {
    const filter = reversed ? BRANCH_FILTER_REVERSED_SQL : BRANCH_FILTER_SQL;
    const params = reversed ? [...BRANCH_FILTER_REVERSED_PARAMS] : [...BRANCH_FILTER_PARAMS];
    const stagingName = stagingTable(table);
    const sql = `SELECT * FROM \`${stagingName}\` WHERE ${filter}${extraWhere ? ` AND (${extraWhere})` : ""}`;
    const [rows] = await staging.query(sql, [...params, ...extraParams]);
    return rows;
}

export async function batchInsert(target, table, columns, rows, { dryRun = false, onProgress } = {}) {
    if (!rows.length) return 0;
    let inserted = 0;
    const colList = columns.map((c) => `\`${c}\``).join(", ");
    const placeholders = `(${columns.map(() => "?").join(", ")})`;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const chunk = rows.slice(i, i + BATCH_SIZE);
        const values = [];
        const valuePlaceholders = chunk
            .map((row) => {
                columns.forEach((col) => values.push(row[col] ?? null));
                return placeholders;
            })
            .join(", ");
        const sql = `INSERT IGNORE INTO \`${table}\` (${colList}) VALUES ${valuePlaceholders}`;
        if (!dryRun) {
            const [result] = await target.query(sql, values);
            inserted += result.affectedRows || 0;
        } else {
            inserted += chunk.length;
        }
        if (onProgress) onProgress(inserted, rows.length);
    }
    return inserted;
}

export async function resolveSaleEntriesBranchId(target, branchCode = NEW_BRANCH_ID) {
    const [rows] = await target.query(
        `SELECT branch_id FROM branch_list WHERE branch_id = ? LIMIT 1`,
        [branchCode]
    );
    return rows[0]?.branch_id ?? null;
}

export function userTypeToClientType(userType) {
    const t = String(userType || "").trim().toLowerCase();
    if (t === "user") return "client";
    if (t === "ca") return "ca";
    if (t === "agent") return "agent";
    return null;
}

export function userTypeToMappingType(userType) {
    const t = String(userType || "").trim().toLowerCase();
    if (t === "admin") return "admin";
    if (t === "employee") return "staff";
    if (t === "ca") return "ca";
    if (t === "agent") return "agent";
    return null;
}

export function profileIdFor(username) {
    const base = String(username || "user").replace(/[^a-zA-Z0-9_]/g, "_");
    return `PF_${base}`.slice(0, 100);
}

export function mapIdFor(username) {
    const base = String(username || "user").replace(/[^a-zA-Z0-9_]/g, "_");
    return `${NEW_BRANCH_ID}_MIG_${base}`.slice(0, 100);
}

/** Map old party type; old `user` is only `client` when username is a branch client. */
export function resolvePartyType(oldType, username, clientUsernameSet = null) {
    const mapped = mapPartyType(oldType);
    const id = String(username || "").trim();
    if (mapped === "client" && id && clientUsernameSet && !clientUsernameSet.has(id)) {
        return "staff";
    }
    return mapped;
}

export async function loadStagingClientUsernameSet(staging) {
    const users = await queryBranchRows(staging, "users");
    return new Set(
        users
            .filter((u) => String(u.user_type || "").trim().toLowerCase() === "user")
            .map((u) => String(u.username).trim())
            .filter(Boolean)
    );
}

function ledgerParty(row, clientUsernameSet = null) {
    if (!row) return { type: null, id: null };
    const pt = String(row.party_type || "").trim().toLowerCase();
    const pid = String(row.party_id || "").trim();
    if (pt && pid) return { type: resolvePartyType(pt, pid, clientUsernameSet), id: pid };
    const vt = String(row.viewer_type || "").trim().toLowerCase();
    const vid = String(row.viewer_id || "").trim();
    if (vt && vid) return { type: resolvePartyType(vt, vid, clientUsernameSet), id: vid };
    return { type: null, id: null };
}

export function resolveClientId(inv, ledgerRows) {
    const fromInv = String(inv?.username || "").trim();
    if (fromInv) return fromInv;
    for (const row of ledgerRows) {
        if (String(row.viewer_type).toLowerCase() === "user" && row.viewer_id) {
            return row.viewer_id;
        }
        if (String(row.party_type).toLowerCase() === "user" && row.party_id) {
            return row.party_id;
        }
    }
    return null;
}

/** Resolve purchase supplier party from invoice + ledger (v5: party1 only, party2 null). */
export function resolvePurchaseParty(inv, ledgerRows, clientUsernameSet = null) {
    const fromInv = String(inv?.username || "").trim();
    if (fromInv) {
        return {
            type: resolvePartyType("user", fromInv, clientUsernameSet),
            id: fromInv,
        };
    }

    const supplierTypes = new Set(["user", "bank"]);
    for (const row of ledgerRows) {
        const vt = String(row.viewer_type || "").trim().toLowerCase();
        const vid = String(row.viewer_id || "").trim();
        if (supplierTypes.has(vt) && vid) {
            return { type: resolvePartyType(vt, vid, clientUsernameSet), id: vid };
        }
    }
    for (const row of ledgerRows) {
        const pt = String(row.party_type || "").trim().toLowerCase();
        const pid = String(row.party_id || "").trim();
        if (supplierTypes.has(pt) && pid) {
            return { type: resolvePartyType(pt, pid, clientUsernameSet), id: pid };
        }
    }

    return ledgerParty(ledgerRows[0], clientUsernameSet);
}

export function buildInvoiceRow(inv) {
    const { tax_rate, tax_value } = calcTaxRateFromInvoice(inv);
    const subtotal = Number(inv.total) || 0;
    const grand_total = Number(inv.grand_total) || subtotal + tax_value;
    return {
        invoice_id: inv.invoice_id,
        branch_id: NEW_BRANCH_ID,
        invoice_no: inv.invoice_no,
        create_date: inv.create_date,
        create_by: inv.create_by,
        modify_date: inv.modify_date || inv.create_date,
        modify_by: inv.modify_by || inv.create_by,
        type: mapInvoiceType(inv.type),
        transaction_id: inv.payment_id || inv.invoice_id,
        subtotal,
        discount_type: "not applicable",
        discount_perc_rate: 0,
        discount_value: 0,
        tax_rate,
        tax_value,
        additional_charge: 0,
        total: subtotal,
        round_off: 0,
        grand_total,
    };
}

export function buildTransactionFromInvoice(inv, ledgerRows, journal = null, options = {}) {
    const clientUsernameSet = options.clientUsernameSet || null;
    const txnType = mapTransactionType(inv.type);
    const grandTotal = Number(inv.grand_total) || Number(inv.total) || 0;
    const transaction_id = inv.payment_id || inv.invoice_id;
    const clientId = resolveClientId(inv, ledgerRows);

    let amount = grandTotal;
    let party1_type = null;
    let party1_id = null;
    let party2_type = null;
    let party2_id = null;

    switch (txnType) {
        case "sale":
            party1_type = "sale";
            party1_id = inv.invoice_id;
            party2_type = "client";
            party2_id = clientId;
            amount = grandTotal;
            break;
        case "opening balance": {
            const row = ledgerRows[0];
            const absAmt = Math.abs(Number(row?.amount ?? grandTotal));
            amount = String(row?.type) === "1" ? -absAmt : absAmt;
            party1_type = "client";
            party1_id = clientId || row?.viewer_id || null;
            break;
        }
        case "payment": {
            const debitRow = ledgerRows.find((r) => String(r.type) === "0") || ledgerRows[0];
            const creditRow = ledgerRows.find((r) => String(r.type) === "1") || ledgerRows[1];
            const p1 = ledgerParty(debitRow, clientUsernameSet);
            const p2 = ledgerParty(creditRow, clientUsernameSet);
            party1_type = p1.type;
            party1_id = p1.id;
            party2_type = p2.type;
            party2_id = p2.id;
            amount = grandTotal;
            break;
        }
        case "receive": {
            const debitRow = ledgerRows.find((r) => String(r.type) === "0") || ledgerRows[0];
            const creditRow = ledgerRows.find((r) => String(r.type) === "1") || ledgerRows[1];
            const p1 = ledgerParty(debitRow, clientUsernameSet);
            const p2 = ledgerParty(creditRow, clientUsernameSet);
            party1_type = p1.type;
            party1_id = p1.id;
            party2_type = p2.type;
            party2_id = p2.id;
            amount = grandTotal;
            break;
        }
        case "journal": {
            const fromId = journal?.from_username || ledgerRows.find((r) => String(r.type) === "0")?.party_id;
            const toId = journal?.to_username || ledgerRows.find((r) => String(r.type) === "1")?.party_id;
            party1_type = "client";
            party1_id = fromId || null;
            party2_type = "client";
            party2_id = toId || null;
            amount = grandTotal;
            break;
        }
        case "expense": {
            const userViewerRow = ledgerRows.find(
                (r) => String(r.viewer_type || "").trim().toLowerCase() === "user" && r.viewer_id
            );
            const viewerId = userViewerRow ? String(userViewerRow.viewer_id).trim() : "";
            if (viewerId && clientUsernameSet?.has(viewerId)) {
                party1_type = "client";
                party1_id = viewerId;
                party2_type = "expense";
                party2_id = inv.invoice_id;
                amount = grandTotal;
                break;
            }
            const row = ledgerRows[0];
            const viewer = ledgerParty(row, clientUsernameSet);
            party1_type = viewer.type || "staff";
            party1_id = viewer.id || inv.create_by;
            party2_type = "expense";
            party2_id = inv.invoice_id;
            amount = grandTotal;
            break;
        }
        case "purchase": {
            const party = resolvePurchaseParty(inv, ledgerRows, clientUsernameSet);
            party1_type = party.type;
            party1_id = party.id;
            party2_type = null;
            party2_id = null;
            amount = grandTotal;
            break;
        }
        default: {
            const debitRow = ledgerRows.find((r) => String(r.type) === "0") || ledgerRows[0];
            const creditRow = ledgerRows.find((r) => String(r.type) === "1") || ledgerRows[1];
            const p1 = ledgerParty(debitRow, clientUsernameSet);
            const p2 = ledgerParty(creditRow, clientUsernameSet);
            party1_type = p1.type;
            party1_id = p1.id;
            party2_type = p2.type;
            party2_id = p2.id;
            amount = grandTotal;
            break;
        }
    }

    return {
        branch_id: NEW_BRANCH_ID,
        transaction_id,
        create_date: inv.create_date,
        create_by: inv.create_by,
        modify_date: inv.modify_date || inv.create_date,
        modify_by: inv.modify_by || inv.create_by,
        transaction_date: safeDate(inv.date) || safeDate(inv.create_date),
        transaction_type: txnType,
        amount,
        invoice_id: inv.invoice_id,
        invoice_no: inv.invoice_no || "",
        party1_type,
        party1_id,
        party2_type,
        party2_id,
        remark: "",
    };
}

/** Compute client balance effect from a v5-style transaction row (mirrors GET_BALANCE). */
export function transactionEffectForClient(txn, clientId) {
    if (!clientId) return 0;
    const amt = Number(txn.amount) || 0;
    if (txn.party1_type === "client" && txn.party1_id === clientId) {
        return txn.party2_id == null ? amt : -amt;
    }
    if (txn.party2_type === "client" && txn.party2_id === clientId) {
        return amt;
    }
    return 0;
}

export function sumClientBalanceFromTransactions(transactions, clientId) {
    return transactions.reduce((sum, txn) => sum + transactionEffectForClient(txn, clientId), 0);
}

/** Batch-fetch client balances from target DB (same logic as GET_BALANCE). */
export async function fetchAllClientBalances(target, branchId) {
    const { CLIENT_BALANCE_EFFECTS_SQL } = await import("../../../helpers/clientBalanceSql.js");
    const [rows] = await target.query(
        `SELECT party_id, SUM(effect) AS balance
         FROM (${CLIENT_BALANCE_EFFECTS_SQL}) t
         GROUP BY party_id`,
        [branchId, branchId]
    );
    const map = new Map();
    for (const row of rows) {
        map.set(row.party_id, Number(row.balance) || 0);
    }
    return map;
}

/** Old v3 staging ledger balance per client (viewer_type = user rows only). */
export async function fetchAllClientBalancesFromStagingLedger(staging) {
    const [rows] = await staging.query(
        `SELECT client_id AS party_id, SUM(effect) AS balance
         FROM (
             SELECT
                 viewer_id AS client_id,
                 CASE WHEN type = '0' THEN amount ELSE -amount END AS effect
             FROM \`${stagingTable("ledger")}\`
             WHERE app_id = ? AND branch_id = ?
               AND LOWER(TRIM(viewer_type)) = 'user'
               AND viewer_id IS NOT NULL
               AND viewer_id != ''
         ) t
         WHERE client_id IS NOT NULL
         GROUP BY client_id`,
        [OLD_APP_ID, OLD_BRANCH_ID]
    );
    const map = new Map();
    for (const row of rows) {
        map.set(row.party_id, Number(row.balance) || 0);
    }
    return map;
}

/** Legacy dashboard balance SQL (pre-fix) for diagnostics. */
export async function fetchLegacyDashboardBalances(target, branchId) {
    const { LEGACY_DASHBOARD_EFFECTS_SQL } = await import("../../../helpers/clientBalanceSql.js");
    const [rows] = await target.query(
        `SELECT party_id, SUM(effect) AS balance
         FROM (${LEGACY_DASHBOARD_EFFECTS_SQL}) t
         GROUP BY party_id`,
        [branchId, branchId]
    );
    const map = new Map();
    for (const row of rows) {
        map.set(row.party_id, Number(row.balance) || 0);
    }
    return map;
}

export function countDebtorsFromBalanceMap(balanceMap, threshold = 0.02) {
    let count = 0;
    let total = 0;
    for (const balance of balanceMap.values()) {
        if (balance > threshold) {
            count++;
            total += balance;
        }
    }
    return { count, total };
}

export function countCreditorsFromBalanceMap(balanceMap, threshold = 0.02) {
    let count = 0;
    let total = 0;
    for (const balance of balanceMap.values()) {
        if (balance < -threshold) {
            count++;
            total += balance;
        }
    }
    return { count, total };
}

