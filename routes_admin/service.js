import express from "express";
import pool from "../db.js";
import { authAdmin } from "../middleware/authAdmin.js";

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

function normalizeComplianceFields(fields, serviceType) {
    if (serviceType !== "compliance" || fields == null) {
        return null;
    }

    let parsed = fields;
    if (typeof fields === "string") {
        try {
            parsed = JSON.parse(fields);
        } catch {
            return null;
        }
    }

    if (!Array.isArray(parsed)) {
        return null;
    }

    const normalized = parsed
        .map((item) => ({
            label: String(item?.label ?? "").trim(),
            is_required: Boolean(item?.is_required),
        }))
        .filter((item) => item.label);

    return normalized.length ? JSON.stringify(normalized) : null;
}

function validateServiceId(value) {
    const sid = value != null ? String(value).trim() : "";
    if (!sid) {
        return { ok: false, message: "service_id is required" };
    }
    if (/\s/.test(sid)) {
        return { ok: false, message: "service_id must not contain spaces" };
    }
    return { ok: true, value: sid };
}

router.get("/list", authAdmin, async (req, res) => {
    try {
        const page_no = Math.max(1, Number(req.query.page_no) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
        const offset = (page_no - 1) * limit;
        const search = req.query.search ? String(req.query.search).trim() : "";
        const typeFilter = req.query.type ? String(req.query.type).trim().toLowerCase() : "";

        let baseFrom = "FROM services s";
        const filterParams = [];
        const whereClauses = [];

        if (typeFilter && VALID_TYPES.includes(typeFilter)) {
            whereClauses.push("s.type = ?");
            filterParams.push(typeFilter);
        }

        if (search) {
            const sp = `%${search}%`;
            whereClauses.push(`(
                s.service_id LIKE ?
                OR s.name LIKE ?
                OR s.sac_code LIKE ?
                OR s.type LIKE ?
                OR s.remark LIKE ?
                OR s.frequency LIKE ?
            )`);
            filterParams.push(sp, sp, sp, sp, sp, sp);
        }

        if (whereClauses.length) {
            baseFrom += ` WHERE ${whereClauses.join(" AND ")}`;
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
                type: typeFilter && VALID_TYPES.includes(typeFilter) ? typeFilter : null,
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

        const serviceIdCheck = validateServiceId(service_id);
        if (!serviceIdCheck.ok) {
            return res.status(400).json({
                success: false,
                message: serviceIdCheck.message,
            });
        }

        const sid = serviceIdCheck.value;

        const [existing] = await pool.query(
            "SELECT service_id FROM services WHERE service_id = ? LIMIT 1",
            [sid]
        );

        if (existing.length) {
            return res.status(409).json({
                success: false,
                message: "service_id already exists",
            });
        }

        const sac = sac_code != null ? String(sac_code).trim() : null;
        const freq =
            serviceType === "compliance"
                ? frequency != null && String(frequency).trim() !== ""
                    ? String(frequency).trim().toLowerCase()
                    : "monthly"
                : frequency != null && String(frequency).trim() !== ""
                    ? String(frequency).trim().toLowerCase()
                    : null;
        const amount = default_amount != null ? Number(default_amount) : 0;
        const rem = remark != null ? String(remark).trim() : null;
        const dueDayRaw = default_due_date ?? due_day;
        const dueDayVal = dueDayRaw != null ? Number(dueDayRaw) : 10;
        const fieldsJson = normalizeComplianceFields(fields, serviceType);

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
        const { service_id, name, sac_code } = req.body || {};

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

        if (name === undefined || String(name).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "name is required",
            });
        }

        const finalName = String(name).trim();
        const finalSac =
            sac_code !== undefined
                ? sac_code != null && String(sac_code).trim() !== ""
                    ? String(sac_code).trim()
                    : null
                : existing[0].sac_code;

        await pool.query(
            "UPDATE services SET name = ?, sac_code = ? WHERE service_id = ?",
            [finalName, finalSac, sid]
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
