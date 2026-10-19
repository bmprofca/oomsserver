import * as z from "zod";
import { kpiBlock, tableBlock } from "../blocks.js";
import {
    clientBalanceListParams,
    clientBalanceListSql,
    clientBalanceTotalParams,
    clientBalanceTotalSql,
} from "../../helpers/clientBalanceSql.js";
import { ToolError, dateRangeFields, has, idString, limitField, pageField, resolveRange, searchString, toNumber, ymd } from "./common.js";

/**
 * Account / balance tools. All balances come from the existing ledger rules:
 *   balance = SUM(amount where party is party2 → debit) − SUM(amount where party is party1 → credit)
 * via GET_BALANCE (helpers/function.js) and collectLedgerStatement (helpers/ledgerReport.js);
 * outstanding lists via helpers/clientBalanceSql.js. Positive = Dr, negative = Cr.
 * For clients/CAs a Dr balance means they owe the office (debtor); Cr means the office owes them / advance.
 *
 * Server never checked finance_* permissions before; the assistant enforces them:
 *   finance_balance_view → balances & outstanding;  finance_report → ledger statements.
 */

const PARTY_TYPES = ["client", "ca", "staff", "bank", "capital"];

function maskMobile(mobile) {
    const digits = String(mobile || "").replace(/\D/g, "");
    return digits.length >= 4 ? `••••••${digits.slice(-4)}` : null;
}

function balanceSide(balance) {
    if (Math.abs(balance) < 0.005) return "Nil";
    return balance > 0 ? "Dr" : "Cr";
}

function balanceMeaning(partyType, balance) {
    if (Math.abs(balance) < 0.005) return "No outstanding balance.";
    if (partyType === "client" || partyType === "ca") {
        return balance > 0 ? "Receivable: the party owes the office (debtor)." : "Payable/advance: the office owes the party (creditor).";
    }
    if (partyType === "bank") {
        return balance > 0 ? "Debit balance: funds available in this account as per the ledger." : "Credit balance (overdrawn as per the ledger).";
    }
    return balance > 0 ? "Debit balance as per the ledger." : "Credit balance as per the ledger.";
}

/** Existence check scoped to the branch; returns a display record or null. */
async function loadParty(db, branchId, partyType, partyId) {
    if (partyType === "client" || partyType === "ca") {
        const [rows] = await db.query(
            `SELECT c.username AS id,
                    (SELECT p.name FROM profile p WHERE p.username = c.username ORDER BY p.id DESC LIMIT 1) AS name
             FROM clients c
             WHERE c.branch_id = ? AND c.username = ? AND c.user_type = ? AND c.is_deleted = '0'
             LIMIT 1`,
            [branchId, partyId, partyType]
        );
        return rows?.[0] ? { id: rows[0].id, name: rows[0].name || rows[0].id } : null;
    }
    if (partyType === "staff") {
        const [rows] = await db.query(
            `SELECT bm.username AS id,
                    (SELECT p.name FROM profile p WHERE p.username = bm.username ORDER BY p.id DESC LIMIT 1) AS name
             FROM branch_mapping bm
             WHERE bm.branch_id = ? AND bm.username = ? AND bm.type = 'staff' AND bm.is_deleted = '0'
             LIMIT 1`,
            [branchId, partyId]
        );
        return rows?.[0] ? { id: rows[0].id, name: rows[0].name || rows[0].id } : null;
    }
    if (partyType === "bank") {
        const [rows] = await db.query(
            `SELECT bank_id AS id, COALESCE(NULLIF(holder, ''), NULLIF(bank, ''), bank_id) AS name, bank, account_no
             FROM banks WHERE branch_id = ? AND bank_id = ? LIMIT 1`,
            [branchId, partyId]
        );
        const r = rows?.[0];
        return r ? { id: r.id, name: r.bank && r.name !== r.bank ? `${r.name} (${r.bank})` : r.name } : null;
    }
    if (partyType === "capital") {
        const [rows] = await db.query(
            `SELECT capital_id AS id, COALESCE(name, capital_id) AS name
             FROM capitals WHERE branch_id = ? AND capital_id = ? LIMIT 1`,
            [branchId, partyId]
        );
        return rows?.[0] ? { id: rows[0].id, name: rows[0].name } : null;
    }
    return null;
}

export const searchParties = {
    name: "search_parties",
    description:
        "Find ledger accounts (parties) of the current office by name, mobile, PAN, username or bank name. " +
        "Party types: client, ca, staff, bank, capital. Use this to resolve a person's or account's name to " +
        "party_type + party_id before asking for a balance or ledger statement. A person may have more than one " +
        "account type (e.g. client and staff) — if several match, ask the user which one.",
    input: z.object({
        search: searchString,
        types: z.array(z.enum(PARTY_TYPES)).min(1).max(5).optional()
            .describe("Party types to search (default: client, ca, staff, bank)"),
        limit: limitField,
    }).strict(),
    allowed: (ctx) => has(ctx, "finance_balance_view") || has(ctx, "finance_report"),
    async handler(ctx, args, { db }) {
        const types = args.types?.length ? args.types : ["client", "ca", "staff", "bank"];
        const p = `%${args.search}%`;

        const searchType = async (type) => {
            let rows = [];
            if (type === "client" || type === "ca") {
                // Phase 1: match + limit (no per-row subqueries before the LIMIT).
                [rows] = await db.query(
                    `SELECT c.username AS party_id, p.name, p.mobile
                     FROM clients c
                     LEFT JOIN profile p ON p.username = c.username
                       AND p.id = (SELECT MAX(p2.id) FROM profile p2 WHERE p2.username = c.username)
                     WHERE c.branch_id = ? AND c.user_type = ? AND c.is_deleted = '0'
                       AND (p.name LIKE ? OR p.mobile LIKE ? OR p.pan_number LIKE ? OR c.username LIKE ?
                            OR c.username IN (SELECT f2.username FROM firms f2
                                              WHERE f2.branch_id = ? AND f2.is_deleted = '0' AND f2.firm_name LIKE ?))
                     ORDER BY p.name ASC
                     LIMIT ?`,
                    [ctx.branch_id, type, p, p, p, p, ctx.branch_id, p, args.limit]
                );
                // Phase 2: firm names for just the matched clients.
                if (rows.length) {
                    const ids = rows.map((r) => r.party_id);
                    const [firmRows] = await db.query(
                        `SELECT username, GROUP_CONCAT(firm_name ORDER BY firm_name SEPARATOR ', ') AS firms
                         FROM firms
                         WHERE branch_id = ? AND is_deleted = '0' AND username IN (${ids.map(() => "?").join(", ")})
                         GROUP BY username`,
                        [ctx.branch_id, ...ids]
                    );
                    const byUser = new Map(firmRows.map((f) => [f.username, f.firms]));
                    rows = rows.map((r) => ({ ...r, firms: byUser.get(r.party_id) || null }));
                }
            } else if (type === "staff") {
                [rows] = await db.query(
                    `SELECT bm.username AS party_id, p.name, p.mobile, bm.designation AS firms
                     FROM branch_mapping bm
                     LEFT JOIN profile p ON p.username = bm.username
                       AND p.id = (SELECT MAX(p2.id) FROM profile p2 WHERE p2.username = bm.username)
                     WHERE bm.branch_id = ? AND bm.type = 'staff' AND bm.is_deleted = '0'
                       AND (p.name LIKE ? OR p.mobile LIKE ? OR bm.username LIKE ?)
                     ORDER BY p.name ASC
                     LIMIT ?`,
                    [ctx.branch_id, p, p, p, args.limit]
                );
            } else if (type === "bank") {
                [rows] = await db.query(
                    `SELECT bank_id AS party_id, COALESCE(NULLIF(holder, ''), bank_id) AS name, NULL AS mobile, bank AS firms
                     FROM banks
                     WHERE branch_id = ? AND IFNULL(is_deleted, '0') = '0'
                       AND (holder LIKE ? OR bank LIKE ? OR account_no LIKE ? OR bank_id LIKE ?)
                     ORDER BY holder ASC
                     LIMIT ?`,
                    [ctx.branch_id, p, p, p, p, args.limit]
                );
            } else if (type === "capital") {
                [rows] = await db.query(
                    `SELECT capital_id AS party_id, COALESCE(name, capital_id) AS name, NULL AS mobile, remark AS firms
                     FROM capitals
                     WHERE branch_id = ? AND IFNULL(is_deleted, 0) = 0 AND (name LIKE ? OR capital_id LIKE ?)
                     ORDER BY name ASC
                     LIMIT ?`,
                    [ctx.branch_id, p, p, args.limit]
                );
            }
            return rows.map((r) => ({
                party_type: type,
                party_id: r.party_id,
                name: r.name || r.party_id,
                mobile: maskMobile(r.mobile),
                detail: r.firms || null,
            }));
        };

        const results = (await Promise.all(types.map(searchType))).flat();
        const matches = results.slice(0, args.limit);
        return {
            data: { count: matches.length, matches },
            blocks: matches.length > 1
                ? [tableBlock({
                    title: `Accounts matching “${args.search}”`,
                    columns: [
                        { key: "name", label: "Name" },
                        { key: "party_type", label: "Type", type: "status" },
                        { key: "detail", label: "Firm / detail" },
                        { key: "mobile", label: "Mobile" },
                    ],
                    rows: matches,
                })]
                : [],
        };
    },
};

export const getPartyBalance = {
    name: "get_party_balance",
    description:
        "Current ledger balance of one account (party_type + party_id from search_parties), computed exactly like " +
        "the OOMS ledger: total debit, total credit and closing balance (Dr/Cr) including the opening balance and " +
        "all transactions to date.",
    input: z.object({
        party_type: z.enum(PARTY_TYPES),
        party_id: idString("party_id"),
    }).strict(),
    allowed: (ctx) => has(ctx, "finance_balance_view"),
    async handler(ctx, args, { db, getBalance }) {
        const party = await loadParty(db, ctx.branch_id, args.party_type, args.party_id);
        if (!party) throw new ToolError("NOT_FOUND", "No account with that id exists in this office.");
        const result = await getBalance({ branch_id: ctx.branch_id, party_id: args.party_id, party_type: args.party_type });
        const balance = toNumber(result.balance);
        const data = {
            party: { type: args.party_type, id: party.id, name: party.name },
            as_of: ctx.today,
            total_debit: toNumber(result.debit),
            total_credit: toNumber(result.credit),
            balance,
            balance_abs: Math.abs(balance),
            side: balanceSide(balance),
            meaning: balanceMeaning(args.party_type, balance),
            rule: "balance = total debit − total credit, includes the opening balance entry",
        };
        return {
            data,
            blocks: [
                kpiBlock({
                    title: `${party.name} — balance as of ${ctx.today}`,
                    items: [
                        { label: `Balance (${data.side})`, value: data.balance_abs, format: "money" },
                        { label: "Total debit", value: data.total_debit, format: "money" },
                        { label: "Total credit", value: data.total_credit, format: "money" },
                    ],
                }),
            ],
        };
    },
};

export const getOutstandingBalances = {
    name: "get_outstanding_balances",
    description:
        "Clients with outstanding balances: side 'debtor' = clients who owe the office (receivables), " +
        "'creditor' = clients the office owes / advances. Returns the grand total for all matching clients and one page of rows.",
    input: z.object({
        side: z.enum(["debtor", "creditor"]).default("debtor"),
        search: searchString.optional(),
        limit: limitField,
        page: pageField,
    }).strict(),
    allowed: (ctx) => has(ctx, "finance_balance_view"),
    async handler(ctx, args, { db }) {
        const search = args.search || "";
        const offset = (args.page - 1) * args.limit;
        const [[totals]] = await db.query(
            clientBalanceTotalSql(args.side, search),
            clientBalanceTotalParams(ctx.branch_id, search, args.side)
        );
        const [rows] = await db.query(
            clientBalanceListSql(args.side, search),
            clientBalanceListParams(ctx.branch_id, args.limit, offset, search, args.side)
        );
        const total = Number(totals?.total) || 0;
        const clients = rows.map((r) => ({
            username: r.username,
            name: r.name || r.username,
            firm: r.firm_name || null,
            balance: Math.abs(toNumber(r.total_balance)),
            last_transaction: ymd(r.last_transaction_date),
            last_received: r.last_received_in || null,
        }));
        const hasMore = offset + clients.length < total;
        return {
            data: {
                side: args.side,
                total_clients: total,
                total_amount: Math.abs(toNumber(totals?.balance_sum)),
                page: args.page,
                has_more: hasMore,
                clients,
            },
            blocks: [
                kpiBlock({
                    items: [
                        { label: args.side === "debtor" ? "Total receivable" : "Total payable / advance", value: Math.abs(toNumber(totals?.balance_sum)), format: "money" },
                        { label: args.side === "debtor" ? "Debtor clients" : "Creditor clients", value: total },
                    ],
                }),
                tableBlock({
                    title: args.side === "debtor" ? "Outstanding receivables" : "Client credit balances",
                    columns: [
                        { key: "name", label: "Client", href: "/client/profile/{username}" },
                        { key: "firm", label: "Firm" },
                        { key: "balance", label: "Balance", type: "money" },
                        { key: "last_transaction", label: args.side === "debtor" ? "Last payment" : "Last entry", type: "date" },
                    ],
                    rows: clients,
                    total,
                    truncated: hasMore,
                    note: hasMore ? `Showing ${clients.length} of ${total}.` : null,
                }),
            ],
        };
    },
};

export const getLedgerStatement = {
    name: "get_ledger_statement",
    description:
        "Ledger statement / transaction history of one account (party_type + party_id) for a period: opening " +
        "balance, each transaction (date, particulars, type, voucher, debit, credit, running balance) and closing " +
        "balance. Uses the same calculation as the OOMS ledger report. Maximum period 366 days.",
    input: z.object({
        party_type: z.enum(PARTY_TYPES),
        party_id: idString("party_id"),
        ...dateRangeFields,
    }).strict(),
    allowed: (ctx) => has(ctx, "finance_report"),
    async handler(ctx, args, { db, collectLedger }) {
        const party = await loadParty(db, ctx.branch_id, args.party_type, args.party_id);
        if (!party) throw new ToolError("NOT_FOUND", "No account with that id exists in this office.");
        const range = resolveRange(args, ctx, { maxDays: 366, defaultPreset: "this_fy" });
        const ledger = await collectLedger({
            branch_id: ctx.branch_id,
            partyType: args.party_type,
            partyId: args.party_id,
            fromDate: range.from,
            toDate: range.to,
        });

        const MAX_ROWS = 200;
        const all = ledger.statementData || [];
        const rows = all.slice(-MAX_ROWS).map((r) => ({
            date: ymd(r.date),
            particulars: String(r.particular || "-").replace(/\s+/g, " ").slice(0, 160),
            type: r.type || null,
            voucher: r.invoice_no && r.invoice_no !== "N/A" ? r.invoice_no : null,
            debit: toNumber(r.debit),
            credit: toNumber(r.credit),
            balance: toNumber(r.balance),
        }));
        const opening = toNumber(ledger.openingBalance);
        const closing = toNumber(ledger.summary?.closingBalance);
        const truncated = all.length > MAX_ROWS;

        return {
            data: {
                party: { type: args.party_type, id: party.id, name: party.name },
                period: { from: range.from, to: range.to },
                opening_balance: opening,
                opening_side: balanceSide(opening),
                total_debit_incl_opening: toNumber(ledger.summary?.totalDebit),
                total_credit_incl_opening: toNumber(ledger.summary?.totalCredit),
                closing_balance: closing,
                closing_side: balanceSide(closing),
                transaction_count: all.length,
                truncated,
                transactions: rows.slice(-60),
                note: truncated ? `Only the latest ${MAX_ROWS} of ${all.length} entries are shown; totals cover all entries.` : undefined,
            },
            blocks: [
                kpiBlock({
                    title: `${party.name} — ledger ${range.from} to ${range.to}`,
                    items: [
                        { label: `Opening (${balanceSide(opening)})`, value: Math.abs(opening), format: "money" },
                        { label: "Debit", value: toNumber(ledger.summary?.totalDebit) - (opening > 0 ? opening : 0), format: "money" },
                        { label: "Credit", value: toNumber(ledger.summary?.totalCredit) - (opening < 0 ? -opening : 0), format: "money" },
                        { label: `Closing (${balanceSide(closing)})`, value: Math.abs(closing), format: "money" },
                    ],
                }),
                tableBlock({
                    title: `Ledger of ${party.name}`,
                    columns: [
                        { key: "date", label: "Date", type: "date" },
                        { key: "particulars", label: "Particulars" },
                        { key: "type", label: "Type", type: "status" },
                        { key: "voucher", label: "Voucher" },
                        { key: "debit", label: "Debit", type: "money" },
                        { key: "credit", label: "Credit", type: "money" },
                        { key: "balance", label: "Balance", type: "money" },
                    ],
                    rows,
                    total: all.length,
                    truncated,
                    note: truncated ? `Latest ${MAX_ROWS} of ${all.length} entries; totals include all entries.` : null,
                }),
            ],
        };
    },
};

export default [searchParties, getPartyBalance, getOutstandingBalances, getLedgerStatement];
