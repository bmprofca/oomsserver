import express from "express";
import {
    caProfileExists,
    listCaProfilesByPhone,
    resolveCaTokenSession,
} from "../middleware/authCa.js";
import { validateCaSession } from "../middleware/validateCaSession.js";
import pool from "../db.js";
import { GET_BALANCE } from "../helpers/function.js";

const router = express.Router();

router.get("/list", async (req, res) => {
    try {
        const token = req.headers["token"] || req.headers["Token"] || "";

        if (!token) {
            return res.status(401).json({
                success: false,
                message: "Session expired",
            });
        }

        const session = await resolveCaTokenSession(token);
        if (!session) {
            return res.status(401).json({
                success: false,
                message: "Invalid or expired session",
            });
        }

        const profileExists = await caProfileExists(session.country_code, session.mobile);
        if (!profileExists) {
            return res.status(404).json({
                success: false,
                message: "CA profile not found",
            });
        }

        const data = await listCaProfilesByPhone(session.country_code, session.mobile);

        return res.status(200).json({
            success: true,
            message: "Branch list retrieved successfully",
            data,
            branches: data,
        });
    } catch (err) {
        console.error("CA PROFILE LIST ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch branch list",
        });
    }
});

router.get("/me", validateCaSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.ca_username;

        const [[profileRows], balance] = await Promise.all([
            pool.query(
                `SELECT
                    p.username,
                    p.name,
                    p.email,
                    p.mobile,
                    p.country_code,
                    p.address_line_1,
                    p.address_line_2,
                    p.city,
                    p.district,
                    p.state,
                    p.pincode,
                    p.country,
                    c.branch_id,
                    c.status AS ca_status,
                    bl.name AS branch_name
                 FROM profile p
                 INNER JOIN clients c ON c.username = p.username
                    AND c.user_type = 'ca'
                    AND (c.is_deleted = '0' OR c.is_deleted = 0)
                 LEFT JOIN branch_list bl ON bl.branch_id = c.branch_id
                    AND (bl.is_deleted = '0' OR bl.is_deleted = 0)
                 WHERE p.username = ?
                   AND p.user_type = 'ca'
                   AND p.status = '1'
                   AND c.branch_id = ?
                 LIMIT 1`,
                [username, branch_id]
            ),
            GET_BALANCE({
                branch_id,
                party_id: username,
                party_type: "ca",
            }),
        ]);

        if (!profileRows.length) {
            return res.status(404).json({
                success: false,
                message: "CA profile not found",
            });
        }

        const row = profileRows[0];

        return res.status(200).json({
            success: true,
            message: "Profile retrieved successfully",
            data: {
                username: row.username,
                name: row.name,
                email: row.email,
                mobile: row.mobile,
                country_code: row.country_code,
                status: String(row.ca_status) === "1",
                address: {
                    address_line_1: row.address_line_1,
                    address_line_2: row.address_line_2,
                    city: row.city,
                    district: row.district,
                    state: row.state,
                    pincode: row.pincode,
                    country: row.country,
                },
                branch: {
                    branch_id: row.branch_id,
                    name: row.branch_name,
                },
                balance: {
                    balance: Number(balance?.balance) || 0,
                    debit: Number(balance?.debit) || 0,
                    credit: Number(balance?.credit) || 0,
                },
            },
        });
    } catch (error) {
        console.error("CA PROFILE ME ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch profile",
        });
    }
});

export default router;
