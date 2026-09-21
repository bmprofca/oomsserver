import express from "express";
import { GET_BALANCE } from "../helpers/function.js";
import { validateAgentSession } from "../middleware/validateAgentSession.js";

const router = express.Router();

router.get("/dashboard", validateAgentSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.agent_username;

        const balanceResult = await GET_BALANCE({
            branch_id,
            party_id: username,
            party_type: "agent",
        });

        const num = (value) => Number(value) || 0;
        const tasks = {};
        const firms = {};

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
        console.error("AGENT DASHBOARD ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch dashboard statistics",
        });
    }
});

export default router;
