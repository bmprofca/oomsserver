import { resolveUserAccess } from "../../helpers/permissionCheck.js";
import { ACTION_DEFINITIONS } from "./definitions.js";
import { cancelPendingAction, claimPendingAction, finishPendingAction, getPendingAction } from "./pending.js";

/**
 * Confirm or cancel a pending write action. Used by the in-app chat card
 * (POST /ai/actions/:id/confirm — a person clicks Confirm) and by the connector tool
 * confirm_action (the MCP client asks its user before calling it).
 *
 * Re-checked at confirmation time, not just when the AI proposed it:
 *   - the action belongs to this user + branch, is still pending and not expired
 *   - read-write mode is still on for the source (branch setting or connector)
 *   - the user still has the permission for this action
 * The pending → executing claim is atomic, so an action can never run twice.
 */

const MESSAGES = {
    NOT_FOUND: "This action was not found.",
    expired: "This action expired. Ask the assistant again.",
    cancelled: "This action was cancelled.",
    done: "This action was already completed.",
    partial: "This action was already completed.",
    failed: "This action was already attempted.",
    executing: "This action is already being sent.",
    MODE_OFF: "Read-write mode is switched off, so nothing was sent.",
    DENIED: "You no longer have permission for this action, so nothing was sent.",
};

export async function confirmAction({ db, senders, actionId, branchId, username, isModeOn, onAudit = () => {} }) {
    const action = await getPendingAction(db, { actionId, branchId, username });
    if (!action) return { ok: false, code: "NOT_FOUND", message: MESSAGES.NOT_FOUND };
    if (action.status !== "pending") return { ok: false, code: "NOT_PENDING", status: action.status, message: MESSAGES[action.status] || MESSAGES.done, result: action.result };

    const def = ACTION_DEFINITIONS[action.type];
    if (!def) return { ok: false, code: "NOT_FOUND", message: MESSAGES.NOT_FOUND };
    if (!(await isModeOn(action.source))) return { ok: false, code: "MODE_OFF", message: MESSAGES.MODE_OFF };

    const access = await resolveUserAccess(db, username, branchId);
    const ctx = { username, branch_id: branchId, isAdmin: Boolean(access?.isAdmin), permissions: access?.permissions || new Set() };
    if (!access?.isMapped || !def.allowed(ctx)) return { ok: false, code: "DENIED", message: MESSAGES.DENIED };

    if (!(await claimPendingAction(db, { actionId, branchId, username }))) {
        const latest = await getPendingAction(db, { actionId, branchId, username });
        return { ok: false, code: "NOT_PENDING", status: latest?.status, message: MESSAGES[latest?.status] || MESSAGES.expired, result: latest?.result };
    }

    const [[actor]] = await db.query("SELECT name FROM profile WHERE username = ? ORDER BY id DESC LIMIT 1", [username]);
    const started = Date.now();
    let result;
    try {
        result = await def.execute(action.payload, { senders, branchId, actor: username, actorName: actor?.name || "Your office" });
    } catch (_) {
        result = { status: "failed", message: "The action could not be completed.", channels: {} };
    }
    await finishPendingAction(db, { actionId, status: result.status, result });
    onAudit({
        tool: `action:${action.type}`.slice(0, 80),
        args: { action_id: actionId, channels: Object.keys(result.channels || {}) },
        status: result.status === "failed" ? "error" : "ok",
        durationMs: Date.now() - started,
        rowCount: null,
        errorCode: result.status === "failed" ? "SEND_FAILED" : null,
    });
    return { ok: result.status !== "failed", code: result.status.toUpperCase(), status: result.status, message: result.message, result };
}

export async function cancelAction({ db, actionId, branchId, username }) {
    if (await cancelPendingAction(db, { actionId, branchId, username })) return { ok: true, status: "cancelled", message: "Cancelled. Nothing was sent." };
    const action = await getPendingAction(db, { actionId, branchId, username });
    if (!action) return { ok: false, code: "NOT_FOUND", message: MESSAGES.NOT_FOUND };
    return { ok: false, code: "NOT_PENDING", status: action.status, message: MESSAGES[action.status] || MESSAGES.done };
}
