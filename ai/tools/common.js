import * as z from "zod";
import { DATE_PRESETS, resolveDateRange } from "../dateRange.js";

/**
 * Shared building blocks for AI tools.
 *
 * SECURITY RULE: no tool schema may accept branch_id, the acting username or any
 * permission flag. Handlers read those only from the frozen server-side `ctx`.
 */

export class ToolError extends Error {
    /** @param {"NOT_FOUND"|"DENIED"|"INVALID"|"AMBIGUOUS"} code */
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

export const TASK_STATUSES = [
    "in process",
    "pending from client",
    "pending from department",
    "complete",
    "cancel",
];
export const ACTIVE_TASK_STATUSES = TASK_STATUSES.slice(0, 3);

// Identifiers in OOMS are short alphanumeric strings (RANDOM_STRING / UNIQUE_RANDOM_STRING)
// or usernames; keep them strict so free text can never reach an ID slot.
export const idString = (label) =>
    z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_.@+-]+$/, `${label} has invalid characters`);

export const searchString = z.string().trim().min(1).max(80);

export const limitField = z.number().int().min(1).max(50).default(20)
    .describe("Maximum rows to return (1-50)");
export const pageField = z.number().int().min(1).max(20).default(1)
    .describe("Page number (1-20)");

export const dateRangeFields = {
    preset: z.enum(DATE_PRESETS).optional()
        .describe("Named period resolved in Asia/Kolkata; weeks start Monday, FY starts 1 April"),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date YYYY-MM-DD (inclusive)"),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date YYYY-MM-DD (inclusive)"),
};

export function resolveRange(args, ctx, { maxDays = 186, defaultPreset = "this_month" } = {}) {
    try {
        return resolveDateRange(
            { preset: args.preset, from: args.from, to: args.to },
            { today: ctx.today, maxDays, defaultPreset }
        );
    } catch (err) {
        throw new ToolError("INVALID", err.message);
    }
}

/** Staff without staff_view_manage only see their own tasks / attendance (approved design). */
export function canSeeAllStaff(ctx) {
    return Boolean(ctx.isAdmin || ctx.permissions.has("staff_view_manage"));
}

export function has(ctx, key) {
    return Boolean(ctx.isAdmin || ctx.permissions.has(key));
}

export function assertStaffScope(ctx, staffUsername) {
    if (staffUsername && staffUsername !== ctx.username && !canSeeAllStaff(ctx)) {
        throw new ToolError("DENIED", "You can only view your own tasks and attendance.");
    }
}

export function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

export function ymd(value) {
    if (!value) return null;
    return String(value).slice(0, 10);
}

/** OD / DT / D7 / FT — same buckets as getDueDateCategory in routes/report.js. */
export function dueCategory(dueDate, today) {
    const due = ymd(dueDate);
    if (!due) return null;
    if (due < today) return "OD";
    if (due === today) return "DT";
    const diff = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
    return diff <= 7 ? "D7" : "FT";
}

export const DUE_CATEGORY_LABELS = {
    OD: "Overdue",
    DT: "Due today",
    D7: "Due in 7 days",
    FT: "Future",
};

/** Verify a username is an active, accepted member of this branch. */
export async function loadBranchMember(db, branchId, username) {
    const [rows] = await db.query(
        `SELECT bm.username, bm.type, bm.designation,
                (SELECT p.name FROM profile p WHERE p.username = bm.username ORDER BY p.id DESC LIMIT 1) AS name
         FROM branch_mapping bm
         WHERE bm.branch_id = ? AND bm.username = ?
           AND bm.is_deleted = '0' AND bm.status = '1' AND bm.is_accepted = '1'
         LIMIT 1`,
        [branchId, username]
    );
    return rows?.[0] || null;
}
