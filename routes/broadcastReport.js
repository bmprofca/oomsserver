import express from "express";
import pool from "../db.js";
import { auth, checkSubscription, requireFeature, validateBranch } from "../middleware/auth.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { buildBroadcastReportSql, normalizeBroadcastReportQuery } from "../helpers/broadcastReport.js";

const router = express.Router();

router.get("/", auth, validateBranch, checkSubscription, requireFeature("core"), requirePermission("broadcast_send"), async (req, res) => {
    try {
        const query = normalizeBroadcastReportQuery(req.query);
        const built = buildBroadcastReportSql(query);
        const branchIndex = built.params.indexOf("__BRANCH__");
        built.params[branchIndex] = req.branch_id;
        const offset = (query.page - 1) * query.limit;
        const [rows] = await pool.query(`${built.sql} LIMIT ? OFFSET ?`, [...built.params, query.limit, offset]);
        const countSql = built.sql.replace(/SELECT[\s\S]*?FROM /, "SELECT COUNT(*) AS total FROM ").replace(/ORDER BY[\s\S]*$/, "");
        const [countRows] = await pool.query(countSql, built.params);
        return res.json({
            success: true,
            data: rows,
            pagination: { page: query.page, limit: query.limit, total: Number(countRows?.[0]?.total || 0) },
            provider_outcomes: query.channel === "email" || query.channel === "sms" ? "persisted_delivery_rows" : "provider_required",
        });
    } catch (error) {
        const status = /must be|YYYY-MM-DD/.test(error?.message || "") ? 400 : 500;
        return res.status(status).json({ success: false, message: error?.message || "Failed to fetch broadcast report" });
    }
});

export default router;
