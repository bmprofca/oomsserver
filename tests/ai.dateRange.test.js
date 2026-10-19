import test from "node:test";
import assert from "node:assert/strict";
import { resolveDateRange, todayIst, fyLabel, isValidIsoDate } from "../ai/dateRange.js";

const T = "2026-10-19"; // Monday

test("presets resolve to explicit inclusive ranges", () => {
    const r = (preset, today = T) => resolveDateRange({ preset }, { today, maxDays: 400 });
    assert.deepEqual([r("today").from, r("today").to], [T, T]);
    assert.deepEqual([r("yesterday").from, r("yesterday").to], ["2026-10-18", "2026-10-18"]);
    assert.deepEqual([r("this_week").from, r("this_week").to], ["2026-10-19", T]);
    assert.deepEqual([r("last_week").from, r("last_week").to], ["2026-10-12", "2026-10-18"]);
    assert.deepEqual([r("this_month").from, r("this_month").to], ["2026-10-01", T]);
    assert.deepEqual([r("last_month").from, r("last_month").to], ["2026-09-01", "2026-09-30"]);
    assert.deepEqual([r("last_7_days").from, r("last_7_days").to], ["2026-10-13", T]);
    assert.deepEqual([r("this_quarter").from, r("this_quarter").to], ["2026-10-01", T]);
    assert.deepEqual([r("last_quarter").from, r("last_quarter").to], ["2026-07-01", "2026-09-30"]);
});

test("financial year starts on 1 April", () => {
    const fy = (today) => resolveDateRange({ preset: "this_fy" }, { today, maxDays: 400 });
    assert.equal(fy("2026-10-19").from, "2026-04-01");
    assert.equal(fy("2027-02-10").from, "2026-04-01");
    assert.equal(fy("2026-04-01").from, "2026-04-01");
    assert.equal(fy("2026-03-31").from, "2025-04-01");
    const last = resolveDateRange({ preset: "last_fy" }, { today: "2026-10-19", maxDays: 400 });
    assert.deepEqual([last.from, last.to], ["2025-04-01", "2026-03-31"]);
    assert.equal(fyLabel("2026-10-19"), "FY 2026-27");
    assert.equal(fyLabel("2027-01-05"), "FY 2026-27");
});

test("January quarter and month boundaries", () => {
    const q = resolveDateRange({ preset: "last_quarter" }, { today: "2027-01-15", maxDays: 400 });
    assert.deepEqual([q.from, q.to], ["2026-10-01", "2026-12-31"]);
    const m = resolveDateRange({ preset: "last_month" }, { today: "2027-01-15" });
    assert.deepEqual([m.from, m.to], ["2026-12-01", "2026-12-31"]);
    const leap = resolveDateRange({ preset: "last_month" }, { today: "2028-03-02" });
    assert.equal(leap.to, "2028-02-29");
});

test("explicit dates are validated and capped", () => {
    assert.throws(() => resolveDateRange({ from: "2026-02-30", to: "2026-03-01" }), /valid/);
    assert.throws(() => resolveDateRange({ from: "2026-05-01", to: "2026-04-01" }), /on or before/);
    assert.throws(() => resolveDateRange({ from: "2025-01-01", to: "2026-01-01" }, { maxDays: 186 }), /too long/);
    assert.equal(resolveDateRange({ from: "2026-01-01" }).to, "2026-01-01");
    assert.equal(isValidIsoDate("2026-13-01"), false);
});

test("today is computed in Asia/Kolkata, not the host timezone", () => {
    // 2026-10-18 20:00 UTC is already 2026-10-19 01:30 in India.
    assert.equal(todayIst(new Date("2026-10-18T20:00:00Z")), "2026-10-19");
    assert.equal(todayIst(new Date("2026-10-18T18:00:00Z")), "2026-10-18");
});
