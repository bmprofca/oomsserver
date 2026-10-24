import test from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { buildExecutiveSummaryPdf, normalizeConfig, normalizePeriod, normalizeSections, validateEmails, MAX_RECIPIENT_EMAILS } from "../services/executiveSummaryService.js";

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

test("executive summary PDF includes a valid statistical overview", async () => {
    const pdf = await buildExecutiveSummaryPdf({
        meta: {
            branch_name: "Test branch",
            period: { from_date: "2026-09-01", to_date: "2026-09-30" },
            timezone: "Asia/Kolkata",
        },
        totals: {
            tasks_completed: 3,
            new_tasks: 2,
            sales: 12000,
            collections: 8000,
            expenses: 1500,
            unpaid_debtors: 4,
            due_tasks: 2,
            clients_without_service: 1,
        },
        sections: {
            tasks_completed: { rows: [{ username: "staff1", staff_name: "Staff One", completed_count: 3 }] },
            new_tasks: { rows: [{ username: "staff1", staff_name: "Staff One", new_task_count: 2 }] },
            sales: { rows: [{ username: "staff1", staff_name: "Staff One", sale_amount: 12000 }] },
            collections: { rows: [{ username: "staff1", staff_name: "Staff One", collection_amount: 8000 }] },
            expenses: { rows: [{ username: "staff1", staff_name: "Staff One", expense_amount: 1500 }] },
            due_tasks: { rows: [{ staff_username: "staff1", staff_name: "Staff One" }, { staff_username: "staff1", staff_name: "Staff One" }] },
        },
    });

    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    assert.ok(pdf.length > 1000);
    const pageStreams = [...pdf.toString("latin1").matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)]
        .map((match) => inflateSync(Buffer.from(match[1], "latin1")).toString("latin1"));
    assert.ok(pageStreams.length >= 2, "PDF should have a dashboard cover and a detail page");
    const dashboard = pageStreams[0];
    assert.ok(dashboard.includes("0.11764705882352941 0.22745098039215686 0.5411764705882353 scn"), "dashboard should have its colored header");
    assert.ok(dashboard.includes("0.058823529411764705 0.4627450980392157 0.43137254901960786 scn"), "dashboard should include teal chart bars");
    assert.ok(dashboard.includes("0.9176470588235294 0.34509803921568627 0.047058823529411764 scn"), "dashboard should include orange chart bars");
    assert.ok((dashboard.match(/ c\n/g) || []).length > 100, "dashboard should contain vector chart and card graphics");
    assert.ok(pageStreams.some((page) => page.includes("0.9921568627450981 0.9490196078431372 0.9725490196078431 scn")), "detail pages should include a section-specific tinted highlight");
});

test("executive summary allows at most 5 recipient emails", () => {
    assert.equal(MAX_RECIPIENT_EMAILS, 5);
    const five = ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"];
    assert.deepEqual(validateEmails(five), five);
    assert.throws(
        () => validateEmails([...five, "f@x.com"]),
        (error) => error.statusCode === 400 && /maximum of 5 recipient emails/.test(error.message)
    );
});

test("executive summary counts recipients after trimming, lowercasing and de-duplicating", () => {
    const emails = validateEmails(" A@x.com, a@x.com; b@x.com c@x.com,d@x.com e@x.com ,E@X.COM");
    assert.deepEqual(emails, ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"]);
});

test("executive summary still rejects invalid or missing recipients", () => {
    assert.throws(() => validateEmails(["not-an-email"]), (error) => error.statusCode === 400);
    assert.throws(() => validateEmails([], { required: true }), (error) => error.statusCode === 400);
});

test("executive summary config has no timezone setting (India-only, always IST)", () => {
    const config = normalizeConfig({ config_id: "es_1", branch_id: "b1", timezone: "America/New_York", send_hour: 9, send_minute: 30 });
    assert.equal("timezone" in config, false);
    assert.equal(config.send_hour, 9);
    assert.equal(config.send_minute, 30);
});
