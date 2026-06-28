import express from "express";
import pool from "../db.js";
import { GET_BALANCE } from "../helpers/function.js";
import { validateClientSession } from "../middleware/validateClientSession.js";

const router = express.Router();

router.get("/dashboard", validateClientSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.client_username;

        const [balanceResult, taskResult, firmResult] = await Promise.all([
            GET_BALANCE({
                branch_id,
                party_id: username,
                party_type: "client",
            }),
            pool.query(
                `SELECT
                    COUNT(*) AS total,
                    COALESCE(SUM(CASE WHEN status = 'in process' THEN 1 ELSE 0 END), 0) AS in_process,
                    COALESCE(SUM(CASE WHEN status = 'pending from client' THEN 1 ELSE 0 END), 0) AS pending_from_client,
                    COALESCE(SUM(CASE WHEN status = 'pending from department' THEN 1 ELSE 0 END), 0) AS pending_from_department,
                    COALESCE(SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END), 0) AS complete,
                    COALESCE(SUM(CASE WHEN status = 'cancel' THEN 1 ELSE 0 END), 0) AS cancel
                 FROM tasks
                 WHERE branch_id = ?
                   AND username = ?`,
                [branch_id, username]
            ),
            pool.query(
                `SELECT
                    COUNT(*) AS total,
                    COALESCE(SUM(CASE WHEN status = '1' THEN 1 ELSE 0 END), 0) AS active,
                    COALESCE(SUM(CASE WHEN status = '0' THEN 1 ELSE 0 END), 0) AS inactive
                 FROM firms
                 WHERE branch_id = ?
                   AND username = ?
                   AND (is_deleted = '0' OR is_deleted = 0)`,
                [branch_id, username]
            ),
        ]);

        const num = (value) => Number(value) || 0;
        const tasks = taskResult[0]?.[0] || {};
        const firms = firmResult[0]?.[0] || {};

        return res.status(200).json({
            success: true,
            message: "Dashboard statistics retrieved successfully",
            data: {
                balance: {
                    balance: num(balanceResult?.balance),
                    debit: num(balanceResult?.debit),
                    credit: num(balanceResult?.credit),
                },
                tasks: {
                    total: num(tasks.total),
                    in_process: num(tasks.in_process),
                    pending_from_client: num(tasks.pending_from_client),
                    pending_from_department: num(tasks.pending_from_department),
                    complete: num(tasks.complete),
                    cancel: num(tasks.cancel),
                },
                firms: {
                    total: num(firms.total),
                    active: num(firms.active),
                    inactive: num(firms.inactive),
                },
            },
        });
    } catch (error) {
        console.error("CLIENT DASHBOARD ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch dashboard statistics",
        });
    }
});

export default router;