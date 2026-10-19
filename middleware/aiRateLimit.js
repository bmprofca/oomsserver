/**
 * In-memory rate limit for the AI assistant, keyed by branch + username.
 * - per-minute sliding window and per-day counter (limits come from the branch's settings)
 * - one in-flight chat per user (blocks duplicate submissions)
 * Per pm2 process: with N instances the effective limit is N×.
 */

export function createAiRateLimiter({ now = () => Date.now() } = {}) {
    const windows = new Map(); // key -> { minute: number[], day: string, dayCount: number }
    const inFlight = new Set();

    function dayKey(ts) {
        return new Date(ts).toISOString().slice(0, 10);
    }

    function check(key, { perMinute, perDay }) {
        const ts = now();
        const entry = windows.get(key) || { minute: [], day: dayKey(ts), dayCount: 0 };
        entry.minute = entry.minute.filter((t) => ts - t < 60000);
        if (entry.day !== dayKey(ts)) {
            entry.day = dayKey(ts);
            entry.dayCount = 0;
        }
        if (inFlight.has(key)) return { ok: false, reason: "IN_FLIGHT", message: "Please wait for the current answer to finish." };
        if (entry.minute.length >= perMinute) {
            const retryAfter = Math.ceil((60000 - (ts - entry.minute[0])) / 1000);
            windows.set(key, entry);
            return { ok: false, reason: "PER_MINUTE", retryAfter, message: "Too many questions in a short time. Please wait a moment." };
        }
        if (entry.dayCount >= perDay) {
            windows.set(key, entry);
            return { ok: false, reason: "PER_DAY", message: "Daily assistant limit reached. Please try again tomorrow." };
        }
        entry.minute.push(ts);
        entry.dayCount += 1;
        windows.set(key, entry);
        inFlight.add(key);
        return { ok: true, release: () => inFlight.delete(key) };
    }

    // Occasional cleanup so the map does not grow without bound.
    function sweep() {
        const ts = now();
        for (const [key, entry] of windows) {
            if (!inFlight.has(key) && entry.minute.every((t) => ts - t >= 60000) && entry.day !== dayKey(ts)) {
                windows.delete(key);
            }
        }
    }

    return { check, sweep, size: () => windows.size };
}

/**
 * Express middleware. Must run after auth, validateBranch and the branch-settings loader
 * (req.aiSettings) so the key and limits are trusted.
 */
export function aiRateLimit(limiter) {
    const timer = setInterval(() => limiter.sweep(), 10 * 60 * 1000);
    timer.unref?.();
    return (req, res, next) => {
        const key = `${req.branch_id}:${req.headers.username}`;
        const result = limiter.check(key, {
            perMinute: req.aiSettings?.rate_per_min ?? 6,
            perDay: req.aiSettings?.rate_per_day ?? 200,
        });
        if (!result.ok) {
            if (result.retryAfter) res.setHeader("Retry-After", String(result.retryAfter));
            return res.status(429).json({ success: false, code: "AI_RATE_LIMITED", reason: result.reason, message: result.message });
        }
        let released = false;
        const release = () => {
            if (!released) {
                released = true;
                result.release();
            }
        };
        res.on("finish", release);
        res.on("close", release);
        next();
    };
}
