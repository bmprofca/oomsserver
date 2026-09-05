import express from "express";
import crypto from "crypto";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { dial, getNeronStatus, hangup } from "../services/neronVoipService.js";

const router = express.Router();

function usernameFromReq(req) {
    return req.headers["username"] || req.headers["Username"] || "";
}

function normalizePhone(value) {
    const phone = String(value || "").trim().replace(/[\s().-]/g, "");
    if (!/^\+?[1-9]\d{6,14}$/.test(phone)) return "";
    return phone;
}

router.get("/status", auth, validateBranch, async (_req, res) => {
    return res.json({ success: true, data: getNeronStatus() });
});

router.post("/call", auth, validateBranch, async (req, res) => {
    const branchId = req.branch_id;
    const username = usernameFromReq(req);
    const callee = normalizePhone(req.body?.callee || req.body?.number);
    const caller = String(process.env.NERON_CALLER_EXTENSION || "").trim();
    const dialpermission = String(process.env.NERON_DIAL_PERMISSION || "").trim();

    if (!caller) {
        return res.status(503).json({ success: false, code: "VOIP_CALLER_NOT_CONFIGURED", message: "VOIP caller extension is not configured" });
    }
    if (!callee) {
        return res.status(400).json({ success: false, code: "INVALID_PHONE_NUMBER", message: "A valid destination phone number is required" });
    }

    const callId = `ooms-${crypto.randomUUID()}`;
    try {
        await pool.query(
            `INSERT INTO voip_calls (call_id, branch_id, username, callee, caller, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'queued', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [callId, branchId, username, callee, caller]
        );

        const providerResponse = await dial({ caller, callee, dialpermission });
        const providerCallId = String(providerResponse.callid || "");
        await pool.query(
            `UPDATE voip_calls SET provider_call_id = ?, status = 'initiated', updated_at = CURRENT_TIMESTAMP WHERE call_id = ? AND branch_id = ?`,
            [providerCallId || null, callId, branchId]
        );

        return res.status(201).json({
            success: true,
            message: "Call request sent",
            data: { call_id: callId, provider_call_id: providerCallId, caller, callee, status: "initiated" },
        });
    } catch (error) {
        await pool.query(
            `UPDATE voip_calls SET status = 'failed', failure_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE call_id = ? AND branch_id = ?`,
            [error.message || "Neron call request failed", callId, branchId]
        ).catch(() => {});
        const status = error.code === "VOIP_NOT_CONFIGURED" || error.code === "VOIP_DISABLED" ? 503 : 502;
        return res.status(status).json({ success: false, code: error.code || "VOIP_PROVIDER_ERROR", message: error.message || "Unable to start call" });
    }
});

router.post("/calls/:callId/hangup", auth, validateBranch, async (req, res) => {
    const [rows] = await pool.query(
        `SELECT provider_call_id FROM voip_calls WHERE call_id = ? AND branch_id = ? LIMIT 1`,
        [req.params.callId, req.branch_id]
    );
    if (!rows.length || !rows[0].provider_call_id) {
        return res.status(404).json({ success: false, message: "Call not found" });
    }

    try {
        const data = await hangup({ callid: rows[0].provider_call_id });
        await pool.query(
            `UPDATE voip_calls SET status = 'cancelled', ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE call_id = ? AND branch_id = ?`,
            [req.params.callId, req.branch_id]
        );
        return res.json({ success: true, data });
    } catch (error) {
        return res.status(502).json({ success: false, code: error.code || "VOIP_PROVIDER_ERROR", message: error.message || "Unable to hang up call" });
    }
});

router.get("/calls", auth, validateBranch, async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const [rows] = await pool.query(
        `SELECT call_id, provider_call_id, username, callee, caller, status, failure_reason, created_at, answered_at, ended_at, duration_seconds
         FROM voip_calls WHERE branch_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [req.branch_id, limit, offset]
    );
    return res.json({ success: true, data: rows });
});

export default router;
