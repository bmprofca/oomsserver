import test from "node:test";
import assert from "node:assert/strict";
import { createAiRateLimiter } from "../middleware/aiRateLimit.js";

test("per-minute window, in-flight guard and daily cap (limits from branch settings)", () => {
    let now = Date.parse("2026-10-19T05:00:00Z");
    const limiter = createAiRateLimiter({ now: () => now });
    const limits = { perMinute: 2, perDay: 3 };

    const a = limiter.check("BR1:u1", limits);
    assert.equal(a.ok, true);
    assert.equal(limiter.check("BR1:u1", limits).reason, "IN_FLIGHT", "duplicate submission blocked");
    a.release();

    limiter.check("BR1:u1", limits).release();
    const third = limiter.check("BR1:u1", limits);
    assert.equal(third.reason, "PER_MINUTE");
    assert.ok(third.retryAfter > 0);

    assert.equal(limiter.check("BR2:u1", limits).ok, true, "keys are per branch + user");

    now += 61000;
    limiter.check("BR1:u1", limits).release();
    assert.equal(limiter.check("BR1:u1", limits).reason, "PER_DAY");

    now += 24 * 3600 * 1000;
    assert.equal(limiter.check("BR1:u1", limits).ok, true, "daily counter resets");
});
