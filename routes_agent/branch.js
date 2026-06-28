import express from "express";
import pool from "../db.js";
import { validateAgentSession } from "../middleware/validateAgentSession.js";

const router = express.Router();

function nonEmptyValues(...values) {
    return values
        .map((v) => (v != null ? String(v).trim() : ""))
        .filter((v) => v !== "");
}

router.get("/support", validateAgentSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;

        let rows;
        try {
            [rows] = await pool.query(
                `SELECT mobile_1, mobile_2, email_1, email_2
                 FROM branch_list
                 WHERE branch_id = ? AND (is_deleted = '0' OR is_deleted = 0)
                 ORDER BY id ASC
                 LIMIT 1`,
                [branch_id]
            );
        } catch {
            [rows] = await pool.query(
                `SELECT mobile_1, mobile_2, email_1, email_2
                 FROM branch_list
                 WHERE branch_id = ?
                 ORDER BY id ASC
                 LIMIT 1`,
                [branch_id]
            );
        }

        if (!rows.length) {
            return res.status(404).json({
                success: false,
                message: "Branch contact details not found",
            });
        }

        const row = rows[0];
        const phones = nonEmptyValues(row.mobile_1, row.mobile_2);
        const emails = nonEmptyValues(row.email_1, row.email_2);

        return res.status(200).json({
            success: true,
            message: "Branch support contact retrieved successfully",
            data: {
                phone: phones,
                email: emails,
            },
        });
    } catch (error) {
        console.error("AGENT BRANCH SUPPORT ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch branch support contact",
        });
    }
});

export default router;
