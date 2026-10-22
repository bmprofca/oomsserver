import test from "node:test";
import assert from "node:assert/strict";
import { normalizePeriod, normalizeSections } from "../services/executiveSummaryService.js";

test("executive summary normalizes the previous completed month", () => {
    const period = normalizePeriod({
        scheduleType: "monthly",
        timezone: "Asia/Kolkata",
    });

    assert.match(period.start, /^\d{4}-\d{2}-01$/);
    assert.match(period.end, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(period.start < period.end);
});

test("executive summary normalizes a previous completed week", () => {
    const period = normalizePeriod({
        scheduleType: "weekly",
        timezone: "Asia/Kolkata",
        weekStartsOn: 1,
    });

    const start = new Date(`${period.start}T00:00:00Z`);
    const end = new Date(`${period.end}T00:00:00Z`);
    assert.equal(Math.round((end - start) / 86400000), 6);
});

test("executive summary keeps only supported section options", () => {
    const sections = normalizeSections({
        sales: { enabled: false },
        due_tasks: { mode: "due_in_period" },
        unpaid_debtors: { sort: "last_payment_asc" },
        unknown: { enabled: true },
    });

    assert.equal(sections.sales.enabled, false);
    assert.equal(sections.due_tasks.mode, "due_in_period");
    assert.equal(sections.unpaid_debtors.sort, "last_payment_asc");
    assert.equal(sections.unknown, undefined);
    assert.equal(Object.keys(sections).length, 8);
});
