import express from 'express';
const router = express.Router();

import pool from "../db.js";
import { auth, validateBranch } from '../middleware/auth.js';
import { UNIQUE_RANDOM_STRING, RANDOM_STRING, USER_DATA, TODAY_DATE, SET_OPENING_BALANCE, ID_LENGTH } from "../helpers/function.js";
import { buildProfileImageUrl } from "../helpers/mediaUrl.js";
import multer from 'multer';
import xlsx from 'xlsx';
import moment from 'moment';
import { runInNewContext } from 'vm';

// Helper function to get table columns
async function getTableColumns(tableName) {
    const [rows] = await pool.query(`SHOW COLUMNS FROM \`${tableName}\``);
    return new Set(rows.map(r => r.Field));
}

// Helper function to insert row with only valid columns
async function insertRow(tableName, data) {
    const columns = await getTableColumns(tableName);
    const entries = Object.entries(data).filter(([k]) => columns.has(k));

    if (entries.length === 0) {
        throw new Error(`No valid columns to insert into ${tableName}`);
    }

    const keys = entries.map(([k]) => `\`${k}\``).join(", ");
    const placeholders = entries.map(() => "?").join(", ");
    const values = entries.map(([, v]) => v);

    const [result] = await pool.query(
        `INSERT INTO \`${tableName}\` (${keys}) VALUES (${placeholders})`,
        values
    );

    return result;
}

// --------------- group ---------------
router.post("/create", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();

    try {
        const { name, remark } = req.body || {};
        const createdBy = req.headers["username"] || "";
        const { branch_id } = req;

        /* ===============================
           🔒 Validation
        =============================== */
        if (!name || name.trim() === "") {
            return res.status(400).json({
                success: false,
                message: "Group name is required"
            });
        }

        /* ===============================
           🔍 Check duplicate group
        =============================== */
        const [existingGroup] = await conn.query(
            `SELECT group_id
             FROM groups
             WHERE name = ?
               AND branch_id = ?
               AND is_deleted = '0'
             LIMIT 1`,
            [name.trim(), branch_id]
        );

        if (existingGroup.length > 0) {
            return res.status(409).json({
                success: false,
                message: "A group with this name already exists in this branch"
            });
        }

        await conn.beginTransaction();

        const group_id = await UNIQUE_RANDOM_STRING("groups", "group_id", { conn });

        /* ===============================
           ➕ Insert group
        =============================== */
        await conn.query(
            `INSERT INTO groups
             (group_id, branch_id, name, remark, create_by, modify_by, status, is_deleted, create_date, modify_date)
             VALUES (?, ?, ?, ?, ?, ?, '1', '0', NOW(), NOW())`,
            [
                group_id,
                branch_id,
                name.trim(),
                remark || null,
                createdBy,
                createdBy
            ]
        );

        await conn.commit();

        return res.status(200).json({
            success: true,
            message: "Group created successfully",
            data: {
                group_id,
                branch_id,
                name: name.trim(),
                remark: remark || null,
                status: "1"
            }
        });

    } catch (error) {
        await conn.rollback();
        console.error("Error creating group:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to create group",
            error: error.message
        });
    } finally {
        conn.release();
    }
});

router.get("/list", auth, validateBranch, async (req, res) => {
    try {
        const search = req.query.search;
        const { page = 1, limit = 20 } = req.query;
        const { branch_id } = req;

        const pageNum = Number(page) || 1;
        const limitNum = Number(limit) || 20;
        const offset = (pageNum - 1) * limitNum;

        let baseQuery = `
            FROM groups g
            LEFT JOIN group_firms gf 
                ON gf.group_id = g.group_id
                AND gf.is_deleted = '0'
            WHERE g.is_deleted = '0'
            AND g.branch_id = ?
        `;

        const queryParams = [branch_id];

        // 🔍 Search filter
        if (search && search.trim() !== '') {
            const searchPattern = `%${search.trim()}%`;
            baseQuery += `
                AND (
                    g.name LIKE ?
                    OR g.remark LIKE ?
                    OR g.group_id LIKE ?
                )
            `;
            queryParams.push(searchPattern, searchPattern, searchPattern);
        }

        // 🔢 Count total groups (important: COUNT DISTINCT)
        const countQuery = `
            SELECT COUNT(DISTINCT g.id) AS total
            ${baseQuery}
        `;
        const [countResult] = await pool.query(countQuery, queryParams);
        const total = countResult[0]?.total || 0;

        // 📦 Main list query with firm count
        const listQuery = `
            SELECT 
                g.group_id,
                g.branch_id,
                g.name,
                g.remark,
                g.status,
                g.create_by,
                g.create_date,
                g.modify_by,
                g.modify_date,
                COUNT(gf.id) AS firm_count
            ${baseQuery}
            GROUP BY g.id
            ORDER BY g.name ASC
            LIMIT ? OFFSET ?
        `;

        const listParams = [...queryParams, limitNum, offset];
        const [rows] = await pool.query(listQuery, listParams);

        // 👤 Attach user objects (unchanged logic)
        const transformedRows = await Promise.all(
            rows.map(async (row) => {
                let createByObj = { name: "", mobile: "", email: "" };
                if (row.create_by) {
                    const user = await USER_DATA(row.create_by);
                    createByObj = {
                        name: user?.name || "",
                        mobile: user?.mobile || "",
                        email: user?.email || ""
                    };
                }

                let modifyByObj = { name: "", mobile: "", email: "" };
                if (row.modify_by) {
                    const user = await USER_DATA(row.modify_by);
                    modifyByObj = {
                        name: user?.name || "",
                        mobile: user?.mobile || "",
                        email: user?.email || ""
                    };
                }

                return {
                    ...row,
                    is_active: String(row.status) === '1',
                    create_by: createByObj,
                    modify_by: modifyByObj
                };
            })
        );

        return res.status(200).json({
            success: true,
            message: "Group list retrieved successfully",
            data: transformedRows,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                total_pages: Math.ceil(total / limitNum),
                is_last_page: offset + rows.length >= total
            }
        });

    } catch (error) {
        console.error("Error fetching Group list:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch Group list",
            error: error.message
        });
    }
});

router.put("/edit", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { group_id, name, remark } = req.body || {};
        const modifyBy = req.headers["username"] || "";
        const { branch_id } = req;

        if (!group_id) {
            return res.status(400).json({
                success: false,
                message: "group_id is required",
            });
        }

        // 🔍 Check existing group & branch ownership
        const [existing] = await pool.query(
            `SELECT id, group_id, name, remark, create_by, create_date
             FROM groups
             WHERE group_id = ?
               AND branch_id = ?
               AND is_deleted = '0'`,
            [group_id, branch_id]
        );

        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Group not found",
            });
        }

        // Resolve editable fields (keep old if not provided)
        const resolvedName = name?.trim() || existing[0].name;
        const resolvedRemark = remark?.trim() || existing[0].remark;

        await conn.beginTransaction();

        await conn.query(
            `UPDATE groups
             SET name = ?,
                 remark = ?,
                 modify_by = ?,
                 modify_date = NOW()
             WHERE group_id = ?
               AND branch_id = ?
               AND is_deleted = '0'`,
            [
                resolvedName,
                resolvedRemark,
                modifyBy,
                group_id,
                branch_id,
            ]
        );

        await conn.commit();

        const create_by_user = await USER_DATA(existing[0].create_by);
        const modify_by_user = await USER_DATA(modifyBy);

        return res.status(200).json({
            success: true,
            message: "Group updated successfully",
            data: {
                group_id,
                name: resolvedName,
                remark: resolvedRemark,
                status: existing[0].status,                  // ✅ raw DB value
                is_active: existing[0].status === '1',      // ✅ boolean
                create_by: {
                    username: create_by_user?.username,
                    name: create_by_user?.name,
                    mobile: create_by_user?.mobile,
                    email: create_by_user?.email,
                },
                modify_by: {
                    username: modify_by_user?.username,
                    name: modify_by_user?.name,
                    mobile: modify_by_user?.mobile,
                    email: modify_by_user?.email,
                },
                create_date: existing[0].create_date,
                modify_date: new Date(),
            },
        });

    } catch (error) {
        await conn.rollback();
        console.error("Error updating group:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update group",
            error: error.message,
        });
    } finally {
        conn.release();
    }
});

router.put("/toggle-status", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { group_id } = req.body || {};
        const modifyBy = req.headers["username"] || "";
        const { branch_id } = req;

        if (!group_id) {
            return res.status(400).json({
                success: false,
                message: "group_id is required",
            });
        }

        // 🔍 Fetch existing group
        const [existing] = await pool.query(
            `SELECT id, group_id, status, create_by, create_date
             FROM groups
             WHERE group_id = ?
               AND branch_id = ?
               AND is_deleted = '0'`,
            [group_id, branch_id]
        );

        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Group not found",
            });
        }

        // 🔁 Toggle enum('0','1')
        const currentStatus = existing[0].status;   // '0' | '1'
        const newStatus = currentStatus === '1' ? '0' : '1';

        await conn.beginTransaction();

        await conn.query(
            `UPDATE groups
             SET status = ?,
                 modify_by = ?,
                 modify_date = NOW()
             WHERE group_id = ?
               AND branch_id = ?
               AND is_deleted = '0'`,
            [newStatus, modifyBy, group_id, branch_id]
        );

        await conn.commit();

        const create_by_user = await USER_DATA(existing[0].create_by);
        const modify_by_user = await USER_DATA(modifyBy);

        return res.status(200).json({
            success: true,
            message: "Group status toggled successfully",
            data: {
                group_id,
                status: newStatus,                 // ✅ raw DB value
                is_active: newStatus === '1',      // ✅ boolean
                create_by: {
                    username: create_by_user?.username,
                    name: create_by_user?.name,
                    mobile: create_by_user?.mobile,
                    email: create_by_user?.email,
                },
                modify_by: {
                    username: modify_by_user?.username,
                    name: modify_by_user?.name,
                    mobile: modify_by_user?.mobile,
                    email: modify_by_user?.email,
                },
                create_date: existing[0].create_date,
                modify_date: new Date(),
            },
        });

    } catch (error) {
        await conn.rollback();
        console.error("Error toggling group status:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to toggle group status",
            error: error.message,
        });
    } finally {
        conn.release();
    }
});

router.delete("/delete", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { group_id } = req.body || {};
        const modifiedBy = req.headers["username"] || "";
        const { branch_id } = req;

        if (!group_id) {
            return res.status(400).json({
                success: false,
                message: "group_id is required",
            });
        }

        // 🔍 Verify group exists & belongs to branch
        const [existing] = await pool.query(
            `SELECT id, group_id
             FROM groups
             WHERE group_id = ?
               AND branch_id = ?
               AND is_deleted = '0'`,
            [group_id, branch_id]
        );

        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Group record not found",
            });
        }

        // 🚫 Check if group has firms mapped
        const [firmCountResult] = await pool.query(
            `SELECT COUNT(id) AS firm_count
             FROM group_firms
             WHERE group_id = ?
               AND is_deleted = '0'`,
            [group_id]
        );

        const firmCount = firmCountResult[0]?.firm_count || 0;

        if (firmCount > 0) {
            return res.status(400).json({
                success: false,
                message: "Group cannot be deleted because it has associated firms",
                data: {
                    firm_count: firmCount,
                },
            });
        }

        await conn.beginTransaction();

        await conn.query(
            `UPDATE groups
             SET is_deleted = '1',
                 deleted_by = ?,
                 modify_by = ?,
                 modify_date = NOW()
             WHERE group_id = ?
               AND branch_id = ?`,
            [modifiedBy, modifiedBy, group_id, branch_id]
        );

        await conn.commit();

        return res.status(200).json({
            success: true,
            message: "Group deleted successfully",
        });

    } catch (error) {
        await conn.rollback();
        console.error("Error deleting group:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to delete group",
            error: error.message,
        });
    } finally {
        conn.release();
    }
});

// --------------- group_firm ---------------
router.post('/group-firms/add-firms', auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();


    try {
        const { group_id, firm_ids } = req.body || {};
        const createdBy = req.headers["username"] || "";
        const branch_id = req.branch_id; // ✅ FIXED
        console.log(createdBy);
        /* ===============================
           🔒 Input Validation
        =============================== */
        if (!group_id) {
            return res.status(400).json({
                success: false,
                message: "group_id is required"
            });
        }

        if (!firm_ids || (Array.isArray(firm_ids) && firm_ids.length === 0)) {
            return res.status(400).json({
                success: false,
                message: "firm_ids is required"
            });
        }

        const firmIdArray = Array.isArray(firm_ids) ? firm_ids : [firm_ids];

        await conn.beginTransaction();

        /* ===============================
           🔍 Validate group belongs to branch
        =============================== */
        const [groupExists] = await conn.query(
            `SELECT group_id 
             FROM groups 
             WHERE group_id = ? 
               AND branch_id = ? 
               AND is_deleted = '0'`,
            [group_id, branch_id]
        );

        if (groupExists.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Group not found or does not belong to this branch"
            });
        }

        /* ===============================
           🔍 Validate firms belong to branch
        =============================== */
        const [validFirms] = await conn.query(
            `SELECT firm_id 
             FROM firms 
             WHERE firm_id IN (?) 
               AND branch_id = ? 
               AND is_deleted = '0'`,
            [firmIdArray, branch_id]
        );

        if (validFirms.length !== firmIdArray.length) {
            return res.status(404).json({
                success: false,
                message: "One or more firms not found or do not belong to this branch"
            });
        }

        const validFirmIds = validFirms.map(f => f.firm_id);

        /* ===============================
           🚫 Prevent duplicate mapping
        =============================== */
        const [existingMappings] = await conn.query(
            `SELECT firm_id 
             FROM group_firms 
             WHERE group_id = ? 
               AND firm_id IN (?) 
               AND is_deleted = '0'`,
            [group_id, validFirmIds]
        );

        const alreadyMapped = existingMappings.map(r => r.firm_id);

        /* ===============================
           ➕ Insert only new mappings
        =============================== */
        const insertableFirmIds = validFirmIds.filter(
            id => !alreadyMapped.includes(id)
        );

        if (insertableFirmIds.length === 0) {
            return res.status(409).json({
                success: false,
                message: "All firms are already mapped to this group"
            });
        }

        for (const firm_id of insertableFirmIds) {
            const unique_id = await UNIQUE_RANDOM_STRING("group_firms", "unique_id", { conn, length: ID_LENGTH });
            await conn.query(
                `INSERT INTO group_firms
                 (unique_id, group_id, firm_id, create_by, modify_by, is_deleted, create_date, modify_date)
                 VALUES (?, ?, ?, ?, ?, '0', NOW(), NOW())`,
                [
                    unique_id,
                    group_id,
                    firm_id,
                    createdBy,
                    createdBy
                ]
            );
        }

        await conn.commit();

        return res.status(200).json({
            success: true,
            message: "Firm(s) added to group successfully",
            data: {
                group_id,
                firms_added: insertableFirmIds,
                already_exists: alreadyMapped
            }
        });

    } catch (error) {
        await conn.rollback();
        console.error("Add firms error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to add firms to group",
            error: error.message
        });
    } finally {
        conn.release();
    }
});

router.get("/group-firms/list/", auth, validateBranch, async (req, res) => {
    try {
        /* ===============================
           ✅ Read params
        =============================== */
        const { group_id } = req.query;
        const { search, page = 1, limit = 20 } = req.query;
        const branch_id = req.branch_id;

        if (!group_id) {
            return res.status(400).json({
                success: false,
                message: "group_id is required"
            });
        }

        const pageNum = Number(page) || 1;
        const limitNum = Number(limit) || 20;
        const offset = (pageNum - 1) * limitNum;

        /* ===============================
           🔹 Fetch group info first
        =============================== */
        const [groupRows] = await pool.query(
            `SELECT group_id, name, remark, status 
             FROM groups 
             WHERE group_id = ? 
               AND branch_id = ? 
               AND is_deleted = '0'`,
            [group_id, branch_id]
        );

        if (!groupRows[0]) {
            return res.status(404).json({
                success: false,
                message: "Group not found"
            });
        }

        const groupMeta = {
            group_id: groupRows[0].group_id,
            group_name: groupRows[0].name,
            group_remark: groupRows[0].remark,
            group_status: groupRows[0].status,
            is_active: String(groupRows[0].status) === "1"
        };

        /* ===============================
           🔧 Base Query for firms
        =============================== */
        let baseQuery = `
            FROM group_firms gf
            INNER JOIN firms f
                ON f.firm_id = gf.firm_id
                AND f.is_deleted = '0'
            WHERE gf.is_deleted = '0'
              AND gf.group_id = ?
        `;

        const queryParams = [group_id];

        /* ===============================
           🔍 Global Search
        =============================== */
        if (search && search.trim() !== "") {
            const searchPattern = `%${search.trim()}%`;
            baseQuery += `
                AND (
                    f.username LIKE ? OR
                    f.firm_name LIKE ? OR
                    f.firm_type LIKE ? OR
                    f.file_no LIKE ? OR
                    f.gst_no LIKE ? OR
                    f.pan_no LIKE ? OR
                    f.tan_no LIKE ? OR
                    f.vat_no LIKE ? OR
                    f.cin_no LIKE ? OR
                    f.address_line_1 LIKE ? OR
                    f.address_line_2 LIKE ? OR
                    f.city LIKE ? OR
                    f.district LIKE ? OR
                    f.state LIKE ? OR
                    f.country LIKE ? OR
                    f.pincode LIKE ?
                )
            `;
            queryParams.push(...Array(17).fill(searchPattern));
        }

        /* ===============================
           🔢 Total Count
        =============================== */
        const [countResult] = await pool.query(
            `SELECT COUNT(gf.id) AS total ${baseQuery}`,
            queryParams
        );
        const total = countResult[0]?.total || 0;

        /* ===============================
           📦 Main Query
        =============================== */
        const [rows] = await pool.query(
            `
            SELECT
                gf.id            AS group_firm_id,
                gf.unique_id     AS group_firm_unique_id,
                gf.create_date   AS mapping_create_date,
                gf.modify_date   AS mapping_modify_date,
                gf.create_by,
                gf.modify_by,
                f.*
            ${baseQuery}
            ORDER BY gf.create_date DESC
            LIMIT ? OFFSET ?
            `,
            [...queryParams, limitNum, offset]
        );

        /* ===============================
           🧠 Transform Response
        =============================== */
        const firms = await Promise.all(
            rows.map(async (row) => {
                const createUser = row.create_by ? await USER_DATA(row.create_by) : null;
                const modifyUser = row.modify_by ? await USER_DATA(row.modify_by) : null;

                return {
                    index_id: row.group_firm_id,
                    unique_id: row.group_firm_unique_id,

                    firm: {
                        firm_id: row.firm_id,
                        username: row.username,
                        firm_name: row.firm_name,
                        firm_type: row.firm_type,
                        file_no: row.file_no,
                        status: row.status,
                        is_active: String(row.status) === "1",
                        gst: row.gst_no || null,
                        pan: row.pan_no || null,
                        tan: row.tan_no || null,
                        vat: row.vat_no || null,
                        cin: row.cin_no || null,
                        address_line_1: row.address_line_1,
                        address_line_2: row.address_line_2,
                        city: row.city,
                        district: row.district,
                        state: row.state,
                        country: row.country,
                        pincode: row.pincode
                    },

                    create_by: {
                        username: createUser?.username || "",
                        name: createUser?.name || "",
                        mobile: createUser?.mobile || "",
                        email: createUser?.email || ""
                    },

                    modify_by: {
                        username: modifyUser?.username || "",
                        name: modifyUser?.name || "",
                        mobile: modifyUser?.mobile || "",
                        email: modifyUser?.email || ""
                    },

                    create_date: row.mapping_create_date,
                    modify_date: row.mapping_modify_date
                };
            })
        );

        /* ===============================
           ✅ Final Response
        =============================== */
        return res.status(200).json({
            success: true,
            message: "Group-wise firm list retrieved successfully",
            data: {
                group: groupMeta,
                firms
            },
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                total_pages: Math.ceil(total / limitNum),
                is_last_page: offset + firms.length >= total
            }
        });

    } catch (error) {
        console.error("Error fetching group-wise firms:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch group-wise firms",
            error: error.message
        });
    }
});

router.delete("/group-firms/remove", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();

    try {
        const { group_id, firm_ids } = req.body || {};
        const modifiedBy = req.headers["username"] || "";
        const branch_id = req.branch_id;

        /* ===============================
           🔒 Validation
        =============================== */
        if (!group_id) {
            return res.status(400).json({
                success: false,
                message: "group_id is required"
            });
        }

        if (!firm_ids || (Array.isArray(firm_ids) && firm_ids.length === 0)) {
            return res.status(400).json({
                success: false,
                message: "firm_ids is required"
            });
        }

        const firmIdArray = Array.isArray(firm_ids) ? firm_ids : [firm_ids];

        await conn.beginTransaction();

        /* ===============================
           🔍 Validate group belongs to branch
        =============================== */
        const [groupExists] = await conn.query(
            `SELECT group_id
             FROM groups
             WHERE group_id = ?
               AND branch_id = ?
               AND is_deleted = '0'`,
            [group_id, branch_id]
        );

        if (groupExists.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Group not found or does not belong to this branch"
            });
        }

        /* ===============================
           🔍 Check existing mappings
        =============================== */
        const [existingMappings] = await conn.query(
            `SELECT firm_id
             FROM group_firms
             WHERE group_id = ?
               AND firm_id IN (?)
               AND is_deleted = '0'`,
            [group_id, firmIdArray]
        );

        if (existingMappings.length === 0) {
            return res.status(404).json({
                success: false,
                message: "No matching firm mappings found for this group"
            });
        }

        const mappedFirmIds = existingMappings.map(r => r.firm_id);

        /* ===============================
           ❌ Soft delete mappings
        =============================== */
        await conn.query(
            `UPDATE group_firms
             SET is_deleted = '1',
                 deleted_by = ?,
                 modify_by = ?,
                 modify_date = NOW()
             WHERE group_id = ?
               AND firm_id IN (?)
               AND is_deleted = '0'`,
            [modifiedBy, modifiedBy, group_id, mappedFirmIds]
        );

        await conn.commit();

        return res.status(200).json({
            success: true,
            message: "Firm(s) removed from group successfully",
            data: {
                group_id,
                firms_removed: mappedFirmIds
            }
        });

    } catch (error) {
        await conn.rollback();
        console.error("Remove group firms error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to remove firms from group",
            error: error.message
        });
    } finally {
        conn.release();
    }
});
/**
 * Get all active groups OR specific group details with firms and profile details
 * GET /api/email/groups/all
 * Query params:
 *   - group_id (optional) - Get specific group details
 *   - search (optional) - Search groups by name
 *   - page (optional) - Page number for pagination
 *   - limit (optional) - Items per page
 *   - show_inactive (optional) - Set to 'true' to show inactive profiles (default: false)
 */
router.get("/groups/all", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { group_id = null, search = '', page = 1, limit = 100, show_inactive = 'false' } = req.query;
        
        const pageNum = parseInt(page) || 1;
        const limitNum = parseInt(limit) || 100;
        const offset = (pageNum - 1) * limitNum;
        const includeInactive = show_inactive === 'true';
        
        // Helper function to get group details with firms
        async function getGroupDetails(groupId) {
            // Get group details
            const [groupRows] = await pool.query(
                `SELECT g.group_id, g.name as group_name, g.remark, g.status, 
                        g.is_deleted, g.create_date, g.modify_date, g.create_by
                 FROM groups g
                 WHERE g.group_id = ? AND g.branch_id = ? AND g.is_deleted = '0'`,
                [groupId, branch_id]
            );
            
            if (!groupRows.length) return null;
            
            const group = groupRows[0];
            
            // Get count of firms in this group
            const [firmCountResult] = await pool.query(
                `SELECT COUNT(DISTINCT gf.firm_id) as total
                 FROM group_firms gf
                 INNER JOIN firms f ON f.firm_id = gf.firm_id AND f.is_deleted = '0'
                 WHERE gf.group_id = ? AND gf.is_deleted = '0'`,
                [groupId]
            );
            
            // Get all firms in this group with profile details - ONLY ACTIVE PROFILES
            let firmsQuery = `
                SELECT 
                    f.firm_id, f.firm_name, f.firm_type, f.gst_no, f.pan_no, f.tan_no, 
                    f.vat_no, f.cin_no, f.file_no, f.address_line_1, f.address_line_2,
                    f.city, f.district, f.state, f.country, f.pincode, f.status as firm_status,
                    f.username, f.create_date as firm_create_date,
                    p.name as client_name, p.email, p.mobile, p.country_code,
                    p.pan_number, p.gender, p.date_of_birth, p.user_type,
                    p.address_line_1 as profile_address, p.city as profile_city, 
                    p.state as profile_state, p.pincode as profile_pincode,
                    p.status as profile_status, p.image as profile_image, 
                    p.create_date as profile_create_date
                FROM group_firms gf
                INNER JOIN firms f ON f.firm_id = gf.firm_id AND f.is_deleted = '0'
                INNER JOIN profile p ON p.username = f.username
                WHERE gf.group_id = ? 
                  AND gf.is_deleted = '0'
                  AND p.status = '1'
            `;
            
            const queryParams = [groupId];
            
            // Add email condition
            firmsQuery += ` AND p.email IS NOT NULL AND p.email != ''`;
            
            firmsQuery += ` GROUP BY f.firm_id ORDER BY f.firm_name ASC`;
            
            const [firms] = await pool.query(firmsQuery, queryParams);
            
            // Remove duplicates by firm_id (keep first occurrence)
            const uniqueFirmsMap = new Map();
            for (const firm of firms) {
                if (!uniqueFirmsMap.has(firm.firm_id)) {
                    uniqueFirmsMap.set(firm.firm_id, firm);
                }
            }
            const uniqueFirms = Array.from(uniqueFirmsMap.values());
            
            // Filter firms that have valid email (already filtered in SQL but double-check)
            const validFirms = uniqueFirms.filter(firm => {
                const hasEmail = firm.email && firm.email.trim() !== '';
                const isActive = firm.profile_status === '1' || firm.profile_status === 'active';
                return hasEmail && isActive;
            });
            
            // Get create_by user info
            let createByObj = { name: "", mobile: "", email: "", username: "" };
            if (group.create_by) {
                const user = await USER_DATA(group.create_by);
                if (user) {
                    createByObj = {
                        username: user.username || "",
                        name: user.name || "",
                        mobile: user.mobile || "",
                        email: user.email || ""
                    };
                }
            }
            
            // Calculate statistics (only from active profiles)
            const uniqueStates = [...new Set(uniqueFirms.map(f => f.state).filter(Boolean))];
            const uniqueCities = [...new Set(uniqueFirms.map(f => f.city).filter(Boolean))];
            const activeProfiles = uniqueFirms.length;
            const totalRevenue = uniqueFirms.reduce((sum, f) => sum + (Number(f.fees) || 0), 0);
            
            // Get firm count from group_firms (total firms in group, including inactive)
            const [totalFirmsCount] = await pool.query(
                `SELECT COUNT(DISTINCT gf.firm_id) as total
                 FROM group_firms gf
                 WHERE gf.group_id = ? AND gf.is_deleted = '0'`,
                [groupId]
            );
            
            return {
                group_id: group.group_id,
                group_name: group.group_name,
                remark: group.remark,
                status: group.status,
                is_active: group.status === '1',
                create_date: group.create_date,
                modify_date: group.modify_date,
                created_by: createByObj,
                statistics: {
                    total_firms_in_group: totalFirmsCount[0]?.total || 0,
                    active_firms_with_email: validFirms.length,
                    active_profiles: activeProfiles,
                    states: uniqueStates,
                    cities: uniqueCities,
                    total_revenue: totalRevenue
                },
                firms: validFirms.map(firm => ({
                    firm_id: firm.firm_id,
                    firm_name: firm.firm_name,
                    firm_type: firm.firm_type,
                    firm_status: firm.firm_status,
                    tax_details: {
                        gst_no: firm.gst_no,
                        pan_no: firm.pan_no,
                        tan_no: firm.tan_no,
                        vat_no: firm.vat_no,
                        cin_no: firm.cin_no
                    },
                    file_no: firm.file_no,
                    address: {
                        line1: firm.address_line_1,
                        line2: firm.address_line_2,
                        city: firm.city,
                        district: firm.district,
                        state: firm.state,
                        country: firm.country,
                        pincode: firm.pincode
                    },
                    created_at: firm.firm_create_date,
                    client: {
                        username: firm.username,
                        name: firm.client_name,
                        email: firm.email,
                        mobile: firm.mobile,
                        country_code: firm.country_code,
                        pan_number: firm.pan_number,
                        gender: firm.gender,
                        date_of_birth: firm.date_of_birth,
                        user_type: firm.user_type,
                        profile_status: firm.profile_status,
                        is_active_profile: firm.profile_status === '1',
                        address: {
                            line1: firm.profile_address,
                            city: firm.profile_city,
                            state: firm.profile_state,
                            pincode: firm.profile_pincode
                        },
                        image: buildProfileImageUrl(firm.profile_image),
                        created_at: firm.profile_create_date
                    }
                }))
            };
        }
        
        // ========== IF group_id is provided, return single group ==========
        if (group_id && group_id.trim() !== '') {
            const groupDetails = await getGroupDetails(group_id);
            
            if (!groupDetails) {
                return res.status(404).json({
                    success: false,
                    message: "Group not found"
                });
            }
            
            return res.status(200).json({
                success: true,
                message: "Group details retrieved successfully",
                data: groupDetails
            });
        }
        
        // ========== OTHERWISE, return all groups with pagination ==========
        // Check if there are any groups at all
        const [allGroupsCheck] = await pool.query(
            `SELECT COUNT(*) as total FROM groups WHERE branch_id = ? AND is_deleted = '0'`,
            [branch_id]
        );
        console.log(`Total groups in DB for branch ${branch_id}:`, allGroupsCheck[0].total);
        
        // Get all active groups
        let groupsQuery = `
            SELECT g.group_id, g.name as group_name, g.remark, g.status, 
                   g.is_deleted, g.create_date, g.modify_date, g.create_by
            FROM groups g
            WHERE g.branch_id = ? AND g.is_deleted = '0'
        `;
        
        const queryParams = [branch_id];
        
        if (search && search.trim() !== '') {
            groupsQuery += ` AND g.name LIKE ?`;
            queryParams.push(`%${search}%`);
        }
        
        groupsQuery += ` ORDER BY g.name ASC LIMIT ? OFFSET ?`;
        queryParams.push(limitNum, offset);
        
        const [groups] = await pool.query(groupsQuery, queryParams);
        console.log(`Found ${groups.length} groups matching criteria`);
        
        // Get total count
        let countQuery = `
            SELECT COUNT(DISTINCT g.group_id) as total
            FROM groups g
            WHERE g.branch_id = ? AND g.is_deleted = '0'
        `;
        const countParams = [branch_id];
        
        if (search && search.trim() !== '') {
            countQuery += ` AND g.name LIKE ?`;
            countParams.push(`%${search}%`);
        }
        
        const [totalResult] = await pool.query(countQuery, countParams);
        const total = totalResult[0]?.total || 0;
        
        const groupsWithDetails = [];
        
        for (const group of groups) {
            const groupDetails = await getGroupDetails(group.group_id);
            if (groupDetails) {
                groupsWithDetails.push(groupDetails);
            }
        }
        
        return res.status(200).json({
            success: true,
            message: "Groups retrieved successfully",
            data: {
                groups: groupsWithDetails,
                debug_info: {
                    total_groups_in_db: allGroupsCheck[0].total,
                    groups_returned: groups.length,
                    note: "Only active profiles (status='1') with email are shown"
                }
            },
            pagination: {
                page: pageNum,
                limit: limitNum,
                total: total,
                total_pages: Math.ceil(total / limitNum),
                is_last_page: offset + groups.length >= total
            }
        });
        
    } catch (error) {
        console.error("Get groups error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch groups",
            error: error.message
        });
    }
});

// Configure multer for memory storage and size limits
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB size limit
    fileFilter: (req, file, cb) => {
        if (file.mimetype.includes('csv') ||
            file.mimetype.includes('spreadsheet') ||
            file.originalname.match(/\.(csv|xls|xlsx)$/)) {
            cb(null, true);
        } else {
            cb(new Error('Only CSV and Excel files allowed'));
        }
    }
}).single('file');

// Helper function to detect columns
function detectColumns(headers) {
    const mapped = {};
    const namePatterns = ['name', 'full name', 'fullname', 'client name', 'client_name'];
    const mobilePatterns = ['mobile', 'phone', 'mobile number', 'mobile_no', 'phone number', 'phone_no'];
    const emailPatterns = ['email', 'e-mail', 'mail', 'email address', 'email_id', 'emailid'];
    const panPatterns = ['pan', 'pan number', 'pan_no', 'pan_number', 'client_pan', 'client pan'];
    const genderPatterns = ['gender', 'sex'];
    const dobPatterns = ['dob', 'date of birth', 'date_of_birth', 'birth date', 'birth_date', 'dateofbirth'];
    const careOfPatterns = ['care of', 'care_of', 'c/o', 'co'];
    const guardianPatterns = ['guardian', 'guardian name', 'guardian_name'];
    const countryCodePatterns = ['country code', 'country_code', 'code'];
    const statePatterns = ['state'];
    const districtPatterns = ['district'];
    const cityPatterns = ['city', 'town', 'village', 'city/town/village', 'village_town', 'town_or_village'];
    const pincodePatterns = ['pincode', 'pin', 'zip', 'zipcode', 'postal code', 'postal_code'];
    const address1Patterns = ['address line 1', 'address_line_1', 'address1', 'address 1'];
    const address2Patterns = ['address line 2', 'address_line_2', 'address2', 'address 2'];

    // Firm columns
    const firmNamePatterns = ['firm', 'firm name', 'firm_name', 'business name', 'business_name', 'company', 'company name'];
    const businessTypePatterns = ['business type', 'business_type', 'firm type', 'firm_type', 'type'];
    const firmPanPatterns = ['firm pan', 'firm_pan', 'business pan', 'business_pan', 'firm pan number', 'firm_pan_no'];
    const gstPatterns = ['gst', 'gstin', 'gst number', 'gst_number', 'gst_no'];
    const tanPatterns = ['tan', 'tan number', 'tan_number', 'tan_no'];
    const vatPatterns = ['vat', 'vat number', 'vat_number', 'vat_no'];
    const cinPatterns = ['cin', 'cin number', 'cin_number', 'cin_no'];
    const fileNoPatterns = ['file', 'file number', 'file_number', 'file_no'];

    // Opening Balance
    const balancePatterns = ['opening balance', 'opening_balance', 'balance', 'opening balance amount', 'opening_balance_amount'];
    const balanceTypePatterns = ['opening balance type', 'opening_balance_type', 'balance type', 'type'];
    const balanceDatePatterns = ['opening balance date', 'opening_balance_date', 'balance date'];

    const matchPattern = (header, patterns) => {
        const cleaned = String(header || '').toLowerCase().trim();
        const cleanedCompressed = cleaned.replace(/[\s_-]/g, '');
        return patterns.some(p => cleaned === p || cleanedCompressed === p.replace(/[\s_-]/g, ''));
    };

    for (const header of headers) {
        if (matchPattern(header, namePatterns)) mapped.name = header;
        else if (matchPattern(header, mobilePatterns)) mapped.mobile = header;
        else if (matchPattern(header, emailPatterns)) mapped.email = header;
        else if (matchPattern(header, panPatterns)) mapped.pan_number = header;
        else if (matchPattern(header, genderPatterns)) mapped.gender = header;
        else if (matchPattern(header, dobPatterns)) mapped.date_of_birth = header;
        else if (matchPattern(header, careOfPatterns)) mapped.care_of = header;
        else if (matchPattern(header, guardianPatterns)) mapped.guardian_name = header;
        else if (matchPattern(header, countryCodePatterns)) mapped.country_code = header;
        else if (matchPattern(header, statePatterns)) mapped.state = header;
        else if (matchPattern(header, districtPatterns)) mapped.district = header;
        else if (matchPattern(header, cityPatterns)) mapped.city = header;
        else if (matchPattern(header, pincodePatterns)) mapped.pincode = header;
        else if (matchPattern(header, address1Patterns)) mapped.address_line_1 = header;
        else if (matchPattern(header, address2Patterns)) mapped.address_line_2 = header;
        else if (matchPattern(header, firmNamePatterns)) mapped.firm_name = header;
        else if (matchPattern(header, businessTypePatterns)) mapped.firm_type = header;
        else if (matchPattern(header, firmPanPatterns)) mapped.firm_pan = header;
        else if (matchPattern(header, gstPatterns)) mapped.gst_no = header;
        else if (matchPattern(header, tanPatterns)) mapped.tan_no = header;
        else if (matchPattern(header, vatPatterns)) mapped.vat_no = header;
        else if (matchPattern(header, cinPatterns)) mapped.cin_no = header;
        else if (matchPattern(header, fileNoPatterns)) mapped.file_no = header;
        else if (matchPattern(header, balancePatterns)) mapped.opening_balance = header;
        else if (matchPattern(header, balanceTypePatterns)) mapped.opening_balance_type = header;
        else if (matchPattern(header, balanceDatePatterns)) mapped.opening_balance_date = header;
    }
    return mapped;
}

// Parse CSV manually or parse Excel sheet
function parseCSVLine(line) {
    const result = [];
    let inQuote = false;
    let currentValue = '';

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            inQuote = !inQuote;
        } else if (char === ',' && !inQuote) {
            result.push(currentValue.trim().replace(/^"|"$/g, ''));
            currentValue = '';
        } else {
            currentValue += char;
        }
    }
    result.push(currentValue.trim().replace(/^"|"$/g, ''));
    return result;
}

export async function handleGroupImport(req, res, createdBy, branch_id) {
    const isPreview = req.query.preview === 'true';
    const fileBuffer = req.file.buffer;
    const originalName = req.file.originalname;
    const isCSV = originalName.toLowerCase().endsWith('.csv');
    const { group_id } = req.body || {};

    // Verify group exists and belongs to this branch
    const [groupExists] = await pool.query(
        `SELECT group_id, name FROM groups WHERE group_id = ? AND branch_id = ? AND is_deleted = '0'`,
        [group_id, branch_id]
    );
    if (groupExists.length === 0) {
        return res.status(404).json({
            success: false,
            message: "Group not found or does not belong to this branch"
        });
    }

    let headers = [];
    let rows = [];

    if (isCSV) {
        const content = fileBuffer.toString('utf-8');
        const lines = content.split(/\r?\n/);
        if (lines.length === 0 || !lines[0].trim()) {
            return res.status(400).json({ success: false, message: "Uploaded CSV file is empty" });
        }
        headers = parseCSVLine(lines[0]);
        for (let i = 1; i < lines.length; i++) {
            if (!lines[i].trim()) continue;
            const values = parseCSVLine(lines[i]);
            const row = {};
            headers.forEach((h, idx) => {
                if (h) row[h] = values[idx] !== undefined ? values[idx] : '';
            });
            rows.push(row);
        }
    } else {
        const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
        if (workbook.SheetNames.length === 0) {
            return res.status(400).json({ success: false, message: "Uploaded Excel file has no sheets" });
        }
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = xlsx.utils.sheet_to_json(sheet, { defval: '' });
        rows = data;
        if (rows.length > 0) {
            headers = Object.keys(rows[0]);
        }
    }

    if (rows.length === 0) {
        return res.status(400).json({ success: false, message: "No data rows found in the uploaded file" });
    }

    // Support dynamic column mapping
    let customMapping = {};
    const rawMapping = req.body.column_mapping || req.body.column_mappings;
    if (rawMapping) {
        let parsed = null;
        if (typeof rawMapping === 'string') {
            try {
                parsed = JSON.parse(rawMapping);
            } catch (e) {
                console.error("Failed to parse column_mapping:", e);
            }
        } else if (typeof rawMapping === 'object' && rawMapping !== null) {
            parsed = rawMapping;
        }

        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            // Sanitize keys and values to prevent prototype pollution and ensure only string mappings are used
            for (const [key, value] of Object.entries(parsed)) {
                if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
                    continue;
                }
                if (typeof value === 'string') {
                    customMapping[key] = value;
                }
            }
        }
    }

    // Normalize custom mapping value to match exact case of headers if they match case-insensitively
    const normalizedCustomMapping = {};
    const invalidMappings = [];
    for (const [key, colName] of Object.entries(customMapping)) {
        if (colName) {
            const exactMatch = headers.find(h => h === colName);
            if (exactMatch) {
                normalizedCustomMapping[key] = exactMatch;
            } else {
                const caseInsensitiveMatch = headers.find(h => h.toLowerCase() === colName.toLowerCase());
                if (caseInsensitiveMatch) {
                    normalizedCustomMapping[key] = caseInsensitiveMatch;
                } else {
                    invalidMappings.push(`"${colName}" (mapped to "${key}")`);
                }
            }
        }
    }
    if (invalidMappings.length > 0) {
        return res.status(400).json({
            success: false,
            message: `The following mapped columns were not found in the uploaded file: ${invalidMappings.join(', ')}`
        });
    }

    const mappedCols = { ...detectColumns(headers), ...normalizedCustomMapping };

    // Check minimum required headers mapping
    const missingRequiredHeaders = [];
    if (!mappedCols.name) missingRequiredHeaders.push("Client Name");
    if (!mappedCols.mobile) missingRequiredHeaders.push("Mobile");
    if (!mappedCols.email) missingRequiredHeaders.push("Email");
    if (!mappedCols.pan_number) missingRequiredHeaders.push("PAN Number");
    if (!mappedCols.gender) missingRequiredHeaders.push("Gender");
    if (!mappedCols.date_of_birth) missingRequiredHeaders.push("Date of Birth");
    if (!mappedCols.state) missingRequiredHeaders.push("State");
    if (!mappedCols.district) missingRequiredHeaders.push("District");
    if (!mappedCols.city) missingRequiredHeaders.push("City/Town/Village");
    if (!mappedCols.pincode) missingRequiredHeaders.push("Pincode");

    if (missingRequiredHeaders.length > 0) {
        return res.status(400).json({
            success: false,
            message: `Could not detect one or more required columns. Missing columns: ${missingRequiredHeaders.join(', ')}. Please check your file headers.`
        });
    }

    const parsedClients = [];
    const validationErrors = [];
    const matchedClients = [];
    const processedPANs = new Set();
    const processedMobiles = new Set();
    const processedEmails = new Set();

    const parseDateString = (val) => {
        if (!val) return null;
        if (typeof val === 'number') {
            const dateObj = new Date((val - 25569) * 86400 * 1000);
            return moment(dateObj).format("YYYY-MM-DD");
        }
        const m = moment(String(val).trim(), ["YYYY-MM-DD", "DD/MM/YYYY", "DD-MM-YYYY", "MM/DD/YYYY"], true);
        return m.isValid() ? m.format("YYYY-MM-DD") : null;
    };

    // Process and validate each row
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 2; // 1-based indexing, row 1 is header

        const name = String(row[mappedCols.name] || '').trim();
        const mobile = String(row[mappedCols.mobile] || '').trim();
        const email = String(row[mappedCols.email] || '').trim();
        const pan_number = String(row[mappedCols.pan_number] || '').trim().toUpperCase();
        const rawGender = String(row[mappedCols.gender] || '').trim().toLowerCase();
        const rawDob = row[mappedCols.date_of_birth];
        const care_of = String(mappedCols.care_of ? (row[mappedCols.care_of] || '') : '').trim();
        const guardian_name = String(mappedCols.guardian_name ? (row[mappedCols.guardian_name] || '') : '').trim();
        const country_code = String(mappedCols.country_code ? (row[mappedCols.country_code] || '91') : '91').trim();
        const state = String(row[mappedCols.state] || '').trim();
        const district = String(row[mappedCols.district] || '').trim();
        const city = String(row[mappedCols.city] || '').trim();
        const pincode = String(row[mappedCols.pincode] || '').trim();
        const address_line_1 = String(mappedCols.address_line_1 ? (row[mappedCols.address_line_1] || '') : '').trim();
        const address_line_2 = String(mappedCols.address_line_2 ? (row[mappedCols.address_line_2] || '') : '').trim();

        // Firm fields
        const firm_name = String(mappedCols.firm_name ? (row[mappedCols.firm_name] || '') : '').trim();
        const rawFirmType = String(mappedCols.firm_type ? (row[mappedCols.firm_type] || '') : '').trim();
        const firm_pan = String(mappedCols.firm_pan ? (row[mappedCols.firm_pan] || '') : '').trim().toUpperCase();
        const gst_no = String(mappedCols.gst_no ? (row[mappedCols.gst_no] || '') : '').trim().toUpperCase();
        const tan_no = String(mappedCols.tan_no ? (row[mappedCols.tan_no] || '') : '').trim().toUpperCase();
        const vat_no = String(mappedCols.vat_no ? (row[mappedCols.vat_no] || '') : '').trim().toUpperCase();
        const cin_no = String(mappedCols.cin_no ? (row[mappedCols.cin_no] || '') : '').trim().toUpperCase();
        const file_no = String(mappedCols.file_no ? (row[mappedCols.file_no] || '') : '').trim().toUpperCase();

        // Opening balance fields
        const rawBalance = mappedCols.opening_balance ? row[mappedCols.opening_balance] : null;
        const rawBalanceType = mappedCols.opening_balance_type ? String(row[mappedCols.opening_balance_type] || '').trim().toLowerCase() : 'credit';
        const rawBalanceDate = mappedCols.opening_balance_date ? row[mappedCols.opening_balance_date] : null;

        const rowErrors = [];

        // Basic field validation
        if (!name) rowErrors.push("Client Name is required");
        if (!mobile) {
            rowErrors.push("Mobile number is required");
        } else if (!/^\+?[0-9]{10,15}$/.test(mobile)) {
            rowErrors.push("Invalid mobile number format (should be 10-15 digits)");
        }
        if (!email) {
            rowErrors.push("Email is required");
        } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            rowErrors.push("Invalid email format");
        }

        const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
        if (!pan_number) {
            rowErrors.push("PAN Number is required");
        } else if (!panRegex.test(pan_number)) {
            rowErrors.push("Invalid PAN format (should be 10 characters e.g. ABCDE1234F)");
        }

        let gender = null;
        if (!rawGender) {
            rowErrors.push("Gender is required");
        } else if (['male', 'female', 'other'].includes(rawGender)) {
            gender = rawGender;
        } else {
            rowErrors.push("Gender must be 'male', 'female', or 'other'");
        }

        const dob = parseDateString(rawDob);
        if (!rawDob) {
            rowErrors.push("Date of Birth is required");
        } else if (!dob) {
            rowErrors.push("Invalid Date of Birth format (should be YYYY-MM-DD or DD/MM/YYYY)");
        }

        if (!state) rowErrors.push("State is required");
        if (!district) rowErrors.push("District is required");
        if (!city) rowErrors.push("City/Town/Village is required");
        if (!pincode) rowErrors.push("Pincode is required");

        // Check duplicates within the file itself
        if (processedPANs.has(pan_number)) {
            rowErrors.push("Duplicate PAN within this spreadsheet");
        }
        if (processedMobiles.has(mobile)) {
            rowErrors.push("Duplicate Mobile number within this spreadsheet");
        }
        if (processedEmails.has(email)) {
            rowErrors.push("Duplicate Email within this spreadsheet");
        }

        if (rowErrors.length > 0) {
            validationErrors.push({
                row: rowNum,
                name: name || 'Unknown',
                errors: rowErrors
            });
            continue;
        }

        // Add to processed sets to check spreadsheet duplicates
        processedPANs.add(pan_number);
        processedMobiles.add(mobile);
        processedEmails.add(email);

        // Check database to see if client with PAN already exists in this branch
        const [existingClient] = await pool.query(
            `SELECT c.username, p.name 
             FROM profile p 
             JOIN clients c ON p.username = c.username 
             WHERE p.pan_number = ? 
               AND c.user_type = 'client' 
               AND c.is_deleted = '0' 
               AND c.branch_id = ? 
             LIMIT 1`,
            [pan_number, branch_id]
        );

        if (existingClient.length > 0) {
            // Match found! Get their associated firm
            const [existingFirm] = await pool.query(
                `SELECT firm_id, firm_name FROM firms WHERE username = ? AND branch_id = ? AND is_deleted = '0' LIMIT 1`,
                [existingClient[0].username, branch_id]
            );

            let alreadyMapped = false;
            if (existingFirm.length > 0) {
                const [mappingCheck] = await pool.query(
                    `SELECT unique_id FROM group_firms WHERE group_id = ? AND firm_id = ? AND is_deleted = '0' LIMIT 1`,
                    [group_id, existingFirm[0].firm_id]
                );
                if (mappingCheck.length > 0) {
                    alreadyMapped = true;
                }
            }

            matchedClients.push({
                row: rowNum,
                name: existingClient[0].name,
                pan_number: pan_number,
                username: existingClient[0].username,
                firm_id: existingFirm[0]?.firm_id || null,
                firm_name: existingFirm[0]?.firm_name || null,
                already_in_group: alreadyMapped
            });
        } else {
            // No match. New client needs to be inserted.
            // Validate email and mobile uniqueness in database
            const [dupMobile] = await pool.query(
                "SELECT p.name FROM profile p JOIN clients c ON p.username = c.username WHERE p.mobile = ? AND c.user_type = 'client' AND c.is_deleted = '0' LIMIT 1",
                [mobile]
            );
            if (dupMobile.length > 0) {
                rowErrors.push(`Mobile number already exists (registered to ${dupMobile[0].name})`);
            }

            const [dupEmail] = await pool.query(
                "SELECT p.name FROM profile p JOIN clients c ON p.username = c.username WHERE p.email = ? AND c.user_type = 'client' AND c.is_deleted = '0' LIMIT 1",
                [email]
            );
            if (dupEmail.length > 0) {
                rowErrors.push(`Email already exists (registered to ${dupEmail[0].name})`);
            }

            if (rowErrors.length > 0) {
                validationErrors.push({
                    row: rowNum,
                    name: name || 'Unknown',
                    errors: rowErrors
                });
                continue;
            }

            // Setup firm data
            let firmType = rawFirmType || 'Individual';
            const isIndividual = firmType.toLowerCase() === 'individual';
            const finalFirmName = isIndividual ? name : (firm_name || `${name} Business`);
            const finalFirmPan = firm_pan || pan_number;

            // Setup opening balance
            let openingBalance = null;
            if (rawBalance !== null && rawBalance !== undefined && String(rawBalance).trim() !== '') {
                const amt = parseFloat(rawBalance);
                if (isNaN(amt) || amt < 0) {
                    rowErrors.push("Opening Balance must be a positive number");
                } else if (amt > 0) {
                    const balType = ['credit', 'debit', '1', '0'].includes(rawBalanceType) ? (rawBalanceType === '1' || rawBalanceType === 'credit' ? 'credit' : 'debit') : 'credit';
                    const balDate = parseDateString(rawBalanceDate) || moment().format("YYYY-MM-DD");
                    openingBalance = {
                        amount: amt,
                        type: balType === 'credit' ? '1' : '0',
                        date: balDate
                    };
                }
            }

            if (rowErrors.length > 0) {
                validationErrors.push({
                    row: rowNum,
                    name: name || 'Unknown',
                    errors: rowErrors
                });
                continue;
            }

            parsedClients.push({
                row: rowNum,
                name,
                mobile,
                email,
                pan_number,
                gender,
                date_of_birth: dob,
                care_of: care_of || 'N/A',
                guardian_name: guardian_name || 'N/A',
                country_code,
                state,
                district,
                city,
                pincode,
                address_line_1: address_line_1 || null,
                address_line_2: address_line_2 || null,
                firm: {
                    firm_name: finalFirmName,
                    firm_type: firmType,
                    pan_no: finalFirmPan,
                    gst_no: gst_no || null,
                    tan_no: tan_no || null,
                    vat_no: vat_no || null,
                    cin_no: cin_no || null,
                    file_no: file_no || null,
                    state: state,
                    district: district,
                    city: city,
                    pincode: pincode,
                    address_line_1: address_line_1 || null,
                    address_line_2: address_line_2 || null
                },
                openingBalance
            });
        }
    }

    // Preview output
    if (isPreview) {
        return res.status(200).json({
            success: true,
            message: "File preview and validation completed",
            data: {
                total_rows: rows.length,
                valid_count: parsedClients.length + matchedClients.length,
                invalid_count: validationErrors.length,
                new_clients_count: parsedClients.length,
                matched_clients_count: matchedClients.length,
                column_mappings: mappedCols,
                preview: parsedClients.slice(0, 10),
                matches: matchedClients,
                errors: validationErrors
            }
        });
    }

    // If not preview and there are errors, fail immediately (atomic rollback pattern)
    if (validationErrors.length > 0) {
        return res.status(400).json({
            success: false,
            message: "Import failed due to validation errors. Please check the preview to fix your sheet.",
            errors: validationErrors
        });
    }

    // Perform actual database inserts inside transaction
    const conn = await pool.getConnection();
    const createdClients = [];
    try {
        await conn.beginTransaction();

        // 1. Map existing clients' firms to the group if not already mapped
        for (const matched of matchedClients) {
            if (!matched.already_in_group && matched.firm_id) {
                const unique_id = await UNIQUE_RANDOM_STRING("group_firms", "unique_id", { conn, length: ID_LENGTH });
                await conn.query(
                    `INSERT INTO group_firms
                     (unique_id, group_id, firm_id, create_by, modify_by, is_deleted, create_date, modify_date)
                     VALUES (?, ?, ?, ?, ?, '0', NOW(), NOW())`,
                    [
                        unique_id,
                        group_id,
                        matched.firm_id,
                        createdBy,
                        createdBy
                    ]
                );
            }
        }

        // 2. Insert new clients and map their new firms to the group
        for (const client of parsedClients) {
            const username = await UNIQUE_RANDOM_STRING("clients", "username", { conn });
            const profile_id = await UNIQUE_RANDOM_STRING("profile", "profile_id", { conn });
            const firm_id = await UNIQUE_RANDOM_STRING("firms", "firm_id", { conn, length: ID_LENGTH });

            // Insert client
            await conn.query(
                `INSERT INTO clients (username, user_type, branch_id, create_by, status, is_deleted)
                 VALUES (?, 'client', ?, ?, '1', '0')`,
                [username, branch_id, createdBy]
            );

            // Insert profile
            await conn.query(
                `INSERT INTO profile (profile_id, username, create_by, user_type, name, care_of, guardian_name, date_of_birth, gender, mobile, country_code, email, pan_number, state, district, city, village_town, pincode, address_line_1, address_line_2, status)
                 VALUES (?, ?, ?, 'client', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1')`,
                [
                    profile_id, username, createdBy, client.name, client.care_of, client.guardian_name,
                    client.date_of_birth, client.gender, client.mobile, client.country_code, client.email,
                    client.pan_number, client.state, client.district, client.city, client.city, client.pincode,
                    client.address_line_1, client.address_line_2
                ]
            );

            // Insert firm
            await conn.query(
                `INSERT INTO firms (firm_id, branch_id, username, firm_name, firm_type, pan_no, gst_no, tan_no, vat_no, cin_no, file_no, state, district, city, pincode, address_line_1, address_line_2, create_by, status, is_deleted)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1', '0')`,
                [
                    firm_id, branch_id, username, client.firm.firm_name, client.firm.firm_type, client.firm.pan_no,
                    client.firm.gst_no, client.firm.tan_no, client.firm.vat_no, client.firm.cin_no, client.firm.file_no,
                    client.firm.state, client.firm.district, client.firm.city, client.firm.pincode,
                    client.firm.address_line_1, client.firm.address_line_2, createdBy
                ]
            );

            // Insert group mapping
            const groupFirmUniqueId = await UNIQUE_RANDOM_STRING("group_firms", "unique_id", { conn, length: ID_LENGTH });
            await conn.query(
                `INSERT INTO group_firms
                 (unique_id, group_id, firm_id, create_by, modify_by, is_deleted, create_date, modify_date)
                 VALUES (?, ?, ?, ?, ?, '0', NOW(), NOW())`,
                [
                    groupFirmUniqueId,
                    group_id,
                    firm_id,
                    createdBy,
                    createdBy
                ]
            );

            createdClients.push({
                username,
                name: client.name,
                mobile: client.mobile,
                email: client.email,
                openingBalance: client.openingBalance
            });
        }

        await conn.commit();
    } catch (txErr) {
        await conn.rollback();
        throw txErr;
    } finally {
        conn.release();
    }

    // Post-commit: handle opening balances sequentially for new clients
    const originalBranchId = req.headers["branch_id"];
    req.headers["branch_id"] = branch_id;

    let openingBalanceCount = 0;
    for (const client of createdClients) {
        if (client.openingBalance) {
            try {
                await SET_OPENING_BALANCE({
                    req,
                    type: client.openingBalance.type,
                    party_type: "client",
                    party_id: client.username,
                    amount: client.openingBalance.amount,
                    remark: "Imported opening balance",
                    transaction_date: client.openingBalance.date
                });
                openingBalanceCount++;
            } catch (balError) {
                console.error(`Opening balance creation failed for user ${client.username}:`, balError);
            }
        }
    }

    // Restore original branch_id if any
    if (originalBranchId !== undefined) {
        req.headers["branch_id"] = originalBranchId;
    } else {
        delete req.headers["branch_id"];
    }

    const newlyMappedMatchedCount = matchedClients.filter(c => !c.already_in_group).length;

    return res.status(200).json({
        success: true,
        message: `Successfully imported ${createdClients.length} new clients and mapped ${newlyMappedMatchedCount} existing clients to group!`,
        data: {
            total_rows: rows.length,
            new_imported_count: createdClients.length,
            matched_mapped_count: newlyMappedMatchedCount,
            already_in_group_count: matchedClients.filter(c => c.already_in_group).length,
            opening_balance_applied: openingBalanceCount,
            matches: matchedClients
        }
    });
}

router.post("/import", auth, validateBranch, (req, res) => {
    upload(req, res, async (err) => {
        if (err) {
            return res.status(400).json({ success: false, message: err.message });
        }
        if (!req.file) {
            return res.status(400).json({ success: false, message: "Please upload a file" });
        }

        const { group_id } = req.body || {};
        if (!group_id) {
            return res.status(400).json({ success: false, message: "group_id is required in request body" });
        }

        try {
            await handleGroupImport(req, res, req.headers["username"] || "", req.branch_id);
        } catch (error) {
            console.error("Bulk group import error:", error);
            return res.status(500).json({
                success: false,
                message: "Internal server error occurred during group import",
                error: error.message
            });
        }
    });
});

export default router;