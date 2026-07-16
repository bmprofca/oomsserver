import { fetchBranchGstSettings, resolveGst, toDateOnly } from "../helpers/gst.js";
import express from 'express';
const router = express.Router();

import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { RANDOM_STRING, USER_SNIPPED_DATA } from "../helpers/function.js";
import { createTaskFromServiceRequest } from "../helpers/taskCreateHelper.js";

function parseServiceId(value) {
    const service_id = value != null ? String(value).trim() : "";
    return service_id || null;
}

function parseDueDate(value) {
    if (value === undefined || value === null || value === "") {
        return 10;
    }
    const dueDate = Number(value);
    if (!Number.isInteger(dueDate) || dueDate < 1 || dueDate > 31) {
        return null;
    }
    return dueDate;
}

function parseFeesOnly(fees, defaultFees = 0) {
    const feesNum =
        fees != null && fees !== ""
            ? Number(fees)
            : Number(defaultFees || 0);

    if (Number.isNaN(feesNum) || feesNum < 0) {
        return { error: "fees must be a valid non-negative number" };
    }

    return { feesNum };
}

const ALLOWED_SERVICE_TYPES = ["general", "compliance"];

function parseIsAddedFilter(value) {
    if (value === undefined || value === null || String(value).trim() === "") {
        return { filter: null };
    }

    const normalized = String(value).trim().toLowerCase();
    if (["true", "1", "yes"].includes(normalized)) {
        return { filter: true };
    }
    if (["false", "0", "no"].includes(normalized)) {
        return { filter: false };
    }

    return { error: "is_added must be true or false" };
}

// GET /list - List all global services by type; is_added shows branch mapping
// Query: { page_no, limit, search, type, is_added | added_only } — type: "" (all), "general", or "compliance"
router.get('/list', auth, validateBranch, async (req, res) => {
    try {
        const { search, page_no, limit, type, is_added, added_only } = req.query;
        const branch_id = req.branch_id;

        const serviceType = type != null ? String(type).trim().toLowerCase() : "";
        if (serviceType && !ALLOWED_SERVICE_TYPES.includes(serviceType)) {
            return res.status(400).json({
                success: false,
                message: "type must be empty, 'general', or 'compliance'",
            });
        }

        const isAddedFilter = parseIsAddedFilter(is_added ?? added_only);
        if (isAddedFilter.error) {
            return res.status(400).json({
                success: false,
                message: isAddedFilter.error,
            });
        }

        const pageNum = Math.max(1, parseInt(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 10));
        const offset = (pageNum - 1) * limitNum;

        let baseQuery = `
            FROM services s
            LEFT JOIN branch_services bs
                ON bs.service_id = s.service_id
               AND bs.branch_id = ?
               AND bs.is_deleted = '0'
            WHERE s.type IN ('general', 'compliance')
        `;

        const queryParams = [branch_id];

        if (serviceType) {
            baseQuery += ` AND s.type = ?`;
            queryParams.push(serviceType);
        }

        if (isAddedFilter.filter === true) {
            baseQuery += ` AND bs.service_id IS NOT NULL`;
        } else if (isAddedFilter.filter === false) {
            baseQuery += ` AND bs.service_id IS NULL`;
        }

        if (search != null && String(search).trim() !== '') {
            const searchPattern = `%${String(search).trim()}%`;
            baseQuery += ` AND (s.name LIKE ? OR s.sac_code LIKE ? OR s.remark LIKE ?)`;
            queryParams.push(searchPattern, searchPattern, searchPattern);
        }

        const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${baseQuery}`, queryParams);

        const dataQuery = `
            SELECT
                s.service_id,
                s.name,
                s.sac_code,
                s.type,
                s.remark AS service_remark,
                s.frequency,
                s.default_due_date,
                CASE WHEN bs.service_id IS NOT NULL THEN 1 ELSE 0 END AS is_added,
                bs.fees,
                bs.remark,
                bs.due_date,
                bs.create_by,
                bs.create_date,
                bs.modify_by,
                bs.modify_date
            ${baseQuery} ORDER BY s.name ASC LIMIT ? OFFSET ?
        `;

        const [rows] = await pool.query(dataQuery, [...queryParams, limitNum, offset]);
        const gstSettings = await fetchBranchGstSettings(pool, branch_id);
        const asOfDate = toDateOnly(new Date());

        const data = [];
        for (let i = 0; i < rows.length; i++) {
            const el = rows[i];
            const added = el.is_added === 1;
            const rowIsCompliance = el.type === "compliance";

            const item = {
                service_id: el.service_id,
                name: el.name,
                sac_code: el.sac_code,
                type: el.type,
                service_remark: el.service_remark,
                is_added: added,
            };

            if (rowIsCompliance) {
                item.frequency = el.frequency;
                item.default_due_date = el.default_due_date;
            }

            if (!added) {
                data.push(item);
                continue;
            }

            const create_by = await USER_SNIPPED_DATA(el.create_by);
            const modify_by = await USER_SNIPPED_DATA(el.modify_by);
            const feesNum = Number(el.fees) || 0;
            const gst = resolveGst({ fees: feesNum, asOfDate, settings: gstSettings });

            item.fees = feesNum;
            item.gst_rate = gst.tax_rate;
            item.gst_value = gst.tax_value;
            item.create_date = el.create_date;
            item.modify_date = el.modify_date;
            item.create_by = create_by;
            item.modify_by = modify_by;

            if (rowIsCompliance) {
                const [[firmRow]] = await pool.query(
                    `SELECT COUNT(*) AS firm_count
                     FROM compliance_firms
                     WHERE branch_id = ?
                       AND service_id = ?
                       AND is_deleted = '0'`,
                    [branch_id, el.service_id]
                );

                item.due_date = el.due_date;
                item.firm_count = Number(firmRow?.firm_count || 0);
            } else {
                item.remark = el.remark;
            }

            data.push(item);
        }

        const totalPages = Math.ceil(total / limitNum);
        return res.status(200).json({
            success: true,
            message: "Services list retrieved successfully",
            data,
            pagination: {
                page_no: pageNum,
                limit: limitNum,
                total,
                total_pages: totalPages,
                is_last_page: pageNum >= totalPages,
            },
        });

    } catch (error) {
        console.error('Error fetching services list:', error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch services list",
            error: error.message
        });
    }
});

// POST /add - Add a global service to this branch
// General payload: { service_id, fees, remark }
// Compliance payload: { service_id, fees, due_date }
router.post("/add", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const createdBy = req.headers["username"] || "";
        const { service_id, fees, remark, due_date } = req.body || {};

        const sid = parseServiceId(service_id);
        if (!sid) {
            return res.status(400).json({ success: false, message: "service_id is required" });
        }

        const [serviceCheck] = await pool.query(
            `SELECT service_id, name, type, default_amount
             FROM services
             WHERE service_id = ?
             LIMIT 1`,
            [sid]
        );
        if (serviceCheck.length === 0) {
            return res.status(404).json({ success: false, message: "Service not found" });
        }

        const service = serviceCheck[0];
        const isCompliance = service.type === "compliance";

        const [existing] = await pool.query(
            "SELECT id FROM branch_services WHERE service_id = ? AND branch_id = ? AND is_deleted = '0' LIMIT 1",
            [sid, branch_id]
        );
        if (existing.length > 0) {
            return res.status(409).json({ success: false, message: "Service is already added to this branch" });
        }

        const [deleted] = await pool.query(
            "SELECT id FROM branch_services WHERE service_id = ? AND branch_id = ? AND is_deleted = '1' LIMIT 1",
            [sid, branch_id]
        );

        const defaultFees = isCompliance ? service.default_amount : 0;
        const parsedFees = parseFeesOnly(fees, defaultFees);
        if (parsedFees.error) {
            return res.status(400).json({ success: false, message: parsedFees.error });
        }
        const { feesNum } = parsedFees;
        const gstSettings = await fetchBranchGstSettings(pool, branch_id);
        const gst = resolveGst({
            fees: feesNum,
            asOfDate: new Date(),
            settings: gstSettings,
        });

        let remarkVal = null;
        let dueDateVal = 10;

        if (isCompliance) {
            dueDateVal = parseDueDate(due_date);
            if (dueDateVal === null) {
                return res.status(400).json({
                    success: false,
                    message: "due_date must be an integer between 1 and 31",
                });
            }
        } else {
            remarkVal = remark != null && remark !== "" ? String(remark).trim() : null;
        }

        if (deleted.length > 0) {
            if (isCompliance) {
                await pool.query(
                    `UPDATE branch_services
                     SET is_deleted = '0', deleted_by = NULL, fees = ?, due_date = ?, modify_by = ?, modify_date = NOW()
                     WHERE service_id = ? AND branch_id = ?`,
                    [feesNum, dueDateVal, createdBy, sid, branch_id]
                );
            } else {
                await pool.query(
                    `UPDATE branch_services
                     SET is_deleted = '0', deleted_by = NULL, fees = ?, remark = ?, modify_by = ?, modify_date = NOW()
                     WHERE service_id = ? AND branch_id = ?`,
                    [feesNum, remarkVal, createdBy, sid, branch_id]
                );
            }
        } else if (isCompliance) {
            await pool.query(
                `INSERT INTO branch_services (branch_id, service_id, fees, due_date, create_by, modify_by, is_deleted)
                 VALUES (?, ?, ?, ?, ?, ?, '0')`,
                [branch_id, sid, feesNum, dueDateVal, createdBy, createdBy]
            );
        } else {
            await pool.query(
                `INSERT INTO branch_services (branch_id, service_id, fees, remark, create_by, modify_by, is_deleted)
                 VALUES (?, ?, ?, ?, ?, ?, '0')`,
                [branch_id, sid, feesNum, remarkVal, createdBy, createdBy]
            );
        }

        const responseData = {
            service_id: sid,
            branch_id,
            name: service.name,
            type: service.type,
            fees: feesNum,
            gst_rate: gst.tax_rate,
            gst_value: gst.tax_value,
        };

        if (isCompliance) {
            responseData.due_date = dueDateVal;
        } else {
            responseData.remark = remarkVal;
        }

        return res.status(200).json({
            success: true,
            message: "Service added to branch successfully",
            data: responseData,
        });
    } catch (error) {
        console.error("Error adding service to branch:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to add service to branch",
            error: error.message
        });
    }
});

// PUT /edit - Edit a branch service
// General payload: { service_id, fees, remark }
// Compliance payload: { service_id, fees, due_date }
router.put("/edit", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const modifyBy = req.headers["username"] || "";
        const { service_id, fees, remark, due_date } = req.body || {};

        const sid = parseServiceId(service_id);
        if (!sid) {
            return res.status(400).json({ success: false, message: "service_id is required" });
        }

        const [existing] = await pool.query(
            `SELECT bs.id, s.name, s.type, s.default_amount
             FROM branch_services bs
             INNER JOIN services s ON bs.service_id = s.service_id
             WHERE bs.service_id = ? AND bs.branch_id = ? AND bs.is_deleted = '0'
             LIMIT 1`,
            [sid, branch_id]
        );
        if (existing.length === 0) {
            return res.status(404).json({ success: false, message: "Service not found in this branch" });
        }

        const service = existing[0];
        const isCompliance = service.type === "compliance";

        const parsedFees = parseFeesOnly(fees, isCompliance ? service.default_amount : 0);
        if (parsedFees.error) {
            return res.status(400).json({ success: false, message: parsedFees.error });
        }
        const { feesNum } = parsedFees;
        const gstSettings = await fetchBranchGstSettings(pool, branch_id);
        const gst = resolveGst({
            fees: feesNum,
            asOfDate: new Date(),
            settings: gstSettings,
        });

        let remarkVal = null;
        let dueDateVal = 10;

        if (isCompliance) {
            dueDateVal = parseDueDate(due_date);
            if (dueDateVal === null) {
                return res.status(400).json({
                    success: false,
                    message: "due_date must be an integer between 1 and 31",
                });
            }

            await pool.query(
                `UPDATE branch_services
                 SET fees = ?, due_date = ?, modify_by = ?, modify_date = NOW()
                 WHERE service_id = ? AND branch_id = ? AND is_deleted = '0'`,
                [feesNum, dueDateVal, modifyBy, sid, branch_id]
            );
        } else {
            remarkVal = remark != null && remark !== "" ? String(remark).trim() : null;

            await pool.query(
                `UPDATE branch_services
                 SET fees = ?, remark = ?, modify_by = ?, modify_date = NOW()
                 WHERE service_id = ? AND branch_id = ? AND is_deleted = '0'`,
                [feesNum, remarkVal, modifyBy, sid, branch_id]
            );
        }

        const responseData = {
            service_id: sid,
            branch_id,
            name: service.name,
            type: service.type,
            fees: feesNum,
            gst_rate: gst.tax_rate,
            gst_value: gst.tax_value,
        };

        if (isCompliance) {
            responseData.due_date = dueDateVal;
        } else {
            responseData.remark = remarkVal;
        }

        return res.status(200).json({
            success: true,
            message: "Branch service updated successfully",
            data: responseData,
        });
    } catch (error) {
        console.error("Error updating branch service:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update branch service",
            error: error.message
        });
    }
});

// DELETE /remove - Remove (soft delete) a service from this branch (general or compliance)
router.delete("/remove", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const deletedBy = req.headers["username"] || "";
        const { service_id } = req.body || {};

        const sid = parseServiceId(service_id);
        if (!sid) {
            return res.status(400).json({ success: false, message: "service_id is required" });
        }

        const [existing] = await pool.query(
            `SELECT bs.id, s.name, s.type
             FROM branch_services bs
             INNER JOIN services s ON bs.service_id = s.service_id
             WHERE bs.service_id = ? AND bs.branch_id = ? AND bs.is_deleted = '0'
             LIMIT 1`,
            [sid, branch_id]
        );
        if (existing.length === 0) {
            return res.status(404).json({ success: false, message: "Service not found in this branch" });
        }

        await pool.query(
            `UPDATE branch_services SET is_deleted = '1', deleted_by = ?, modify_by = ?, modify_date = NOW()
             WHERE service_id = ? AND branch_id = ? AND is_deleted = '0'`,
            [deletedBy, deletedBy, sid, branch_id]
        );

        return res.status(200).json({
            success: true,
            message: "Service removed from branch successfully",
            data: {
                service_id: sid,
                branch_id,
                name: existing[0].name,
                type: existing[0].type,
            },
        });
    } catch (error) {
        console.error("Error removing service from branch:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to remove service from branch",
            error: error.message
        });
    }
});


// GET /firms - Get all firms assigned to a specific service with details
router.get('/firms', auth, validateBranch, async (req, res) => {
    try {
        const { service_id, search, page, limit } = req.query;
        const branch_id = req.branch_id;

        if (!service_id || typeof service_id !== 'string' || service_id.trim() === '') {
            return res.status(400).json({
                success: false,
                message: "service_id is required"
            });
        }

        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 10));
        const offset = (pageNum - 1) * limitNum;

        let baseQuery = `
            FROM compliance_assignments ca
            INNER JOIN firms f ON ca.firm_id = f.firm_id
            LEFT JOIN profile p ON f.username = p.username
                AND p.id = (SELECT MAX(p2.id) FROM profile p2 WHERE p2.username = f.username)
            WHERE ca.service_id = ? AND f.branch_id = ? AND ca.status = 'active' AND f.is_deleted = '0'
        `;

        const queryParams = [service_id.trim(), branch_id];

        if (search != null && String(search).trim() !== '') {
            const searchPattern = `%${String(search).trim()}%`;
            baseQuery += ` AND (f.firm_name LIKE ? OR f.firm_id LIKE ? OR f.username LIKE ? OR f.pan_no LIKE ? OR f.gst_no LIKE ? OR p.name LIKE ? OR p.mobile LIKE ? OR p.email LIKE ?)`;
            queryParams.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
        }

        const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${baseQuery}`, queryParams);

        const dataQuery = `
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
                ca.assignment_id,
                ca.custom_amount,
                ca.status AS assignment_status,
                ca.employee_username,
                ca.pay_from_month,
                ca.quarters,
                ca.ack_no,
                ca.custom_fields,
                p.name AS profile_name,
                p.mobile AS profile_mobile,
                p.email AS profile_email,
                p.pan_number AS profile_pan_number
            ${baseQuery} ORDER BY f.firm_name ASC LIMIT ? OFFSET ?
        `;

        const [rows] = await pool.query(dataQuery, [...queryParams, limitNum, offset]);

        const data = rows.map((firm) => {
            let customFields = null;
            if (firm.custom_fields) {
                try {
                    customFields = JSON.parse(firm.custom_fields);
                } catch (e) {
                    customFields = {};
                }
            }
            return {
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
                client: {
                    username: firm.username ?? null,
                    name: firm.profile_name ?? null,
                    mobile: firm.profile_mobile ?? null,
                    email: firm.profile_email ?? null,
                    pan_number: firm.profile_pan_number ?? null
                },
                assignment: {
                    assignment_id: firm.assignment_id,
                    custom_amount: firm.custom_amount,
                    status: firm.assignment_status,
                    employee_username: firm.employee_username,
                    pay_from_month: firm.pay_from_month,
                    quarters: firm.quarters,
                    ack_no: firm.ack_no,
                    custom_fields: customFields
                }
            };
        });

        const totalPages = Math.ceil(total / limitNum);
        return res.status(200).json({
            success: true,
            message: "Firms for service retrieved successfully",
            data,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                total_pages: totalPages,
                is_last_page: pageNum >= totalPages
            }
        });

    } catch (error) {
        console.error('Error fetching firms for service:', error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch firms for service",
            error: error.message
        });
    }
});

// PUT /status - Toggle Active/Inactive status for a general service in this branch
router.put("/status", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.headers["username"] || "";
        const { service_id, status } = req.body || {};

        if (!service_id || typeof service_id !== "string" || service_id.trim() === "") {
            return res.status(400).json({ success: false, message: "service_id is required" });
        }

        if (status === undefined || status === null) {
            return res.status(400).json({ success: false, message: "status is required" });
        }

        const sid = service_id.trim();
        const statusStr = String(status).trim().toLowerCase();

        if (statusStr !== 'active' && statusStr !== 'inactive') {
            return res.status(400).json({ success: false, message: "status must be either 'Active' or 'Inactive'" });
        }

        // Verify service exists and is a general service
        const [serviceRows] = await pool.query(
            "SELECT * FROM services WHERE service_id = ? AND type = 'general' LIMIT 1",
            [sid]
        );

        if (serviceRows.length === 0) {
            return res.status(404).json({ success: false, message: "General service not found" });
        }

        const service = serviceRows[0];

        // Check if branch mapping exists
        const [existing] = await pool.query(
            "SELECT id, is_deleted FROM branch_services WHERE service_id = ? AND branch_id = ? LIMIT 1",
            [sid, branch_id]
        );

        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            if (statusStr === 'active') {
                if (existing.length > 0) {
                    await connection.query(
                        `UPDATE branch_services 
                         SET is_deleted = '0', deleted_by = NULL, modify_by = ?, modify_date = NOW()
                         WHERE service_id = ? AND branch_id = ?`,
                        [username, sid, branch_id]
                    );
                } else {
                    await connection.query(
                        `INSERT INTO branch_services (branch_id, service_id, fees, remark, create_by, modify_by, is_deleted)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '0')`,
                        [branch_id, sid, Number(service.default_amount || 0), 0, 0, null, username, username]
                    );
                }
            } else if (statusStr === 'inactive') {
                if (existing.length > 0) {
                    await connection.query(
                        `UPDATE branch_services 
                         SET is_deleted = '1', deleted_by = ?, modify_by = ?, modify_date = NOW()
                         WHERE service_id = ? AND branch_id = ?`,
                        [username, username, sid, branch_id]
                    );
                }
            }

            await connection.commit();
        } catch (txErr) {
            await connection.rollback();
            throw txErr;
        } finally {
            connection.release();
        }

        return res.status(200).json({
            success: true,
            message: `Service status updated to ${statusStr === 'active' ? 'Active' : 'Inactive'} successfully`
        });
    } catch (error) {
        console.error("Error toggling general service status:", error);
        return res.status(500).json({ success: false, message: "Failed to update service status", error: error.message });
    }
});

const SERVICE_REQUEST_STATUSES = ["pending", "approved", "rejected"];

function parseServiceRequestStatusQuery(value) {
    if (value === undefined || value === null) return [];

    const toClean = (arr) =>
        arr
            .map((item) => String(item).trim().toLowerCase())
            .filter((item) => item !== "" && item !== "null");

    if (Array.isArray(value)) {
        return toClean(value);
    }

    const raw = String(value).trim();
    if (raw === "" || raw.toLowerCase() === "null") return [];

    if (raw.startsWith("[") && raw.endsWith("]")) {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return toClean(parsed);
            }
        } catch (_) { }
    }

    return toClean(raw.split(","));
}

function formatServiceRequestListItem(row) {
    return {
        request_id: row.request_id,
        status: row.status,
        task_id: row.task_id,
        client_remark: row.client_remark,
        office_remark: row.office_remark,
        client: {
            username: row.username,
            name: row.client_name ?? null,
            email: row.client_email ?? null,
            mobile: row.client_mobile ?? null,
        },
        firm: {
            firm_id: row.firm_id,
            name: row.firm_name ?? null,
        },
        service: {
            service_id: row.service_id,
            name: row.service_name ?? null,
            type: row.service_type ?? null,
        },
        charges: {
            fees: Number(row.fees) || 0,
            tax_rate: 0,
            tax_value: 0,
            amount: Number(row.amount) || 0,
        },
        create_date: row.create_date,
        modify_date: row.modify_date,
    };
}

router.get("/service-request/list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { page_no = 1, limit = 20, firm_id, service_id, search, status } = req.query || {};

        const pageNum = Math.max(1, Number(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
        const offset = (pageNum - 1) * limitNum;

        const statusList = parseServiceRequestStatusQuery(status);
        const invalidStatuses = statusList.filter((item) => !SERVICE_REQUEST_STATUSES.includes(item));
        if (invalidStatuses.length) {
            return res.status(400).json({
                success: false,
                message: `Invalid status value(s): ${invalidStatuses.join(", ")}`,
            });
        }

        let baseQuery = `
            FROM service_requests sr
            LEFT JOIN firms f
                ON f.firm_id = sr.firm_id
               AND f.branch_id = sr.branch_id
               AND (f.is_deleted = '0' OR f.is_deleted = 0)
            LEFT JOIN services s
                ON s.service_id = sr.service_id
            LEFT JOIN profile p
                ON p.username = sr.username
               AND p.status = '1'
            WHERE sr.branch_id = ?
        `;
        const params = [branch_id];

        if (firm_id && String(firm_id).trim() !== "") {
            baseQuery += " AND sr.firm_id = ?";
            params.push(String(firm_id).trim());
        }

        if (service_id && String(service_id).trim() !== "") {
            baseQuery += " AND sr.service_id = ?";
            params.push(String(service_id).trim());
        }

        if (statusList.length > 0) {
            const placeholders = statusList.map(() => "?").join(", ");
            baseQuery += ` AND sr.status IN (${placeholders})`;
            params.push(...statusList);
        }

        if (search && String(search).trim() !== "") {
            const searchPattern = `%${String(search).trim()}%`;
            baseQuery += `
                AND (
                    sr.request_id LIKE ?
                    OR sr.username LIKE ?
                    OR sr.client_remark LIKE ?
                    OR sr.office_remark LIKE ?
                    OR f.firm_name LIKE ?
                    OR f.firm_id LIKE ?
                    OR s.name LIKE ?
                    OR s.service_id LIKE ?
                    OR p.name LIKE ?
                    OR p.email LIKE ?
                    OR p.mobile LIKE ?
                )
            `;
            params.push(
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern
            );
        }

        const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${baseQuery}`, params);

        const [rows] = await pool.query(
            `SELECT
                sr.request_id,
                sr.username,
                sr.firm_id,
                sr.service_id,
                sr.fees,
                
                sr.amount,
                sr.task_id,
                sr.client_remark,
                sr.office_remark,
                sr.status,
                sr.create_date,
                sr.modify_date,
                f.firm_name,
                s.name AS service_name,
                s.type AS service_type,
                p.name AS client_name,
                p.email AS client_email,
                p.mobile AS client_mobile
             ${baseQuery}
             ORDER BY sr.create_date DESC, sr.id DESC
             LIMIT ? OFFSET ?`,
            [...params, limitNum, offset]
        );

        return res.status(200).json({
            success: true,
            message: "Service request list retrieved successfully",
            data: rows.map((row) => formatServiceRequestListItem(row)),
            pagination: {
                page_no: pageNum,
                limit: limitNum,
                total: Number(total) || 0,
                total_pages: Math.ceil((Number(total) || 0) / limitNum) || 1,
                is_last_page: offset + rows.length >= (Number(total) || 0),
            },
        });
    } catch (error) {
        console.error("SERVICE REQUEST LIST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch service request list",
            error: error.message,
        });
    }
});

router.put("/service-request/reject/:request_id", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const modifiedBy = req.headers["username"] || "";
        const request_id = String(req.params.request_id || "").trim();
        const { office_remark } = req.body || {};

        if (!request_id) {
            return res.status(400).json({
                success: false,
                message: "request_id is required",
            });
        }

        const [existingRows] = await pool.query(
            `SELECT request_id, status, task_id
             FROM service_requests
             WHERE branch_id = ? AND request_id = ?
             LIMIT 1`,
            [branch_id, request_id]
        );

        if (!existingRows.length) {
            return res.status(404).json({
                success: false,
                message: "Service request not found",
            });
        }

        const currentStatus =
            existingRows[0].status != null ? String(existingRows[0].status).trim().toLowerCase() : "";

        if (currentStatus === "approved") {
            return res.status(400).json({
                success: false,
                message: "Approved service requests cannot be rejected",
            });
        }

        if (currentStatus === "rejected") {
            return res.status(400).json({
                success: false,
                message: "Service request is already rejected",
            });
        }

        const resolvedOfficeRemark =
            office_remark != null && String(office_remark).trim() !== ""
                ? String(office_remark).trim()
                : null;

        await pool.query(
            `UPDATE service_requests
             SET status = 'rejected',
                 office_remark = COALESCE(?, office_remark),
                 modify_by = ?,
                 modify_date = NOW()
             WHERE branch_id = ? AND request_id = ?`,
            [resolvedOfficeRemark, modifiedBy, branch_id, request_id]
        );

        const [rows] = await pool.query(
            `SELECT request_id, status, office_remark, modify_date, task_id
             FROM service_requests
             WHERE branch_id = ? AND request_id = ?
             LIMIT 1`,
            [branch_id, request_id]
        );

        return res.status(200).json({
            success: true,
            message: "Service request rejected successfully",
            data: rows[0] || null,
        });
    } catch (error) {
        console.error("SERVICE REQUEST REJECT ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to reject service request",
            error: error.message,
        });
    }
});

router.put("/service-request/approve/:request_id", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const modifiedBy = req.headers["username"] || "";
        const request_id = String(req.params.request_id || "").trim();

        if (!request_id) {
            return res.status(400).json({
                success: false,
                message: "request_id is required",
            });
        }

        const result = await createTaskFromServiceRequest({
            branch_id,
            request_id,
            createdBy: modifiedBy,
            taskPayload: req.body || {},
        });

        if (result.error) {
            return res.status(result.error.status).json({
                success: false,
                message: result.error.message,
            });
        }

        return res.status(200).json({
            success: true,
            message: "Service request approved and task created successfully",
            data: result.data,
        });
    } catch (error) {
        console.error("SERVICE REQUEST APPROVE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to approve service request",
            error: error.message,
        });
    }
});

export default router;
