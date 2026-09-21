import express from "express";
import { validateAgentSession } from "../middleware/validateAgentSession.js";

const router = express.Router();

const ALLOWED_STATUSES = [
    "in process",
    "pending from client",
    "pending from department",
    "complete",
    "cancel",
];

function parseQueryArray(value) {
    if (value === undefined || value === null) return [];

    const toCleanStringArray = (arr) =>
        arr
            .map((item) => String(item).trim())
            .filter((item) => item !== "");

    if (Array.isArray(value)) {
        return toCleanStringArray(value);
    }

    const raw = String(value).trim();
    if (raw === "") return [];

    if (raw.startsWith("[") && raw.endsWith("]")) {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return toCleanStringArray(parsed);
            }
        } catch (_) { }
    }

    return toCleanStringArray(raw.split(","));
}

router.get("/list", validateAgentSession, async (req, res) => {
    try {
        const { page_no = 1, limit = 20, status } = req.query || {};

        const pageNum = Math.max(1, Number(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));

        const statusList = parseQueryArray(status).map((item) => item.toLowerCase());
        const invalidStatuses = statusList.filter((item) => !ALLOWED_STATUSES.includes(item));
        if (invalidStatuses.length) {
            return res.status(400).json({
                success: false,
                message: `Invalid status value(s): ${invalidStatuses.join(", ")}`,
            });
        }

        return res.status(200).json({
            success: true,
            message: "Task list retrieved successfully",
            data: [],
            pagination: {
                page_no: pageNum,
                limit: limitNum,
                total: 0,
                total_pages: 1,
                is_last_page: true,
            },
        });
    } catch (error) {
        console.error("AGENT TASK LIST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch task list",
        });
    }
});

export default router;
