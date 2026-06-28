import express from "express";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { RANDOM_STRING, TIMESTAMP, USER_DATA } from "../helpers/function.js";
import { DSC_TYPES, DSC_COMPANIES } from "../helpers/Config.js";

const router = express.Router();

async function getTableColumns(tableName) {
    const [rows] = await pool.query(`SHOW COLUMNS FROM \`${tableName}\``);
    return new Set(rows.map(r => r.Field));
}

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

router.get("/dsc/list", auth, validateBranch, async (req, res) => {
    try {

        const { search, page, limit } = req.query;

        const pageNum = Number(page) || 1;
        const limitNum = Number(limit) || 20;
        const offset = (Number(pageNum) - 1) * limitNum;

        const searchPattern = search != null && search !== '' ? `%${search}%` : '%%';

        const countQuery = `
        SELECT COUNT(*) AS total FROM dsc_register
        JOIN profile ON dsc_register.username = profile.username
        WHERE dsc_register.is_deleted = '0'
        AND profile.user_type = 'client'
        AND profile.status = '1'
        AND (profile.name LIKE ? OR profile.mobile LIKE ? OR profile.email LIKE ?)
        `;
        const [[{ total }]] = await pool.query(countQuery, [searchPattern, searchPattern, searchPattern]);

        const listQuery = `
        SELECT dsc_register.*,profile.name,profile.mobile,profile.email FROM dsc_register
        JOIN profile ON dsc_register.username = profile.username
        WHERE dsc_register.is_deleted = '0'
        AND profile.user_type = 'client'
        AND profile.status = '1'
        AND (profile.name LIKE ? OR profile.mobile LIKE ? OR profile.email LIKE ?)
        ORDER BY dsc_register.id DESC
        LIMIT ? OFFSET ?
       `;
        const [rows] = await pool.query(listQuery, [searchPattern, searchPattern, searchPattern, limitNum, offset]);

        const data = [];
        for (let index = 0; index < rows.length; index++) {
            const element = rows[index];

            const create_by_user = await USER_DATA(element?.create_by);
            const modify_by_user = await USER_DATA(element?.modify_by);

            data.push({
                dsc_id: element?.dsc_id,
                company: element?.company,
                validity_start: element?.validity_start,
                validity_end: element?.validity_end,
                year: element?.year,
                password: element?.password,
                type: element?.type,
                client: {
                    username: element?.username,
                    name: element?.name,
                    mobile: element?.mobile,
                    email: element?.email,
                },
                create_by: {
                    name: create_by_user?.name,
                    mobile: create_by_user?.mobile,
                    email: create_by_user?.email,
                },
                modify_by: {
                    name: modify_by_user?.name,
                    mobile: modify_by_user?.mobile,
                    email: modify_by_user?.email,
                },
                create_date: element?.create_date,
                modify_date: element?.modify_date,
            })

        }

        return res.status(200).json({
            success: true,
            message: "DSC list fetched successfully",
            data,
            meta: {
                page: Number(page),
                limit: limitNum,
                total: total,
                total_pages: Math.ceil(total / limitNum),
                is_last_page: offset + rows.length >= total
            }
        });

    } catch (error) {
        console.error("Error fetching DSC list:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch DSC list",
            error: error.message
        });
    }
});

router.get("/dsc/types", auth, validateBranch, async (req, res) => {
    try {

        return res.status(200).json({
            success: true,
            data: DSC_TYPES
        });

    } catch (error) {
        console.error("Error fetching DSC types:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch DSC types",
            error: error.message
        });
    }
});

router.get("/dsc/companies", auth, validateBranch, async (req, res) => {
    try {

        return res.status(200).json({
            success: true,
            data: DSC_COMPANIES
        });

    } catch (error) {
        console.error("Error fetching DSC companies:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch DSC companies",
            error: error.message
        });
    }
});

router.post("/dsc/create", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();

    try {
        const {
            username,
            company,
            password,
            validity_start,
            validity_end,
            type,
            year
        } = req.body || {};

        const createdBy = req.headers["username"] || "";

        if (!username || !company || !validity_start || !validity_end || !type || !year) {
            return res.status(400).json({
                success: false,
                message: "Missing required parameters"
            });
        }


        const [userExists] = await pool.query(
            "SELECT username FROM clients WHERE username = ? AND user_type = 'client' AND is_deleted = '0'",
            [username]
        );

        if (userExists.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Selected user not found or not a valid DSC user"
            });
        }

        const create_by_user = await USER_DATA(createdBy);

        await conn.beginTransaction();

        const dsc_id = RANDOM_STRING(30);
        await insertRow("dsc_register", {
            dsc_id,
            username,
            company,
            password: password || null,
            validity_start: validity_start,
            validity_end: validity_end,
            year: year || null,
            create_by: createdBy,
            modified_by: createdBy,
            type: type,
            create_date: TIMESTAMP(),
            modify_date: TIMESTAMP()
        });
        await conn.commit();

        return res.status(200).json({
            success: true,
            message: "DSC created successfully",
            data: {
                dsc_id,
                company,
                validity_start,
                validity_end,
                year,
                password,
                create_by: {
                    username: create_by_user?.username,
                    name: create_by_user?.name,
                    mobile: create_by_user?.mobile,
                    email: create_by_user?.email,
                },
                modify_by: {
                    username: create_by_user?.username,
                    name: create_by_user?.name,
                    mobile: create_by_user?.mobile,
                    email: create_by_user?.email,
                },
                create_date: TIMESTAMP(),
                modify_date: TIMESTAMP()
            }
        });

    } catch (error) {
        await conn.rollback();
        console.error("Error creating DSC:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to create DSC",
            error: error.message
        });
    } finally {
        conn.release();
    }
});

router.put("/dsc/edit", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();

    try {

        const {
            dsc_id,
            company,
            password,
            validity_start,
            validity_end,
            type,
            year
        } = req.body || {};

        const modifyBy = req.headers["username"] || "";

        if (!dsc_id || !company || !validity_start || !validity_end || !type || !year) {
            return res.status(400).json({
                success: false,
                message: "Missing required parameters"
            });
        }

        const [existingDSC] = await pool.query(
            "SELECT dsc_id, create_by, create_date FROM dsc_register WHERE dsc_id = ? AND is_deleted = '0'",
            [dsc_id]
        );

        if (existingDSC.length === 0) {
            return res.status(404).json({
                success: false,
                message: "DSC record not found"
            });
        }

        await conn.beginTransaction();

        await conn.query(
            `UPDATE dsc_register 
             SET company = ?, 
                 password = ?, 
                 validity_start = ?, 
                 validity_end = ?, 
                 year = ?, 
                 type = ?,
                 modify_by = ?,
                 modify_date = NOW()
             WHERE dsc_id = ? AND is_deleted = '0'`,
            [
                company || null,
                password || null,
                validity_start,
                validity_end,
                year,
                type || null,
                modifyBy,
                dsc_id
            ]
        );

        await conn.commit();

        const create_by_user = await USER_DATA(existingDSC[0].create_by);
        const modify_by_user = await USER_DATA(modifyBy);

        return res.status(200).json({
            success: true,
            message: "DSC updated successfully",
            data: {
                dsc_id,
                company,
                validity_start,
                validity_end,
                year,
                password: password || null,
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
                create_date: existingDSC[0].create_date,
                modify_date: TIMESTAMP()
            }
        });

    } catch (error) {
        await conn.rollback();
        console.error("Error updating DSC:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update DSC",
            error: error.message
        });
    } finally {
        conn.release();
    }
});

router.delete("/dsc/delete", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();

    try {
        const { dsc_id } = req.body || {};
        const modifiedBy = req.headers["username"] || "";

        if (!dsc_id) {
            return res.status(400).json({
                success: false,
                message: "DSC ID is required"
            });
        }

        const [existing] = await conn.query(
            "SELECT dsc_id FROM dsc_register WHERE dsc_id = ? AND is_deleted = '0'",
            [dsc_id]
        );

        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: "DSC record not found"
            });
        }

        await conn.beginTransaction();

        await conn.query(
            `UPDATE dsc_register 
             SET is_deleted = '1', 
                deleted_by = ?,
                modify_by = ?,
                modify_date = ?
             WHERE dsc_id = ?`,
            [modifiedBy, modifiedBy, TIMESTAMP(), dsc_id]
        );

        await conn.commit();

        return res.status(200).json({
            success: true,
            message: "DSC deleted successfully"
        });

    } catch (error) {
        await conn.rollback();
        console.error("Error deleting DSC:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to delete DSC",
            error: error.message
        });
    } finally {
        conn.release();
    }
});

router.get("/file-index/list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { search, page = 1, limit } = req.query;

        const limitNum = Number(limit) || 20;
        const offset = (Number(page) - 1) * limitNum;
        const searchPattern =
            search && search !== "" ? `%${search}%` : "%%";

        const countQuery = `
            SELECT COUNT(*) AS total
            FROM file_index fi
            INNER JOIN firms f 
                ON fi.firm_id = f.firm_id
                AND f.branch_id = ?
                AND f.is_deleted = '0'
            WHERE fi.is_deleted = '0'
            AND (
                fi.gst LIKE ?
                OR fi.audit LIKE ?
                OR fi.it LIKE ?
                OR fi.others LIKE ?
                OR f.firm_name LIKE ?
            )
        `;

        const [[{ total }]] = await pool.query(countQuery, [
            branch_id,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
        ]);

        const listQuery = `
            SELECT fi.*, f.firm_name
            FROM file_index fi
            INNER JOIN firms f 
                ON fi.firm_id = f.firm_id
                AND f.branch_id = ?
                AND f.is_deleted = '0'
            WHERE fi.is_deleted = '0'
            AND (
                fi.gst LIKE ?
                OR fi.audit LIKE ?
                OR fi.it LIKE ?
                OR fi.others LIKE ?
                OR f.firm_name LIKE ?
            )
            ORDER BY fi.id DESC
            LIMIT ? OFFSET ?
        `;

        const [rows] = await pool.query(listQuery, [
            branch_id,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            limitNum,
            offset,
        ]);

        const data = [];
        for (const el of rows) {
            const create_by_user = await USER_DATA(el?.create_by);
            const modify_by_user = await USER_DATA(el?.modify_by);

            data.push({
                index_id: el?.index_id,
                firm_id: el?.firm_id,
                firm_name: el?.firm_name,
                gst: el?.gst ?? null,
                audit: el?.audit ?? null,
                it: el?.it ?? null,
                others: el?.others ?? null,
                create_by: {
                    name: create_by_user?.name,
                    mobile: create_by_user?.mobile,
                    email: create_by_user?.email,
                },
                modify_by: {
                    name: modify_by_user?.name,
                    mobile: modify_by_user?.mobile,
                    email: modify_by_user?.email,
                },
                create_date: el?.create_date,
                modify_date: el?.modify_date,
            });
        }

        return res.status(200).json({
            success: true,
            message: "File index list fetched successfully",
            data,
            meta: {
                page: Number(page),
                limit: limitNum,
                total,
                total_pages: Math.ceil(total / limitNum),
                is_last_page: offset + rows.length >= total,
            },
        });
    } catch (error) {
        console.error("Error fetching file index list:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch file index list",
            error: error.message,
        });
    }
});

router.post("/file-index/create", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { firm_id, gst, audit, it, others } = req.body || {};
        const createdBy = req.headers["username"] || "";
        const branch_id = req.branch_id;

        if (!firm_id) {
            return res.status(400).json({
                success: false,
                message: "firm_id is required",
            });
        }

        const [firmExists] = await pool.query(
            `SELECT firm_id 
             FROM firms 
             WHERE firm_id = ? 
               AND branch_id = ? 
               AND is_deleted = '0'`,
            [firm_id, branch_id]
        );

        if (firmExists.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Firm not found or does not belong to this branch",
            });
        }

        await conn.beginTransaction();

        const index_id = RANDOM_STRING(30);

        await conn.query(
            `INSERT INTO file_index 
                (index_id, firm_id, gst, audit, it, others, create_by, modify_by, create_date, modify_date)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [
                index_id,
                firm_id,
                gst?.trim() || null,
                audit?.trim() || null,
                it?.trim() || null,
                others?.trim() || null,
                createdBy,
                createdBy,
            ]
        );

        await conn.commit();

        const create_by_user = await USER_DATA(createdBy);

        return res.status(200).json({
            success: true,
            message: "File index created successfully",
            data: {
                index_id,
                firm_id,
                gst: gst?.trim() || null,
                audit: audit?.trim() || null,
                it: it?.trim() || null,
                others: others?.trim() || null,
                create_by: {
                    username: create_by_user?.username,
                    name: create_by_user?.name,
                    mobile: create_by_user?.mobile,
                    email: create_by_user?.email,
                },
                modify_by: {
                    username: create_by_user?.username,
                    name: create_by_user?.name,
                    mobile: create_by_user?.mobile,
                    email: create_by_user?.email,
                },
                create_date: TIMESTAMP(),
                modify_date: TIMESTAMP(),
            },
        });
    } catch (error) {
        await conn.rollback();
        console.error("Error creating file index:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to create file index",
            error: error.message,
        });
    } finally {
        conn.release();
    }
});

router.put("/file-index/edit", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { index_id, firm_id, gst, audit, it, others } = req.body || {};
        const modifyBy = req.headers["username"] || "";
        const branch_id = req.branch_id;

        if (!index_id) {
            return res.status(400).json({
                success: false,
                message: "index_id is required",
            });
        }

        const [existing] = await pool.query(
            `SELECT fi.index_id, fi.firm_id, fi.create_by, fi.create_date
             FROM file_index fi
             INNER JOIN firms f 
                ON fi.firm_id = f.firm_id
                AND f.branch_id = ?
                AND f.is_deleted = '0'
             WHERE fi.index_id = ?
               AND fi.is_deleted = '0'`,
            [branch_id, index_id]
        );

        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: "File index record not found",
            });
        }

        const resolvedFirmId = firm_id?.trim() || existing[0].firm_id;

        if (resolvedFirmId !== existing[0].firm_id) {
            const [firmCheck] = await pool.query(
                `SELECT firm_id 
                 FROM firms 
                 WHERE firm_id = ?
                   AND branch_id = ?
                   AND is_deleted = '0'`,
                [resolvedFirmId, branch_id]
            );

            if (firmCheck.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: "Firm not found or does not belong to this branch",
                });
            }
        }

        await conn.beginTransaction();

        await conn.query(
            `UPDATE file_index
             SET firm_id = ?,
                 gst = ?,
                 audit = ?,
                 it = ?,
                 others = ?,
                 modify_by = ?,
                 modify_date = NOW()
             WHERE index_id = ?
               AND is_deleted = '0'`,
            [
                resolvedFirmId,
                gst?.trim() || null,
                audit?.trim() || null,
                it?.trim() || null,
                others?.trim() || null,
                modifyBy,
                index_id,
            ]
        );

        await conn.commit();

        const create_by_user = await USER_DATA(existing[0].create_by);
        const modify_by_user = await USER_DATA(modifyBy);

        return res.status(200).json({
            success: true,
            message: "File index updated successfully",
            data: {
                index_id,
                firm_id: resolvedFirmId,
                gst: gst?.trim() || null,
                audit: audit?.trim() || null,
                it: it?.trim() || null,
                others: others?.trim() || null,
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
                modify_date: TIMESTAMP(),
            },
        });
    } catch (error) {
        await conn.rollback();
        console.error("Error updating file index:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update file index",
            error: error.message,
        });
    } finally {
        conn.release();
    }
});

router.delete("/file-index/delete", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { index_id } = req.body || {};
        const modifiedBy = req.headers["username"] || "";
        const branch_id = req.branch_id;

        if (!index_id) {
            return res.status(400).json({
                success: false,
                message: "index_id is required",
            });
        }

        const [existing] = await pool.query(
            `SELECT fi.index_id
             FROM file_index fi
             INNER JOIN firms f
                ON fi.firm_id = f.firm_id
                AND f.branch_id = ?
                AND f.is_deleted = '0'
             WHERE fi.index_id = ?
               AND fi.is_deleted = '0'`,
            [branch_id, index_id]
        );

        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: "File index record not found",
            });
        }

        await conn.beginTransaction();

        await conn.query(
            `UPDATE file_index
             SET is_deleted = '1',
                 deleted_by = ?,
                 modify_by = ?,
                 modify_date = NOW()
             WHERE index_id = ?`,
            [modifiedBy, modifiedBy, index_id]
        );

        await conn.commit();

        return res.status(200).json({
            success: true,
            message: "File index deleted successfully",
        });
    } catch (error) {
        await conn.rollback();
        console.error("Error deleting file index:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to delete file index",
            error: error.message,
        });
    } finally {
        conn.release();
    }
});

router.get("/important-link/list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { search, page = 1, limit } = req.query;

        const limitNum = Number(limit) || 20;
        const offset = (Number(page) - 1) * limitNum;

        const searchPattern =
            search != null && search !== "" ? `%${search}%` : "%%";

        const countQuery = `
            SELECT COUNT(*) AS total
            FROM important_links il
            WHERE il.branch_id = ?
              AND il.is_deleted = '0'
              AND (
                    IFNULL(il.name, '') LIKE ?
                 OR IFNULL(il.url, '') LIKE ?
                 OR IFNULL(il.username, '') LIKE ?
                 OR IFNULL(il.password, '') LIKE ?
                 OR IFNULL(il.remark, '') LIKE ?
              )
        `;

        const [[{ total }]] = await pool.query(countQuery, [
            branch_id,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern
        ]);

        const listQuery = `
            SELECT il.*
            FROM important_links il
            WHERE il.branch_id = ?
              AND il.is_deleted = '0'
              AND (
                    IFNULL(il.name, '') LIKE ?                 
                 OR IFNULL(il.url, '') LIKE ?
                 OR IFNULL(il.username, '') LIKE ?
                 OR IFNULL(il.password, '') LIKE ?
                 OR IFNULL(il.remark, '') LIKE ?
              )
            ORDER BY il.id DESC
            LIMIT ? OFFSET ?
        `;

        const [rows] = await pool.query(listQuery, [
            branch_id,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            limitNum,
            offset
        ]);

        const data = [];
        for (let i = 0; i < rows.length; i++) {
            const el = rows[i];

            const create_by_user = await USER_DATA(el?.create_by);
            const modify_by_user = await USER_DATA(el?.modify_by);

            data.push({
                link_id: el?.link_id,
                name: el?.name ?? null,
                url: el?.url ?? null,
                username: el?.username ?? null,
                password: el?.password ?? null,
                remark: el?.remark ?? null,

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

                create_date: el?.create_date,
                modify_date: el?.modify_date,
            });
        }

        return res.status(200).json({
            success: true,
            message: "Important links list fetched successfully",
            data,
            meta: {
                page: Number(page),
                limit: limitNum,
                total,
                total_pages: Math.ceil(total / limitNum),
                is_last_page: offset + rows.length >= total
            }
        });

    } catch (error) {
        console.error("Error fetching important links list:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch important links",
            error: error.message
        });
    }
});

router.post("/important-link/create", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const {
            name,
            url,
            username,
            password,
            remark
        } = req.body || {};

        const createdBy = req.headers["username"] || "";
        const branch_id = req.branch_id;

        if (!name || !url) {
            return res.status(400).json({
                success: false,
                message: "name and url are required"
            });
        }

        if (!/^https?:\/\/.+/i.test(url)) {
            return res.status(400).json({
                success: false,
                message: "Invalid URL format"
            });
        }

        const safe = v => (v != null && v !== '' ? String(v).trim() : null);

        const create_by_user = await USER_DATA(createdBy);

        const link_id = crypto.randomUUID();

        await conn.beginTransaction();

        await conn.query(
            `INSERT INTO important_links (
                branch_id,
                link_id,
                name,                
                url,
                username,
                password,
                remark,
                create_by,
                modify_by,
                create_date,
                modify_date,
                is_deleted,
                deleted_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), '0', NULL)`,
            [
                branch_id,
                link_id,
                safe(name),
                safe(url),
                safe(username),
                password,
                safe(remark),
                createdBy,
                createdBy
            ]
        );

        await conn.commit();

        return res.status(200).json({
            success: true,
            message: "Important link created successfully",
            data: {
                link_id,
                name: safe(name),
                url: safe(url),
                username: safe(username),
                password: safe(password),
                remark: safe(remark),
                create_by: {
                    username: create_by_user?.username,
                    name: create_by_user?.name,
                    mobile: create_by_user?.mobile,
                    email: create_by_user?.email,
                },
                modify_by: {
                    username: create_by_user?.username,
                    name: create_by_user?.name,
                    mobile: create_by_user?.mobile,
                    email: create_by_user?.email,
                },
                create_date: TIMESTAMP(),
                modify_date: TIMESTAMP()
            }
        });

    } catch (error) {
        await conn.rollback();
        console.error("Important link create error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to create important link",
            error: error.message
        });
    } finally {
        conn.release();
    }
});

router.put("/important-link/edit", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const {
            link_id,
            name,
            url,
            username,
            password,
            remark
        } = req.body || {};

        const modifyBy = req.headers["username"] || "";
        const branch_id = req.branch_id;

        if (!link_id) {
            return res.status(400).json({
                success: false,
                message: "link_id is required"
            });
        }

        const [existing] = await pool.query(
            `SELECT 
                link_id,
                branch_id,
                name,
                url,
                username,
                password,
                remark,
                create_by,
                create_date,
                is_deleted
             FROM important_links
             WHERE link_id = ?`,
            [link_id]
        );

        if (existing.length === 0 || existing[0].is_deleted !== '0') {
            return res.status(404).json({
                success: false,
                message: "Important link not found"
            });
        }

        if (existing[0].branch_id !== branch_id) {
            return res.status(403).json({
                success: false,
                message: "Important link does not belong to this branch"
            });
        }

        const current = existing[0];

        const resolvedName = name != null && name !== "" ? name.trim() : current.name;
        const resolvedUrl = url != null && url !== "" ? url.trim() : current.url;
        const resolvedUsername = username != null && username !== "" ? username.trim() : current.username;
        const resolvedRemark = remark != null && remark !== "" ? remark.trim() : current.remark;

        const resolvedPassword =
            password !== undefined
                ? (password === "" || password === null ? null : password)
                : current.password;

        if (resolvedUrl && !/^https?:\/\/.+/i.test(resolvedUrl)) {
            return res.status(400).json({
                success: false,
                message: "Invalid URL format"
            });
        }

        await conn.beginTransaction();

        await conn.query(
            `UPDATE important_links
             SET
                name = ?,
                url = ?,
                username = ?,
                password = ?,
                remark = ?,
                modify_by = ?,
                modify_date = NOW()
             WHERE link_id = ?
               AND is_deleted = '0'`,
            [
                resolvedName,
                resolvedUrl,
                resolvedUsername,
                resolvedPassword,
                resolvedRemark,
                modifyBy,
                link_id
            ]
        );

        await conn.commit();

        const create_by_user = await USER_DATA(current.create_by);
        const modify_by_user = await USER_DATA(modifyBy);

        return res.status(200).json({
            success: true,
            message: "Important link updated successfully",
            data: {
                link_id,
                name: resolvedName,
                url: resolvedUrl,
                username: resolvedUsername,
                password: resolvedPassword,
                remark: resolvedRemark,
                create_by: {
                    username: create_by_user?.username,
                    name: create_by_user?.name,
                    mobile: create_by_user?.mobile,
                    email: create_by_user?.email
                },
                modify_by: {
                    username: modify_by_user?.username,
                    name: modify_by_user?.name,
                    mobile: modify_by_user?.mobile,
                    email: modify_by_user?.email
                },
                create_date: current.create_date,
                modify_date: TIMESTAMP()
            }
        });

    } catch (error) {
        await conn.rollback();
        console.error("Important link edit error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update important link",
            error: error.message
        });
    } finally {
        conn.release();
    }
});

router.delete("/important-link/delete", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { link_id } = req.body || {};
        const modifiedBy = req.headers["username"] || "";
        const branch_id = req.branch_id;

        if (!link_id) {
            return res.status(400).json({
                success: false,
                message: "link_id is required"
            });
        }

        const [existing] = await pool.query(
            `SELECT link_id FROM important_links
             WHERE link_id = ? 
               AND branch_id = ? 
               AND is_deleted = '0'`,
            [link_id, branch_id]
        );

        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Important link not found"
            });
        }

        await conn.beginTransaction();

        await conn.query(
            `UPDATE important_links
             SET is_deleted = '1', modify_by = ?, modify_date = NOW(), deleted_by = ?
             WHERE link_id = ?`,
            [modifiedBy, modifiedBy, link_id]
        );

        await conn.commit();

        return res.status(200).json({
            success: true,
            message: "Important link deleted successfully"
        });

    } catch (error) {
        await conn.rollback();
        console.error("Error deleting important link:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to delete important link",
            error: error.message
        });
    } finally {
        conn.release();
    }
});


// PASSWORD GROUP START
router.post("/password-group/create", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { group_name } = req.body || {};
        const create_by = req.headers["username"] || "";
        const branch_id = req.branch_id;

        if (!group_name || !group_name.trim()) {
            return res.status(400).json({
                success: false,
                message: "Group name is required"
            });
        }

        const trimmedGroupName = group_name.trim();

        const [existing] = await pool.query(
            `SELECT group_name FROM password_groups 
             WHERE group_name = ? AND branch_id = ? AND is_deleted = '0' LIMIT 1`,
            [trimmedGroupName, branch_id]
        );

        if (existing.length > 0) {
            return res.status(400).json({
                success: false,
                message: "Group name already exists in this branch"
            });
        }

        await conn.beginTransaction();

        const group_id = RANDOM_STRING(30);

        await conn.query(
            `INSERT INTO password_groups 
                (group_id, group_name, branch_id, create_by, modify_by, create_date, modify_date, is_deleted, status)
             VALUES (?, ?, ?, ?, ?, NOW(), NOW(), '0', '1')`,
            [group_id, trimmedGroupName, branch_id, create_by, create_by]
        );

        await conn.commit();

        const create_by_user = await USER_DATA(create_by);

        return res.status(200).json({
            success: true,
            message: "Password group created successfully",
            data: {
                group_id: group_id,
                group_name: trimmedGroupName,
                status: '1',
                created_by: {
                    username: create_by_user?.username,
                    name: create_by_user?.name,
                    mobile: create_by_user?.mobile,
                    email: create_by_user?.email,
                },
                create_date: TIMESTAMP()
            }
        });

    } catch (error) {
        await conn.rollback();
        console.error("Error creating password group:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to create password group",
            error: error.message
        });
    } finally {
        conn.release();
    }
});

router.get("/password-group/list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { search, page = 1, limit } = req.query;

        const limitNum = Number(limit) || 20;
        const offset = (Number(page) - 1) * limitNum;

        const searchPattern = search && search !== "" ? `%${search}%` : "%%";

        const [groups] = await pool.query(
            `SELECT group_id, group_name, status, create_by, create_date
             FROM password_groups 
             WHERE branch_id = ? 
               AND is_deleted = '0'
               AND group_name LIKE ?
             ORDER BY id DESC
             LIMIT ? OFFSET ?`,
            [branch_id, searchPattern, limitNum, offset]
        );

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total
             FROM password_groups 
             WHERE branch_id = ? 
               AND is_deleted = '0'
               AND group_name LIKE ?`,
            [branch_id, searchPattern]
        );

        const data = [];
        for (const group of groups) {
            const [[{ total_credentials }]] = await pool.query(
                `SELECT COUNT(*) AS total_credentials
                FROM password_group_firms 
                 WHERE group_id = ? 
                   AND is_deleted = '0'`,
                [group.group_id]
            );

            const [[{ unique_firms }]] = await pool.query(
                `SELECT COUNT(DISTINCT firm_id) AS unique_firms
                FROM password_group_firms 
                 WHERE group_id = ? 
                   AND is_deleted = '0'
                   AND firm_id IS NOT NULL`,
                [group.group_id]
            );

            const create_by_user = await USER_DATA(group.create_by);

            data.push({
                group_id: group.group_id,
                group_name: group.group_name,
                total_credentials: total_credentials,
                unique_firms: unique_firms,
                status: group.status == "1",
                created_by: {
                    name: create_by_user?.name,
                    mobile: create_by_user?.mobile,
                    email: create_by_user?.email,
                },
                create_date: group.create_date
            });
        }

        return res.status(200).json({
            success: true,
            message: "Password groups fetched successfully",
            data,
            meta: {
                page: Number(page),
                limit: limitNum,
                total,
                total_pages: Math.ceil(total / limitNum),
                is_last_page: offset + groups.length >= total
            }
        });

    } catch (error) {
        console.error("Error fetching password groups:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch password groups",
            error: error.message
        });
    }
});

router.put("/password-group/edit/:group_id", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { group_id } = req.params;
        const { group_name, status } = req.body || {};
        const modify_by = req.headers["username"] || "";
        const branch_id = req.branch_id;

        if (!group_id) {
            return res.status(400).json({
                success: false,
                message: "Group ID is required"
            });
        }

        const [existing] = await pool.query(
            `SELECT group_name, status FROM password_groups 
             WHERE group_id = ? AND branch_id = ? AND is_deleted = '0'`,
            [group_id, branch_id]
        );

        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Group not found"
            });
        }

        const old_group_name = existing[0].group_name;
        const new_group_name = group_name?.trim() || old_group_name;

        if (new_group_name !== old_group_name) {
            const [nameExists] = await pool.query(
                `SELECT group_name FROM password_groups 
                 WHERE group_name = ? AND branch_id = ? AND is_deleted = '0' AND group_id != ?`,
                [new_group_name, branch_id, group_id]
            );

            if (nameExists.length > 0) {
                return res.status(400).json({
                    success: false,
                    message: "Group name already exists"
                });
            }
        }

        await conn.beginTransaction();

        await conn.query(
            `UPDATE password_groups
             SET group_name = ?,
                 status = ?,
                 modify_by = ?,
                 modify_date = NOW()
             WHERE group_id = ? AND is_deleted = '0'`,
            [new_group_name, status || existing[0].status, modify_by, group_id]
        );

        await conn.commit();

        const modify_by_user = await USER_DATA(modify_by);

        return res.status(200).json({
            success: true,
            message: "Group updated successfully",
            data: {
                group_id: group_id,
                group_name: new_group_name,
                status: status || existing[0].status,
                modified_by: {
                    username: modify_by_user?.username,
                    name: modify_by_user?.name,
                    mobile: modify_by_user?.mobile,
                    email: modify_by_user?.email,
                },
                modify_date: TIMESTAMP()
            }
        });

    } catch (error) {
        await conn.rollback();
        console.error("Error updating group:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update group",
            error: error.message
        });
    } finally {
        conn.release();
    }
});

router.delete("/password-group/delete/:group_id", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { group_id } = req.params;
        const delete_by = req.headers["username"] || "";
        const branch_id = req.branch_id;

        if (!group_id) {
            return res.status(400).json({
                success: false,
                message: "Group ID is required"
            });
        }

        const [existing] = await pool.query(
            `SELECT group_id FROM password_groups 
             WHERE group_id = ? AND branch_id = ? AND is_deleted = '0'`,
            [group_id, branch_id]
        );

        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Group not found"
            });
        }

        await conn.beginTransaction();

        await conn.query(
            `UPDATE password_groups
             SET is_deleted = '1',
                 deleted_by = ?,
                 modify_by = ?,
                 modify_date = NOW()
             WHERE group_id = ?`,
            [delete_by, delete_by, group_id]
        );

        await conn.query(
            `UPDATE password_group_firms
             SET is_deleted = '1',
                 deleted_by = ?,
                 modify_by = ?,
                 modify_date = NOW()
             WHERE group_id = ?`,
            [delete_by, delete_by, group_id]
        );

        await conn.commit();

        return res.status(200).json({
            success: true,
            message: "Group and all its credentials deleted successfully"
        });

    } catch (error) {
        await conn.rollback();
        console.error("Error deleting group:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to delete group",
            error: error.message
        });
    } finally {
        conn.release();
    }
});
// PASSWORD GROUP END

// PASSWORD GROUP FIRM CREDENTIALS START
router.post("/password-group/create-firm-credentials", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { group_id, firm_id, username, password, description } = req.body || {};
        const create_by = req.headers["username"] || "";
        const branch_id = req.branch_id;

        if (!group_id || !firm_id) {
            return res.status(400).json({
                success: false,
                message: "Group ID and firm ID are required"
            });
        }

        if (!username || !password) {
            return res.status(400).json({
                success: false,
                message: "Username and password are required"
            });
        }

        const [groupRecord] = await pool.query(
            `SELECT group_id, group_name FROM password_groups 
             WHERE group_id = ? AND branch_id = ? AND is_deleted = '0'`,
            [group_id, branch_id]
        );

        if (groupRecord.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Group not found"
            });
        }

        const [firmExists] = await pool.query(
            `SELECT firm_id, firm_name FROM firms 
             WHERE firm_id = ? AND branch_id = ? AND is_deleted = '0'`,
            [firm_id, branch_id]
        );

        if (firmExists.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Firm not found or does not belong to this branch"
            });
        }

        await conn.beginTransaction();

        const credential_id = RANDOM_STRING(30);

        await conn.query(
            `INSERT INTO password_group_firms 
                (credential_id, group_id, firm_id, username, password, description, 
                 create_by, modify_by, create_date, modify_date, is_deleted, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), '0', '1')`,
            [
                credential_id,
                group_id,
                firm_id,
                username?.trim(),
                password,
                description?.trim() || null,
                create_by,
                create_by
            ]
        );

        await conn.commit();

        const create_by_user = await USER_DATA(create_by);

        return res.status(200).json({
            success: true,
            message: "Firm credentials added successfully",
            data: {
                credential_id: credential_id,
                group_id: group_id,
                group_name: groupRecord[0].group_name,
                firm_id: firm_id,
                firm_name: firmExists[0].firm_name,
                username: username?.trim(),
                password: password,
                description: description?.trim() || null,
                status: '1',
                created_by: {
                    username: create_by_user?.username,
                    name: create_by_user?.name,
                    mobile: create_by_user?.mobile,
                    email: create_by_user?.email,
                },
                create_date: TIMESTAMP()
            }
        });

    } catch (error) {
        await conn.rollback();
        console.error("Error adding firm to group:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to add firm credentials",
            error: error.message
        });
    } finally {
        conn.release();
    }
});

router.get("/password-group/list-firm-credentials/:group_id", auth, validateBranch, async (req, res) => {
    try {
        const { group_id } = req.params;
        const branch_id = req.branch_id;
        const { search, page_no = 1, limit } = req.query;

        const parsedPageNo = Number(page_no);
        const pageNum = Number.isFinite(parsedPageNo) && parsedPageNo > 0 ? Math.floor(parsedPageNo) : 1;
        const parsedLimit = Number(limit);
        const limitNum = Number.isFinite(parsedLimit) && parsedLimit > 0
            ? Math.min(Math.floor(parsedLimit), 100)
            : 20;
        const offset = (pageNum - 1) * limitNum;

        const searchText = typeof search === "string" ? search.trim() : "";
        const hasSearch = searchText.length > 0;
        const searchPattern = hasSearch ? `%${searchText}%` : "%%";

        const [groupInfo] = await pool.query(
            `SELECT group_id, group_name, status FROM password_groups 
             WHERE group_id = ? AND branch_id = ? AND is_deleted = '0'`,
            [group_id, branch_id]
        );

        if (groupInfo.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Group not found"
            });
        }

        let countQuery = `
            SELECT COUNT(*) AS total
            FROM password_group_firms pg
            LEFT JOIN firms f
                ON pg.firm_id = f.firm_id
                AND f.branch_id = ?
                AND f.is_deleted = '0'
            WHERE pg.group_id = ? 
              AND pg.is_deleted = '0'
        `;

        let countParams = [branch_id, group_id];

        if (hasSearch) {
            countQuery += ` AND (pg.username LIKE ? OR pg.description LIKE ? OR IFNULL(f.firm_name, '') LIKE ?)`;
            countParams.push(searchPattern, searchPattern, searchPattern);
        }

        const [[{ total }]] = await pool.query(countQuery, countParams);

        let query = `
            SELECT 
                pg.credential_id,
                pg.group_id,
                pg.firm_id,
                pg.username as credential_username,
                pg.password,
                pg.description,
                pg.status as credential_status,
                pg.create_by,
                pg.create_date,
                pg.modify_by,
                pg.modify_date,
                
                f.firm_name,
                f.firm_type,
                f.gst_no,
                f.pan_no,
                f.tan_no,
                f.vat_no,
                f.cin_no,
                f.file_no,
                f.address_line_1,
                f.address_line_2,
                f.city,
                f.district,
                f.state,
                f.country,
                f.pincode,
                f.status as firm_status,
                f.remark as firm_remark,
                
                c.username as owner_username,
                c.status as owner_status
                
            FROM password_group_firms pg
            LEFT JOIN firms f 
                ON pg.firm_id = f.firm_id
                AND f.branch_id = ? 
                AND f.is_deleted = '0'
            LEFT JOIN clients c 
                ON f.username = c.username 
                AND c.user_type = 'client' 
                AND c.is_deleted = '0'
            WHERE pg.group_id = ? 
              AND pg.is_deleted = '0'
        `;

        let queryParams = [branch_id, group_id];

        if (hasSearch) {
            query += ` AND (pg.username LIKE ? OR pg.description LIKE ? OR f.firm_name LIKE ?)`;
            queryParams.push(searchPattern, searchPattern, searchPattern);
        }

        query += ` ORDER BY pg.id DESC LIMIT ? OFFSET ?`;
        queryParams.push(limitNum, offset);

        const [rows] = await pool.query(query, queryParams);

        const credentials = [];
        for (const el of rows) {
            const create_by_user = await USER_DATA(el?.create_by);
            const modify_by_user = await USER_DATA(el?.modify_by);
            const owner_details = el.owner_username ? await USER_DATA(el.owner_username) : null;

            credentials.push({
                credential: {
                    credential_id: el.credential_id,
                    username: el.credential_username,
                    password: el.password,
                    description: el.description,
                    status: el.credential_status == "1",
                    created_by: {
                        name: create_by_user?.name,
                        mobile: create_by_user?.mobile,
                        email: create_by_user?.email,
                    },
                    modified_by: {
                        name: modify_by_user?.name,
                        mobile: modify_by_user?.mobile,
                        email: modify_by_user?.email,
                    },
                    create_date: el.create_date,
                    modify_date: el.modify_date
                },
                firm: {
                    firm_id: el.firm_id,
                    firm_name: el.firm_name,
                    firm_type: el.firm_type,
                    gst_no: el.gst_no,
                    pan_no: el.pan_no,
                    tan_no: el.tan_no,
                    vat_no: el.vat_no,
                    cin_no: el.cin_no,
                    file_no: el.file_no,
                    address: {
                        line1: el.address_line_1,
                        line2: el.address_line_2,
                        city: el.city,
                        district: el.district,
                        state: el.state,
                        country: el.country,
                        pincode: el.pincode
                    },
                    status: el.firm_status == "1",
                    remark: el.firm_remark
                },
                client: el.owner_username ? {
                    username: el.owner_username,
                    name: owner_details?.name || null,
                    mobile: owner_details?.mobile || null,
                    email: owner_details?.email || null,
                    status: el.owner_status == "1"
                } : null
            });
        }

        const groupDetails = groupInfo[0];

        return res.status(200).json({
            success: true,
            message: "Group credentials fetched successfully",
            group: {
                group_id: groupDetails.group_id,
                group_name: groupDetails.group_name,
                status: groupDetails.status == "1"
            },
            data: credentials,
            meta: {
                page: pageNum,
                limit: limitNum,
                total: total,
                total_pages: Math.ceil(total / limitNum),
                is_last_page: offset + rows.length >= total
            }
        });

    } catch (error) {
        console.error("Error fetching group credentials:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch group credentials",
            error: error.message
        });
    }
});

router.put("/password-group/edit-firm-credentials/:credential_id", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { credential_id } = req.params;
        const { username, password, description, status } = req.body || {};
        const modify_by = req.headers["username"] || "";
        const branch_id = req.branch_id;

        if (!credential_id) {
            return res.status(400).json({
                success: false,
                message: "Credential ID is required"
            });
        }

        const [existing] = await pool.query(
            `SELECT pg.*, f.firm_name, p.group_name 
             FROM password_group_firms pg
             INNER JOIN password_groups p ON pg.group_id = p.group_id
             LEFT JOIN firms f ON pg.firm_id = f.firm_id
             WHERE pg.credential_id = ? 
               AND p.branch_id = ? 
               AND pg.is_deleted = '0'`,
            [credential_id, branch_id]
        );

        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Credential not found"
            });
        }

        await conn.beginTransaction();

        await conn.query(
            `UPDATE password_group_firms
             SET username = ?,
                 password = ?,
                 description = ?,
                 status = ?,
                 modify_by = ?,
                 modify_date = NOW()
             WHERE credential_id = ? AND is_deleted = '0'`,
            [
                username !== undefined ? (username?.trim() || null) : existing[0].username,
                password !== undefined ? password : existing[0].password,
                description !== undefined ? (description?.trim() || null) : existing[0].description,
                status !== undefined ? status : existing[0].status,
                modify_by,
                credential_id
            ]
        );

        await conn.commit();

        const modify_by_user = await USER_DATA(modify_by);

        return res.status(200).json({
            success: true,
            message: "Credential updated successfully",
            data: {
                credential_id: credential_id,
                group_id: existing[0].group_id,
                group_name: existing[0].group_name,
                firm_id: existing[0].firm_id,
                firm_name: existing[0].firm_name || 'Unknown Firm',
                username: username !== undefined ? (username?.trim() || null) : existing[0].username,
                password: password !== undefined ? password : existing[0].password,
                description: description !== undefined ? (description?.trim() || null) : existing[0].description,
                status: status !== undefined ? status : existing[0].status,
                modified_by: {
                    username: modify_by_user?.username,
                    name: modify_by_user?.name,
                    mobile: modify_by_user?.mobile,
                    email: modify_by_user?.email,
                },
                modify_date: TIMESTAMP()
            }
        });

    } catch (error) {
        await conn.rollback();
        console.error("Error updating credential:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update credential",
            error: error.message
        });
    } finally {
        conn.release();
    }
});

router.delete("/password-group/delete-firm-credentials", auth, validateBranch, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const rawIds = req.body?.credential_ids;
        const delete_by = req.headers["username"] || "";
        const branch_id = req.branch_id;

        if (!Array.isArray(rawIds) || rawIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: "credential_ids must be a non-empty array"
            });
        }

        const credential_ids = [...new Set(
            rawIds
                .map((id) => (typeof id === "string" ? id.trim() : String(id ?? "").trim()))
                .filter((id) => id.length > 0)
        )];

        if (credential_ids.length === 0) {
            return res.status(400).json({
                success: false,
                message: "credential_ids must contain at least one valid id"
            });
        }

        const placeholders = credential_ids.map(() => "?").join(", ");

        const [existing] = await pool.query(
            `SELECT pg.credential_id 
             FROM password_group_firms pg
             INNER JOIN password_groups p ON pg.group_id = p.group_id
             WHERE pg.credential_id IN (${placeholders})
               AND p.branch_id = ? 
               AND pg.is_deleted = '0'`,
            [...credential_ids, branch_id]
        );

        const foundSet = new Set(existing.map((row) => row.credential_id));
        if (foundSet.size !== credential_ids.length) {
            const not_found = credential_ids.filter((id) => !foundSet.has(id));
            return res.status(400).json({
                success: false,
                message: "One or more credentials were not found, already deleted, or do not belong to this branch",
                not_found
            });
        }

        await conn.beginTransaction();

        await conn.query(
            `UPDATE password_group_firms
             SET is_deleted = '1',
                 deleted_by = ?,
                 modify_by = ?,
                 modify_date = NOW()
             WHERE credential_id IN (${placeholders})`,
            [delete_by, delete_by, ...credential_ids]
        );

        await conn.commit();

        return res.status(200).json({
            success: true,
            message: "Credentials deleted successfully",
            deleted_count: credential_ids.length
        });

    } catch (error) {
        await conn.rollback();
        console.error("Error deleting credential:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to delete credential",
            error: error.message
        });
    } finally {
        conn.release();
    }
});
// PASSWORD GROUP FIRM CREDENTIALS END

export default router;