import pool from "../db.js";
import { setNeronEventHandler } from "./neronVoipService.js";

function normalizeStatus(payload) {
    if (payload?.event === "invite") return "ringing";
    if (payload?.event === "extension_status" && ["InUse", "Busy"].includes(payload.status)) return "connected";
    if (payload?.event === "extension_status" && payload.status === "Idle") return "completed";
    return "";
}

export function registerNeronEventForwarder(io) {
    setNeronEventHandler(async (payload) => {
        const status = normalizeStatus(payload);
        const providerCallId = String(payload?.callid || payload?.called || "").trim();
        if (!status || !providerCallId) return;

        try {
            const updates = status === "connected"
                ? "status = ?, answered_at = COALESCE(answered_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP"
                : status === "completed"
                    ? "status = ?, ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP"
                    : "status = ?, updated_at = CURRENT_TIMESTAMP";
            const [result] = await pool.query(
                `UPDATE voip_calls SET ${updates} WHERE provider_call_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`,
                [status, providerCallId]
            );
            if (!result.affectedRows) return;

            const [rows] = await pool.query(
                `SELECT call_id, branch_id, provider_call_id, status, caller, callee, answered_at, ended_at
                 FROM voip_calls WHERE provider_call_id = ? ORDER BY id DESC LIMIT 1`,
                [providerCallId]
            );
            const call = rows[0];
            if (call) {
                io.to(`branch:${call.branch_id}`).emit("voip:call.updated", call);
                io.to(`user:${call.username}`).emit("voip:call.updated", call);
            }
        } catch (error) {
            console.error("Neron event persistence error:", error.message);
        }
    });
}
