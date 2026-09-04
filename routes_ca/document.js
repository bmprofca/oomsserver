import express from "express";
import pool from "../db.js";
import { USER_DATA } from "../helpers/function.js";
import { getProfileDocumentAccessUrl } from "../helpers/b2Storage.js";
import CLIENT_DOCUMENT_TYPES from "../helpers/clientDocumentTypes.js";
import { validateCaSession } from "../middleware/validateCaSession.js";

const router = express.Router();

const CATEGORY_MAP = {
    gst: { id: "GST", folder: "gst", label: "GST" },
    it: { id: "IT", folder: "it", label: "IT" },
    mca: { id: "MCA", folder: "mca", label: "MCA" },
    general: { id: "GENERAL", folder: "general", label: "General" },
};

const CA_FIRM_DOC_SCOPE = `
    EXISTS (
        SELECT 1
        FROM tasks t
        WHERE t.firm_id = d.firm_id
          AND t.branch_id = d.branch_id
          AND t.has_ca = '1'
          AND t.ca_id = ?
    )
`;

async function formatAuditUser(username, cache) {
    const key = username != null ? String(username).trim() : "";
    if (!key) {
        return { username: null, name: null, email: null };
    }
    if (!cache.has(key)) {
        const user = await USER_DATA(key);
        cache.set(key, {
            username: user.username ?? key,
            name: user.name ?? null,
            email: user.email ?? null,
        });
    }
    return cache.get(key);
}

async function formatDocumentRow(el, categoryFolder, userCache) {
    const [create_by, modify_by, file] = await Promise.all([
        formatAuditUser(el.created_by, userCache),
        formatAuditUser(el.modify_by, userCache),
        el.file
            ? getProfileDocumentAccessUrl(categoryFolder, el.file)
            : Promise.resolve(null),
    ]);

    return {
        firm: {
            firm_id: el.firm_id,
            name: el.firm_name ?? null,
        },
        client: {
            username: el.username,
            name: el.client_name ?? null,
        },
        category_id: el.category_id,
        f_year: el.f_year,
        type: el.type,
        remark: el.remark,
        month: el.month,
        file,
        size: el.size,
        mime_type: el.mime_type,
        create_date: el.create_date,
        modify_date: el.modify_date,
        create_by,
        modify_by,
    };
}

async function listDocumentsByCategory(req, res, categoryKey) {
    try {
        const meta = CATEGORY_MAP[categoryKey];
        if (!meta) {
            return res.status(400).json({
                success: false,
                message: "Invalid document category",
            });
        }

        const branch_id = req.branch_id;
        const ca_username = req.ca_username;
        const query = req.query || {};

        const pageNum = Math.max(1, Number(query.page_no || query.page) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(query.limit) || 20));
        const offset = (pageNum - 1) * limitNum;

        const firm_id = query.firm_id != null ? String(query.firm_id).trim() : "";
        const month = query.month != null ? String(query.month).trim() : "";
        const type = query.type != null ? String(query.type).trim() : "";
        const year = query.year != null ? String(query.year).trim() : "";
        const search = query.search != null ? String(query.search).trim() : "";

        const conditions = [
            "d.branch_id = ?",
            "d.category_id = ?",
            "d.is_deleted = '0'",
            CA_FIRM_DOC_SCOPE,
        ];
        const params = [branch_id, meta.id, ca_username];

        if (firm_id !== "") {
            conditions.push("d.firm_id = ?");
            params.push(firm_id);
        }
        if (month !== "") {
            conditions.push("d.month LIKE ?");
            params.push(`%${month}%`);
        }
        if (type !== "") {
            conditions.push("d.type LIKE ?");
            params.push(`%${type}%`);
        }
        if (year !== "") {
            conditions.push("d.f_year LIKE ?");
            params.push(`%${year}%`);
        }
        if (search !== "") {
            const pattern = `%${search}%`;
            conditions.push(`(
                f.firm_name LIKE ?
                OR d.type LIKE ?
                OR d.remark LIKE ?
                OR p.name LIKE ?
            )`);
            params.push(pattern, pattern, pattern, pattern);
        }

        const whereClause = conditions.join(" AND ");

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total
             FROM documents d
             LEFT JOIN firms f
               ON f.firm_id = d.firm_id
              AND f.branch_id = d.branch_id
              AND (f.is_deleted = '0' OR f.is_deleted = 0)
             LEFT JOIN profile p
               ON p.username = d.username
              AND p.id = (
                  SELECT MAX(p2.id)
                  FROM profile p2
                  WHERE p2.username = d.username
              )
             WHERE ${whereClause}`,
            params
        );

        const [rows] = await pool.query(
            `SELECT
                d.firm_id,
                d.username,
                f.firm_name,
                p.name AS client_name,
                d.category_id,
                d.f_year,
                d.type,
                d.remark,
                d.month,
                d.file,
                d.size,
                d.mime_type,
                d.create_date,
                d.modify_date,
                d.created_by,
                d.modify_by
             FROM documents d
             LEFT JOIN firms f
               ON f.firm_id = d.firm_id
              AND f.branch_id = d.branch_id
              AND (f.is_deleted = '0' OR f.is_deleted = 0)
             LEFT JOIN profile p
               ON p.username = d.username
              AND p.id = (
                  SELECT MAX(p2.id)
                  FROM profile p2
                  WHERE p2.username = d.username
              )
             WHERE ${whereClause}
             ORDER BY d.id DESC
             LIMIT ? OFFSET ?`,
            [...params, limitNum, offset]
        );

        const userCache = new Map();
        const data = await Promise.all(
            rows.map((el) => formatDocumentRow(el, meta.folder, userCache))
        );

        return res.status(200).json({
            success: true,
            message: `${meta.label} documents fetched successfully`,
            data,
            pagination: {
                page_no: pageNum,
                limit: limitNum,
                total: Number(total) || 0,
                total_pages: Math.ceil((Number(total) || 0) / limitNum) || 1,
                is_last_page: offset + rows.length >= (Number(total) || 0),
            },
        });
    } catch (error) {
        console.error(`CA ${categoryKey.toUpperCase()} DOCUMENT LIST ERROR:`, error);
        return res.status(500).json({
            success: false,
            message: `Failed to fetch ${categoryKey} documents`,
        });
    }
}

router.get("/types", validateCaSession, async (_req, res) => {
    return res.status(200).json({
        success: true,
        data: CLIENT_DOCUMENT_TYPES,
    });
});

router.get("/list/gst", validateCaSession, (req, res) =>
    listDocumentsByCategory(req, res, "gst")
);
router.get("/list/it", validateCaSession, (req, res) =>
    listDocumentsByCategory(req, res, "it")
);
router.get("/list/mca", validateCaSession, (req, res) =>
    listDocumentsByCategory(req, res, "mca")
);
router.get("/list/general", validateCaSession, (req, res) =>
    listDocumentsByCategory(req, res, "general")
);

export default router;
