import test from "node:test";
import assert from "node:assert/strict";
import { runTool, truncateForModel, BLOCKS_META_KEY } from "../ai/mcp/runTool.js";
import { searchStaff } from "../ai/tools/staff.js";
import { getStaffTasks, searchTasks } from "../ai/tools/tasks.js";
import { attendanceReport } from "../ai/tools/attendance.js";
import { getPartyBalance, getOutstandingBalances, getLedgerStatement } from "../ai/tools/finance.js";
import { expenseReport } from "../ai/tools/reports.js";
import { createFakeDb, makeCtx } from "./helpers/aiFakes.js";

const parse = (result) => JSON.parse(result.content[0].text);
const blocksOf = (result) => result._meta?.[BLOCKS_META_KEY] || [];
const manager = (extra = {}) => makeCtx({ username: "boss", permissions: ["staff_view_manage", "task_fees_view"], ...extra });

function taskDb({ member = true, rows = [], agg = {} } = {}) {
    return createFakeDb([
        [/FROM branch_mapping bm\s+WHERE bm.branch_id = \? AND bm.username = \?/, () =>
            (member ? [{ username: "arun", type: "staff", designation: "Accountant", name: "Arun Pawan" }] : [])],
        [/SELECT COUNT\(\*\) AS total/, () => [{ total: 8, in_process: 2, pending_from_client: 1, pending_from_department: 0, complete: 4, cancel: 1, overdue: 1, ...agg }]],
        [/SELECT t.task_id/, () => rows],
    ]);
}

const sampleTasks = [
    { task_id: "T1", status: "in process", due_date: "2026-10-10", service_name: "GST Return", client_name: "Asish Layek", firm_name: "AL & Co", total: "1500.00", fees: "1500.00" },
    { task_id: "T2", status: "complete", due_date: "2026-10-01", service_name: "ITR", client_name: "B Roy", total: "800" },
];

test("authorized manager retrieves a staff member's tasks with real counts", async () => {
    const db = taskDb({ rows: sampleTasks });
    const result = await runTool(getStaffTasks, manager(), { staff_username: "arun" }, { db });
    assert.equal(result.isError, undefined);
    const data = parse(result);
    assert.equal(data.staff.name, "Arun Pawan");
    assert.deepEqual(data.summary, { total: 8, in_process: 2, pending_from_client: 1, pending_from_department: 0, complete: 4, cancel: 1, overdue: 1 });
    assert.equal(data.tasks[0].overdue, true, "active task due before today is overdue");
    assert.equal(data.tasks[1].overdue, false, "completed task is never overdue");
    const table = blocksOf(result).find((b) => b.type === "table");
    assert.equal(table.title, "Tasks assigned to Arun Pawan");
    assert.equal(table.rows[0].task_id, "T1");
    assert.equal(table.columns[0].href, "/task/{task_id}");
    // Every query is scoped to the caller's branch.
    for (const call of db.calls) assert.equal(call.params.includes("BR1"), true, call.sql);
});

test("unknown staff username returns not found, no task query", async () => {
    const db = taskDb({ member: false });
    const result = await runTool(getStaffTasks, manager(), { staff_username: "nobody" }, { db });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /NOT_FOUND/);
    assert.equal(db.calls.some((c) => /SELECT t.task_id/.test(c.sql)), false);
});

test("non-manager task searches are always limited to their own assignments", async () => {
    const db = taskDb({ rows: [] });
    await runTool(searchTasks, makeCtx(), { due_filter: "overdue" }, { db });
    const listCall = db.calls.find((c) => /SELECT t.task_id/.test(c.sql));
    assert.match(listCall.sql, /ts.username = \?/);
    assert.ok(listCall.params.includes("staff1"));
});

test("fees are hidden without task_fees_view", async () => {
    const result = await runTool(getStaffTasks, makeCtx({ username: "arun" }), { staff_username: "arun" }, { db: taskDb({ rows: sampleTasks }) });
    assert.equal("total" in parse(result).tasks[0], false);
});

test("ambiguous names return every candidate for clarification", async () => {
    const db = createFakeDb([[/FROM branch_mapping bm/, () => [
        { username: "arun1", type: "staff", name: "Arun Pawan", designation: "Accountant", mobile: "9876500001" },
        { username: "arun2", type: "staff", name: "Arun Pawan", designation: "Clerk", mobile: "9876500002" },
    ]]]);
    const data = parse(await runTool(searchStaff, makeCtx(), { search: "Arun Pawan" }, { db }));
    assert.equal(data.count, 2);
    assert.equal("mobile" in data.members[0], false, "contact details need staff_view_manage");
});

test("invalid and injected arguments are rejected", async () => {
    const db = taskDb();
    const bad = await runTool(getStaffTasks, manager(), { staff_username: "arun; DROP TABLE tasks" }, { db });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /Invalid arguments/);

    const injected = await runTool(searchTasks, manager(), { branch_id: "OTHER" }, { db });
    assert.equal(injected.isError, true, "unknown keys such as branch_id are refused");

    const tooMany = await runTool(searchTasks, manager(), { limit: 500 }, { db });
    assert.equal(tooMany.isError, true);
    assert.equal(db.calls.length, 0);
});

test("pagination reports has_more and caps rows", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ task_id: `T${i}`, status: "in process", due_date: "2026-11-01" }));
    const db = taskDb({ rows, agg: { total: 75 } });
    const result = await runTool(searchTasks, manager(), { page: 2 }, { db });
    const data = parse(result);
    assert.equal(data.has_more, true);
    const listCall = db.calls.find((c) => /SELECT t.task_id/.test(c.sql));
    assert.deepEqual(listCall.params.slice(-2), [20, 20], "LIMIT 20 OFFSET 20");
    assert.equal(blocksOf(result).find((b) => b.type === "table").truncated, true);
});

test("party balance uses the ledger balance service and reports Dr/Cr meaning", async () => {
    const db = createFakeDb([[/FROM clients c/, (p) => (p[0] === "BR1" && p[1] === "asish" ? [{ id: "asish", name: "Asish Layek" }] : [])]]);
    let balanceArgs;
    const deps = {
        db,
        getBalance: async (args) => {
            balanceArgs = args;
            return { balance: 12500.5, debit: 40000.5, credit: 27500 };
        },
    };
    const ctx = makeCtx({ permissions: ["finance_balance_view"] });
    const data = parse(await runTool(getPartyBalance, ctx, { party_type: "client", party_id: "asish" }, deps));
    assert.deepEqual(balanceArgs, { branch_id: "BR1", party_id: "asish", party_type: "client" });
    assert.equal(data.balance, 12500.5);
    assert.equal(data.side, "Dr");
    assert.match(data.meaning, /owes the office/);
    assert.equal(data.as_of, "2026-10-19");
});

test("a party from another branch is not found and its balance is never computed", async () => {
    const db = createFakeDb([[/FROM clients c/, () => []]]);
    let called = false;
    const result = await runTool(getPartyBalance, makeCtx({ permissions: ["finance_balance_view"] }), { party_type: "client", party_id: "other_branch_client" }, {
        db,
        getBalance: async () => {
            called = true;
        },
    });
    assert.match(result.content[0].text, /NOT_FOUND/);
    assert.equal(called, false);
});

test("ledger statement keeps full totals when rows are truncated", async () => {
    const statementData = Array.from({ length: 250 }, (_, i) => ({ date: "2026-05-01", particular: `Row ${i}`, type: "sale", invoice_no: "N/A", debit: 100, credit: 0, balance: 100 * (i + 1) }));
    const deps = {
        db: createFakeDb([[/FROM clients c/, () => [{ id: "asish", name: "Asish Layek" }]]]),
        collectLedger: async (opts) => {
            assert.equal(opts.branch_id, "BR1");
            assert.equal(opts.fromDate, "2026-04-01");
            return { openingBalance: 0, statementData, summary: { totalDebit: 25000, totalCredit: 0, closingBalance: 25000 } };
        },
    };
    const result = await runTool(getLedgerStatement, makeCtx({ permissions: ["finance_report"] }), { party_type: "client", party_id: "asish", preset: "this_fy" }, deps);
    const data = parse(result);
    assert.equal(data.closing_balance, 25000);
    assert.equal(data.transaction_count, 250);
    assert.equal(data.truncated, true);
    assert.equal(blocksOf(result).find((b) => b.type === "table").rows.length, 200);
});

test("outstanding balances reuse clientBalanceSql with branch params", async () => {
    const db = createFakeDb([
        [/SELECT COUNT\(\*\) AS total,\s+COALESCE\(SUM\(total_balance\)/, () => [{ total: 3, balance_sum: 45000 }]],
        [/SELECT\s+agg.username/, () => [{ username: "c1", name: "Client One", total_balance: 30000, last_transaction_date: "2026-09-01" }]],
    ]);
    const data = parse(await runTool(getOutstandingBalances, makeCtx({ isAdmin: true }), { side: "debtor" }, { db }));
    assert.equal(data.total_amount, 45000);
    assert.equal(data.total_clients, 3);
    assert.equal(data.has_more, true);
    for (const call of db.calls) assert.equal(call.params[0], "BR1");
});

test("attendance for a single day classifies statuses like the attendance screen", async () => {
    const db = createFakeDb([
        [/FROM branch_mapping bm\s+INNER JOIN users/, () => [
            { username: "a", name: "A" }, { username: "b", name: "B" }, { username: "c", name: "C" }, { username: "d", name: "D" },
        ]],
        [/FROM attendance/, (params) => {
            assert.deepEqual(params.slice(0, 3), ["BR1", "2026-10-19", "2026-10-19"]);
            return [
                { username: "a", date: "2026-10-19", status: "present", in_time: "09:58:00" },
                { username: "b", date: "2026-10-19", status: "leave" },
                { username: "c", date: "2026-10-19", status: "absent" },
            ];
        }],
    ]);
    const data = parse(await runTool(attendanceReport, manager(), { preset: "today" }, { db }));
    assert.deepEqual(data.totals, { present: 1, absent: 1, leave: 1, half_day: 0, not_marked: 1 });
    assert.equal(data.staff.find((s) => s.username === "d").status, "not marked");
});

test("date range filters are applied and future-only ranges rejected", async () => {
    const db = createFakeDb([[/FROM expense_entries ee\s+WHERE/, () => [{ entries: 2, total: 900 }]]]);
    const ctx = makeCtx({ permissions: ["finance_report"] });
    const data = parse(await runTool(expenseReport, ctx, { preset: "last_month", group_by: "month" }, { db }));
    assert.deepEqual(data.period, { from: "2026-09-01", to: "2026-09-30" });
    assert.deepEqual(db.calls[0].params, ["BR1", "2026-09-01", "2026-09-30"]);

    const future = await runTool(attendanceReport, manager(), { from: "2026-11-01", to: "2026-11-05" }, { db: createFakeDb() });
    assert.match(future.content[0].text, /future/);
});

test("database errors never leak SQL or driver messages", async () => {
    const db = { query: async () => { throw Object.assign(new Error("ER_PARSE_ERROR near 'SELECT secret FROM users'"), { code: "ER_PARSE_ERROR" }); } };
    const audits = [];
    const result = await runTool(searchStaff, makeCtx(), {}, { db }, { onAudit: (a) => audits.push(a) });
    assert.equal(result.isError, true);
    assert.doesNotMatch(result.content[0].text, /SELECT|ER_PARSE/);
    assert.equal(audits[0].status, "error");
});

test("slow tools time out", async () => {
    const db = { query: () => new Promise(() => {}) };
    const result = await runTool(searchStaff, makeCtx(), {}, { db }, { timeoutMs: 50 });
    assert.match(result.content[0].text, /too long/);
});

test("large results are shrunk for the model with an explicit marker", () => {
    const big = { summary: { total: 5000 }, rows: Array.from({ length: 5000 }, (_, i) => ({ id: i, name: "x".repeat(20) })) };
    const text = truncateForModel(big, 4000);
    assert.ok(text.length <= 4000);
    const parsed = JSON.parse(text);
    assert.equal(parsed.summary.total, 5000, "summaries survive truncation");
    assert.ok(parsed._truncated);
});
