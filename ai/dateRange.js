/**
 * Natural-language period → explicit [from, to] calendar dates (YYYY-MM-DD, inclusive).
 * Always computed against "today" in Asia/Kolkata (same as TODAY_DATE in helpers/function.js).
 * Weeks start on Monday; the financial year starts on 1 April.
 */

export const DATE_PRESETS = [
    "today",
    "yesterday",
    "this_week",
    "last_week",
    "this_month",
    "last_month",
    "this_quarter",
    "last_quarter",
    "this_fy",
    "last_fy",
    "last_7_days",
    "last_30_days",
];

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's calendar date in Asia/Kolkata as YYYY-MM-DD. */
export function todayIst(now = new Date()) {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(now);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    return `${get("year")}-${get("month")}-${get("day")}`;
}

// Pure calendar arithmetic on UTC dates so the host timezone never shifts a day.
function parseYmd(ymd) {
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
}

function fmt(date) {
    return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() + days);
    return next;
}

export function isValidIsoDate(value) {
    if (typeof value !== "string" || !ISO_RE.test(value)) return false;
    const d = parseYmd(value);
    return fmt(d) === value;
}

export function daysBetweenInclusive(from, to) {
    return Math.round((parseYmd(to) - parseYmd(from)) / 86400000) + 1;
}

function fyStartYear(date) {
    return date.getUTCMonth() >= 3 ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
}

/** Financial-year label for a date, e.g. "FY 2026-27". */
export function fyLabel(ymd) {
    const start = fyStartYear(parseYmd(ymd));
    return `FY ${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

function presetRange(preset, today) {
    const t = parseYmd(today);
    const y = t.getUTCFullYear();
    const m = t.getUTCMonth();
    switch (preset) {
        case "today":
            return [t, t];
        case "yesterday": {
            const d = addDays(t, -1);
            return [d, d];
        }
        case "this_week": {
            const offset = (t.getUTCDay() + 6) % 7; // Monday = 0
            return [addDays(t, -offset), t];
        }
        case "last_week": {
            const offset = (t.getUTCDay() + 6) % 7;
            const thisMonday = addDays(t, -offset);
            return [addDays(thisMonday, -7), addDays(thisMonday, -1)];
        }
        case "this_month":
            return [new Date(Date.UTC(y, m, 1)), t];
        case "last_month":
            return [new Date(Date.UTC(y, m - 1, 1)), new Date(Date.UTC(y, m, 0))];
        case "this_quarter": {
            // Indian FY quarters: Apr-Jun, Jul-Sep, Oct-Dec, Jan-Mar
            const qStartMonth = m - (((m - 3) % 3) + 3) % 3;
            return [new Date(Date.UTC(y, qStartMonth, 1)), t];
        }
        case "last_quarter": {
            const qStartMonth = m - (((m - 3) % 3) + 3) % 3;
            return [
                new Date(Date.UTC(y, qStartMonth - 3, 1)),
                new Date(Date.UTC(y, qStartMonth, 0)),
            ];
        }
        case "this_fy": {
            const start = fyStartYear(t);
            return [new Date(Date.UTC(start, 3, 1)), t];
        }
        case "last_fy": {
            const start = fyStartYear(t) - 1;
            return [new Date(Date.UTC(start, 3, 1)), new Date(Date.UTC(start + 1, 2, 31))];
        }
        case "last_7_days":
            return [addDays(t, -6), t];
        case "last_30_days":
            return [addDays(t, -29), t];
        default:
            return null;
    }
}

/**
 * @param {{preset?: string, from?: string, to?: string}} input
 * @param {{today?: string, maxDays?: number, defaultPreset?: string}} options
 * @returns {{from: string, to: string, label: string, days: number}}
 * @throws Error with code INVALID_DATE_RANGE
 */
export function resolveDateRange(input = {}, { today = todayIst(), maxDays = 186, defaultPreset = "this_month" } = {}) {
    const fail = (message) => {
        const err = new Error(message);
        err.code = "INVALID_DATE_RANGE";
        throw err;
    };

    const { preset, from, to } = input || {};
    let fromYmd;
    let toYmd;
    let label;

    if (from || to) {
        const f = from || to;
        const tt = to || from;
        if (!isValidIsoDate(f) || !isValidIsoDate(tt)) fail("Dates must be valid YYYY-MM-DD values.");
        fromYmd = f;
        toYmd = tt;
        label = fromYmd === toYmd ? fromYmd : `${fromYmd} to ${toYmd}`;
    } else {
        const key = preset || defaultPreset;
        const range = presetRange(key, today);
        if (!range) fail(`Unknown period "${key}".`);
        fromYmd = fmt(range[0]);
        toYmd = fmt(range[1]);
        label = key.replace(/_/g, " ");
    }

    if (fromYmd > toYmd) fail("The start date must be on or before the end date.");
    const days = daysBetweenInclusive(fromYmd, toYmd);
    if (days > maxDays) fail(`Date range is too long (${days} days). The maximum is ${maxDays} days.`);

    return { from: fromYmd, to: toYmd, label, days };
}
