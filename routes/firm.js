import express from "express";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";

const router = express.Router();

router.get("/list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { search, username, page_no = 1, limit = 20 } = req.query;

        const searchStr = typeof search === "string" ? search.trim() : "";
        const usernameStr = typeof username === "string" ? username.trim() : "";
        const pageNum = Math.max(1, Number(page_no) || 1);
        let limitNum = Number(limit) || 20;
        if (limitNum > 100) limitNum = 100;
        if (limitNum < 1) limitNum = 20;
        const offset = (pageNum - 1) * limitNum;

        let query = `
            SELECT 
                f.id,
                f.firm_id,
                f.firm_name,
                f.username,
                f.firm_type,
                f.branch_id,
                f.address_line_1,
                f.address_line_2,
                f.city,
                f.state,
                f.country,
                f.pincode,
                f.gst_no,
                f.pan_no,
                f.file_no,
                p.name AS profile_name,
                p.mobile AS profile_mobile,
                p.email AS profile_email,
                p.pan_number AS profile_pan_number
            FROM firms f
            LEFT JOIN profile p ON f.username = p.username
                AND p.id = (SELECT MAX(p2.id) FROM profile p2 WHERE p2.username = f.username)
            WHERE f.branch_id = ?
                AND f.is_deleted = '0'
                AND f.status = '1'
        `;

        const queryParams = [branch_id];

        if (usernameStr) {
            query += ` AND f.username = ?`;
            queryParams.push(usernameStr);
        }

        if (searchStr) {
            const searchPattern = `%${searchStr}%`;
            query += `
                AND (
                    f.firm_name LIKE ?
                    OR f.firm_id LIKE ?
                    OR f.username LIKE ?
                    OR f.firm_type LIKE ?
                    OR f.gst_no LIKE ?
                    OR f.pan_no LIKE ?
                    OR f.address_line_1 LIKE ?
                    OR f.address_line_2 LIKE ?
                    OR f.city LIKE ?
                    OR f.state LIKE ?
                    OR f.pincode LIKE ?
                    OR p.name LIKE ?
                    OR p.mobile LIKE ?
                    OR p.email LIKE ?
                    OR p.pan_number LIKE ?
                )
            `;
            queryParams.push(
                searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern,
                searchPattern, searchPattern, searchPattern, searchPattern, searchPattern,
                searchPattern, searchPattern, searchPattern, searchPattern
            );
        }

        const countQuery = query.replace(/SELECT[\s\S]*?FROM/, "SELECT COUNT(*) as total FROM");
        const [countResult] = await pool.query(countQuery, queryParams);
        const total = countResult[0]?.total || 0;

        query += ` ORDER BY f.firm_name ASC LIMIT ? OFFSET ?`;
        queryParams.push(limitNum, offset);

        const [rows] = await pool.query(query, queryParams);

        const data = rows.map((firm) => ({
            firm_id: firm.firm_id,
            firm_name: firm.firm_name,
            firm_type: firm.firm_type,
            branch_id: firm.branch_id,
            address_line_1: firm.address_line_1,
            address_line_2: firm.address_line_2,
            city: firm.city,
            state: firm.state,
            country: firm.country,
            pincode: firm.pincode,
            gst_no: firm.gst_no,
            pan_no: firm.pan_no,
            file_no: firm.file_no ?? null,
            client: {
                username: firm.username ?? null,
                name: firm.profile_name ?? null,
                mobile: firm.profile_mobile ?? null,
                email: firm.profile_email ?? null,
                pan_number: firm.profile_pan_number ?? null
            }
        }));

        return res.status(200).json({
            success: true,
            message: "Firm list retrieved successfully",
            data,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                total_pages: Math.ceil(total / limitNum) || 1,
                is_last_page: offset + rows.length >= total,
            },
        });
    } catch (error) {
        console.error("Error fetching firm list:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch firm list",
            error: error.message
        });
    }
});

export default router;
