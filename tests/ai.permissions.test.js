import test from "node:test";
import assert from "node:assert/strict";
import { resolveUserAccess, hasPermission } from "../helpers/permissionCheck.js";
import { toolsForContext } from "../ai/tools/index.js";
import { runTool } from "../ai/mcp/runTool.js";
import { getPartyBalance } from "../ai/tools/finance.js";
import { getStaffTasks } from "../ai/tools/tasks.js";
import { createFakeDb, makeCtx } from "./helpers/aiFakes.js";

const names = (ctx) => toolsForContext(ctx).map((t) => t.name).sort();

test("admin mapping gets every permission", async () => {
    const db = createFakeDb([[/FROM branch_mapping/, () => [{ type: "admin", permission_role_id: null, custom_permissions: null }]]]);
    const access = await resolveUserAccess(db, "boss", "BR1");
    assert.equal(access.isAdmin, true);
    assert.equal(hasPermission(access, "finance_balance_view"), true);
});

test("role + custom permissions count only while active in permission_option", async () => {
    const db = createFakeDb([
        [/FROM branch_mapping/, () => [{ type: "staff", permission_role_id: "R1", custom_permissions: '{"permissions":["finance_report"]}' }]],
        [/FROM permission_role/, () => [{ permissions_assigned: '{"permissions":["task_summary_view","retired_key"]}' }]],
        [/FROM permission_option/, (params) => params.filter((k) => k !== "retired_key").map((k) => ({ p_option_id: k }))],
    ]);
    const access = await resolveUserAccess(db, "s1", "BR1");
    assert.equal(access.isAdmin, false);
    assert.deepEqual([...access.permissions].sort(), ["finance_report", "task_summary_view"]);
});

test("unmapped user has no access", async () => {
    const access = await resolveUserAccess(createFakeDb(), "ghost", "BR1");
    assert.equal(access.isMapped, false);
    assert.equal(access.permissions.size, 0);
});

test("finance and report tools are not registered without permissions", () => {
    const plain = names(makeCtx());
    for (const t of ["get_party_balance", "get_outstanding_balances", "get_ledger_statement", "expense_report", "sales_report", "dashboard_summary", "search_parties", "task_summary"]) {
        assert.equal(plain.includes(t), false, `${t} must be hidden`);
    }
    assert.ok(plain.includes("search_tasks"));

    const finance = names(makeCtx({ permissions: ["finance_balance_view"] }));
    assert.ok(finance.includes("get_party_balance"));
    assert.ok(!finance.includes("get_ledger_statement"));

    const admin = names(makeCtx({ isAdmin: true }));
    assert.ok(admin.includes("get_ledger_statement") && admin.includes("dashboard_summary"));
});

test("handler re-checks permission even if called directly", async () => {
    let balanceCalled = false;
    const result = await runTool(getPartyBalance, makeCtx(), { party_type: "client", party_id: "C1" }, {
        db: createFakeDb(),
        getBalance: async () => {
            balanceCalled = true;
            return { balance: 1, debit: 1, credit: 0 };
        },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /permission/);
    assert.equal(balanceCalled, false);
});

test("staff without staff_view_manage cannot read a colleague's tasks", async () => {
    const db = createFakeDb();
    const result = await runTool(getStaffTasks, makeCtx(), { staff_username: "colleague" }, { db });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /DENIED/);
    assert.equal(db.calls.length, 0, "no query may run for a denied request");
});
