import express from "express";
import pool from "../db.js";
import { authAdmin } from "../middleware/authAdmin.js";
import { RANDOM_STRING } from "../helpers/function.js";

const router = express.Router();

const VALID_TYPES = ["general", "compliance"];

function formatService(row) {
    return {
        service_id: row.service_id,
        name: row.name,
        sac_code: row.sac_code,
        type: row.type,
        compliance: row.type === "compliance",
        frequency: row.frequency,
        default_amount: Number(row.default_amount) || 0,
        remark: row.remark,
        due_day: row.default_due_date ?? row.due_day ?? null,
        fields: parseFields(row.fields),
    };
}

function parseFields(value) {
    if (value === undefined || value === null || String(value).trim() === "") {
        return null;
    }
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

router.get("/list", authAdmin, async (req, res) => {
    try {
        const page_no = Math.max(1, Number(req.query.page_no) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
        const offset = (page_no - 1) * limit;
        const search = req.query.search ? String(req.query.search).trim() : "";

        let baseFrom = "FROM services s";
        const filterParams = [];

        if (search) {
            const sp = `%${search}%`;
            baseFrom += ` WHERE (
                s.service_id LIKE ?
                OR s.name LIKE ?
                OR s.sac_code LIKE ?
                OR s.type LIKE ?
                OR s.remark LIKE ?
                OR s.frequency LIKE ?
            )`;
            filterParams.push(sp, sp, sp, sp, sp, sp);
        }

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total ${baseFrom}`,
            filterParams
        );

        const [rows] = await pool.query(
            `SELECT
                s.id,
                s.service_id,
                s.name,
                s.sac_code,
                s.type,
                s.frequency,
                s.default_amount,
                s.remark,
                s.default_due_date,
                s.fields
            ${baseFrom}
            ORDER BY s.name ASC
            LIMIT ? OFFSET ?`,
            [...filterParams, limit, offset]
        );

        const data = rows.map(formatService);

        const totalCount = Number(total) || 0;

        return res.status(200).json({
            success: true,
            message: "Services list retrieved successfully",
            filters: {
                search: search || null,
            },
            data,
            pagination: {
                page_no,
                limit,
                total: totalCount,
                total_pages: Math.ceil(totalCount / limit) || 0,
                has_more: offset + rows.length < totalCount,
            },
        });
    } catch (err) {
        console.error("ADMIN SERVICE LIST ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch services list",
        });
    }
});

router.post("/create", authAdmin, async (req, res) => {
    try {
        const {
            name,
            sac_code,
            type,
            frequency,
            default_amount,
            remark,
            due_day,
            default_due_date,
            fields,
        } = req.body || {};

        if (!name || String(name).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "name is required",
            });
        }

        const serviceType = type != null ? String(type).trim().toLowerCase() : "general";

        if (!VALID_TYPES.includes(serviceType)) {
            return res.status(400).json({
                success: false,
                message: "type must be 'general' or 'compliance'",
            });
        }

        let sid = null;
        for (let attempt = 0; attempt < 5; attempt++) {
            const candidate = RANDOM_STRING();
            const [existing] = await pool.query(
                "SELECT service_id FROM services WHERE service_id = ? LIMIT 1",
                [candidate]
            );
            if (!existing.length) {
                sid = candidate;
                break;
            }
        }

        if (!sid) {
            return res.status(500).json({
                success: false,
                message: "Failed to generate unique service_id",
            });
        }

        const sac = sac_code != null ? String(sac_code).trim() : null;
        const freq = frequency != null ? String(frequency).trim().toLowerCase() : "monthly";
        const amount = default_amount != null ? Number(default_amount) : 0;
        const rem = remark != null ? String(remark).trim() : null;
        const dueDayRaw = default_due_date ?? due_day;
        const dueDayVal = dueDayRaw != null ? Number(dueDayRaw) : 10;
        const fieldsJson =
            fields != null
                ? typeof fields === "string"
                    ? fields
                    : JSON.stringify(fields)
                : null;

        await pool.query(
            `INSERT INTO services (service_id, name, sac_code, type, frequency, default_amount, remark, default_due_date, fields)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [sid, String(name).trim(), sac, serviceType, freq, amount, rem, dueDayVal, fieldsJson]
        );

        const [rows] = await pool.query(
            "SELECT * FROM services WHERE service_id = ? LIMIT 1",
            [sid]
        );

        return res.status(201).json({
            success: true,
            message: "Service created successfully",
            data: formatService(rows[0]),
        });
    } catch (err) {
        console.error("ADMIN SERVICE CREATE ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to create service",
        });
    }
});

router.put("/edit", authAdmin, async (req, res) => {
    try {
        const {
            service_id,
            name,
            sac_code,
            type,
            frequency,
            default_amount,
            remark,
            due_day,
            default_due_date,
            fields,
        } = req.body || {};

        if (!service_id || String(service_id).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "service_id is required",
            });
        }

        const sid = String(service_id).trim();

        const [existing] = await pool.query(
            "SELECT * FROM services WHERE service_id = ? LIMIT 1",
            [sid]
        );

        if (!existing.length) {
            return res.status(404).json({
                success: false,
                message: "Service not found",
            });
        }

        const service = existing[0];

        if (type != null) {
            const serviceType = String(type).trim().toLowerCase();
            if (!VALID_TYPES.includes(serviceType)) {
                return res.status(400).json({
                    success: false,
                    message: "type must be 'general' or 'compliance'",
                });
            }
        }

        const finalType = type != null ? String(type).trim().toLowerCase() : service.type;
        const finalName = name !== undefined ? String(name).trim() : service.name;
        const finalSac = sac_code !== undefined
            ? (sac_code != null ? String(sac_code).trim() : null)
            : service.sac_code;
        const finalFreq = frequency !== undefined
            ? String(frequency).trim().toLowerCase()
            : service.frequency;
        const finalAmount = default_amount !== undefined
            ? Number(default_amount)
            : Number(service.default_amount);
        const finalRemark = remark !== undefined
            ? (remark != null ? String(remark).trim() : null)
            : service.remark;
        const finalDueDay = (default_due_date ?? due_day) !== undefined
            ? Number(default_due_date ?? due_day)
            : Number(service.default_due_date ?? service.due_day ?? 10);
        const finalFields =
            fields !== undefined
                ? fields != null
                    ? typeof fields === "string"
                        ? fields
                        : JSON.stringify(fields)
                    : null
                : service.fields;

        if (!finalName) {
            return res.status(400).json({
                success: false,
                message: "name cannot be empty",
            });
        }

        await pool.query(
            `UPDATE services
             SET name = ?, sac_code = ?, type = ?, frequency = ?, default_amount = ?, remark = ?, default_due_date = ?, fields = ?
             WHERE service_id = ?`,
            [finalName, finalSac, finalType, finalFreq, finalAmount, finalRemark, finalDueDay, finalFields, sid]
        );

        const [rows] = await pool.query(
            "SELECT * FROM services WHERE service_id = ? LIMIT 1",
            [sid]
        );

        return res.status(200).json({
            success: true,
            message: "Service updated successfully",
            data: formatService(rows[0]),
        });
    } catch (err) {
        console.error("ADMIN SERVICE EDIT ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to update service",
        });
    }
});

export default router;
