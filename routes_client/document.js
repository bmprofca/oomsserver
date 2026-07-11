import express from "express";
import pool from "../db.js";
import { UNIQUE_RANDOM_STRING, ID_LENGTH, USER_DATA } from "../helpers/function.js";
import {
    deleteProfileDocument,
    downloadAndUploadProfileDocument,
    downloadProfileDocument,
    getProfileDocumentAccessUrl,
} from "../helpers/b2Storage.js";
import { validateClientSession, readClientCredential } from "../middleware/validateClientSession.js";
import { BASE_DOMAIN } from "../helpers/Config.js";

const router = express.Router();

const SHARABLE_CATEGORY = "SHARABLE";
const SHARABLE_FOLDER = "sharable";

const DOCUMENT_TYPES = {
    it: [
        { name: "Full Set", value: "full_set" },
        { name: "TIS", value: "tis" },
        { name: "AIS", value: "ais" },
    ],
    gst: [
        { name: "GSTR 3B (Monthly)", value: "gstr_3b_monthly" },
        { name: "GSTR 1 (Quarterly)", value: "gstr_1_quarterly" },
        { name: "GSTR 2 (Quarterly)", value: "gstr_2_quarterly" },
        { name: "GSTR 4 (Yearly)", value: "gstr_4_yearly" },
    ],
    mca: [
        { name: "DIN", value: "din" },
        { name: "Chalan", value: "chalan" },
    ],
};

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
        el.file ? getProfileDocumentAccessUrl(categoryFolder, el.file) : Promise.resolve(null),
    ]);

    return {
        firm: {
            firm_id: el.firm_id,
            name: el.firm_name ?? null,
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

async function getDocumentListByCategory(branch_id, username, category_id, categoryFolder, query) {
    const pageNum = Math.max(1, Number(query.page_no || query.page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const offset = (pageNum - 1) * limitNum;

    const firm_id = query.firm_id != null ? String(query.firm_id).trim() : "";
    const month = query.month != null ? String(query.month).trim() : "";
    const type = query.type != null ? String(query.type).trim() : "";
    const year = query.year != null ? String(query.year).trim() : "";

    const conditions = ["d.branch_id = ?", "d.category_id = ?", "d.username = ?", "d.is_deleted = '0'"];
    const params = [branch_id, category_id, username];

    if (firm_id !== "") {
        conditions.push("d.firm_id LIKE ?");
        params.push(`%${firm_id}%`);
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

    const whereClause = conditions.join(" AND ");

    const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) AS total FROM documents d WHERE ${whereClause}`,
        params
    );

    const [rows] = await pool.query(
        `SELECT
            d.firm_id,
            f.firm_name,
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
         WHERE ${whereClause}
         ORDER BY d.id DESC
         LIMIT ? OFFSET ?`,
        [...params, limitNum, offset]
    );

    const userCache = new Map();
    const data = await Promise.all(
        rows.map((el) => formatDocumentRow(el, categoryFolder, userCache))
    );

    return { data, total, pageNum, limitNum, offset, rowCount: rows.length };
}

async function listDocumentsByCategory(req, res, { categoryId, categoryFolder, label }) {
    try {
        const branch_id = req.branch_id;
        const username = req.client_username;
        const result = await getDocumentListByCategory(
            branch_id,
            username,
            categoryId,
            categoryFolder,
            req.query || {}
        );

        return res.status(200).json({
            success: true,
            message: `${label} documents fetched successfully`,
            data: result.data,
            pagination: {
                page_no: result.pageNum,
                limit: result.limitNum,
                total: result.total,
                total_pages: Math.ceil(result.total / result.limitNum) || 1,
                is_last_page: result.offset + result.rowCount >= result.total,
            },
        });
    } catch (error) {
        console.error(`CLIENT ${label} DOCUMENT LIST ERROR:`, error);
        return res.status(500).json({
            success: false,
            message: `Failed to fetch ${label} documents`,
        });
    }
}

router.get("/types", validateClientSession, async (req, res) => {
    return res.status(200).json({
        success: true,
        data: DOCUMENT_TYPES,
    });
});

router.get("/list/gst", validateClientSession, (req, res) =>
    listDocumentsByCategory(req, res, {
        categoryId: "GST",
        categoryFolder: "gst",
        label: "GST",
    })
);

router.get("/list/it", validateClientSession, (req, res) =>
    listDocumentsByCategory(req, res, {
        categoryId: "IT",
        categoryFolder: "it",
        label: "IT",
    })
);

router.get("/list/mca", validateClientSession, (req, res) =>
    listDocumentsByCategory(req, res, {
        categoryId: "MCA",
        categoryFolder: "mca",
        label: "MCA",
    })
);

function buildSharableFileAccessUrl(req, document_id) {
    const params = new URLSearchParams();
    for (const key of ["token", "countrycode", "mobile", "username"]) {
        const value = readClientCredential(req, key);
        if (value) {
            params.set(key, value);
        }
    }

    const query = params.toString();
    return `${BASE_DOMAIN}/client/document/sharable/file/${document_id}${query ? `?${query}` : ""}`;
}

async function resolveSharableFileUrl(req, row) {
    if (!row.file) {
        return null;
    }

    try {
        return await getProfileDocumentAccessUrl(SHARABLE_FOLDER, row.file);
    } catch (error) {
        console.error("SHARABLE B2 URL ERROR:", error.message);
        if (req && row.document_id) {
            return buildSharableFileAccessUrl(req, row.document_id);
        }
        return null;
    }
}

async function formatSharableDocumentRow(row, userCache, req) {
    const [create_by, modify_by, file] = await Promise.all([
        formatAuditUser(row.created_by, userCache),
        formatAuditUser(row.modify_by, userCache),
        resolveSharableFileUrl(req, row),
    ]);

    return {
        document_id: row.document_id,
        name: row.name,
        firm: {
            firm_id: row.firm_id,
            name: row.firm_name ?? null,
        },
        remark: row.remark,
        file,
        size: row.size,
        mime_type: row.mime_type,
        create_date: row.create_date,
        modify_date: row.modify_date,
        create_by,
        modify_by,
    };
}

router.post("/sharable/create", validateClientSession, async (req, res) => {
    let uploadedFile = null;

    try {
        const branch_id = req.branch_id;
        const username = req.client_username;
        const { url, name, firm_id, remark } = req.body || {};

        if (!url || typeof url !== "string" || url.trim() === "") {
            return res.status(400).json({
                success: false,
                message: "url is required",
            });
        }

        if (!name || String(name).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "name is required",
            });
        }

        if (!firm_id || String(firm_id).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "firm_id is required",
            });
        }

        const resolvedFirmId = String(firm_id).trim();
        const resolvedName = String(name).trim().slice(0, 100);
        const resolvedRemark =
            remark != null && String(remark).trim() !== "" ? String(remark).trim() : null;

        const [firmRows] = await pool.query(
            `SELECT firm_id
             FROM firms
             WHERE firm_id = ?
               AND branch_id = ?
               AND username = ?
               AND (is_deleted = '0' OR is_deleted = 0)
             LIMIT 1`,
            [resolvedFirmId, branch_id, username]
        );

        if (!firmRows.length) {
            return res.status(404).json({
                success: false,
                message: "Firm not found",
            });
        }

        let uploadResult;
        try {
            uploadResult = await downloadAndUploadProfileDocument(url.trim(), SHARABLE_FOLDER);
            uploadedFile = uploadResult.filename;
        } catch (uploadError) {
            return res.status(400).json({
                success: false,
                message: uploadError.message || "Failed to download and upload document",
            });
        }

        const document_id = await UNIQUE_RANDOM_STRING("documents", "document_id", { length: ID_LENGTH });

        try {
            await pool.query(
                `INSERT INTO documents (
                    document_id,
                    branch_id,
                    firm_id,
                    username,
                    category_id,
                    name,
                    remark,
                    is_reserved,
                    file,
                    size,
                    mime_type,
                    created_by,
                    create_date,
                    modify_by,
                    modify_date,
                    is_deleted
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NOW(), ?, NOW(), 0)`,
                [
                    document_id,
                    branch_id,
                    resolvedFirmId,
                    username,
                    SHARABLE_CATEGORY,
                    resolvedName,
                    resolvedRemark,
                    uploadResult.filename,
                    uploadResult.size,
                    uploadResult.mimeType,
                    username,
                    username,
                ]
            );
        } catch (dbError) {
            try {
                await deleteProfileDocument(SHARABLE_FOLDER, uploadedFile);
            } catch (_) { }
            throw dbError;
        }

        const file = await resolveSharableFileUrl(req, {
            document_id,
            file: uploadResult.filename,
        });

        return res.status(200).json({
            success: true,
            message: "Sharable document created successfully",
            data: {
                document_id,
                name: resolvedName,
                firm_id: resolvedFirmId,
                remark: resolvedRemark,
                file,
                size: uploadResult.size,
                mime_type: uploadResult.mimeType,
            },
        });
    } catch (error) {
        if (uploadedFile) {
            try {
                await deleteProfileDocument(SHARABLE_FOLDER, uploadedFile);
            } catch (_) { }
        }
        console.error("CLIENT SHARABLE DOCUMENT CREATE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to create sharable document",
        });
    }
});

router.get("/sharable/list", validateClientSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.client_username;
        const { page_no = 1, limit = 20, search, firm_id } = req.query || {};

        const pageNum = Math.max(1, Number(page_no) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
        const offset = (pageNum - 1) * limitNum;

        const conditions = [
            "d.branch_id = ?",
            "d.username = ?",
            "d.category_id = ?",
            "d.is_deleted = '0'",
        ];
        const params = [branch_id, username, SHARABLE_CATEGORY];

        if (firm_id && String(firm_id).trim() !== "") {
            conditions.push("d.firm_id = ?");
            params.push(String(firm_id).trim());
        }

        if (search && String(search).trim() !== "") {
            const searchPattern = `%${String(search).trim()}%`;
            conditions.push(`
                (
                    d.document_id LIKE ?
                    OR d.name LIKE ?
                    OR d.remark LIKE ?
                    OR f.firm_name LIKE ?
                    OR f.firm_id LIKE ?
                )
            `);
            params.push(
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern,
                searchPattern
            );
        }

        const whereClause = conditions.join(" AND ");

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total
             FROM documents d
             LEFT JOIN firms f
               ON f.firm_id = d.firm_id
              AND f.branch_id = d.branch_id
              AND (f.is_deleted = '0' OR f.is_deleted = 0)
             WHERE ${whereClause}`,
            params
        );

        const [rows] = await pool.query(
            `SELECT
                d.document_id,
                d.firm_id,
                f.firm_name,
                d.name,
                d.remark,
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
             WHERE ${whereClause}
             ORDER BY d.id DESC
             LIMIT ? OFFSET ?`,
            [...params, limitNum, offset]
        );

        const userCache = new Map();
        const data = await Promise.all(
            rows.map((row) => formatSharableDocumentRow(row, userCache, req))
        );

        return res.status(200).json({
            success: true,
            message: "Sharable documents fetched successfully",
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
        console.error("CLIENT SHARABLE DOCUMENT LIST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch sharable documents",
        });
    }
});

router.get("/sharable/file/:document_id", validateClientSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.client_username;
        const document_id = String(req.params.document_id || "").trim();

        if (!document_id) {
            return res.status(400).json({
                success: false,
                message: "document_id is required",
            });
        }

        const [rows] = await pool.query(
            `SELECT file, mime_type, name
             FROM documents
             WHERE document_id = ?
               AND branch_id = ?
               AND username = ?
               AND category_id = ?
               AND is_deleted = '0'
             LIMIT 1`,
            [document_id, branch_id, username, SHARABLE_CATEGORY]
        );

        if (!rows.length || !rows[0].file) {
            return res.status(404).json({
                success: false,
                message: "Sharable document not found",
            });
        }

        const document = rows[0];
        const { stream, mimeType, size } = await downloadProfileDocument(
            SHARABLE_FOLDER,
            document.file
        );

        res.setHeader("Content-Type", mimeType || document.mime_type || "application/octet-stream");
        if (size) {
            res.setHeader("Content-Length", String(size));
        }
        if (document.name) {
            res.setHeader(
                "Content-Disposition",
                `inline; filename="${String(document.name).replace(/"/g, "")}"`
            );
        }

        stream.on("error", (error) => {
            console.error("SHARABLE FILE STREAM ERROR:", error);
            if (!res.headersSent) {
                res.status(500).json({
                    success: false,
                    message: "Failed to stream document file",
                });
            } else {
                res.end();
            }
        });

        stream.pipe(res);
    } catch (error) {
        console.error("CLIENT SHARABLE FILE DOWNLOAD ERROR:", error);
        if (!res.headersSent) {
            return res.status(500).json({
                success: false,
                message: "Failed to download sharable document",
            });
        }
        return res.end();
    }
});

router.delete("/sharable/delete/:document_id", validateClientSession, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = req.client_username;
        const document_id = String(req.params.document_id || "").trim();

        if (!document_id) {
            return res.status(400).json({
                success: false,
                message: "document_id is required",
            });
        }

        const [rows] = await pool.query(
            `SELECT document_id
             FROM documents
             WHERE document_id = ?
               AND branch_id = ?
               AND username = ?
               AND category_id = ?
               AND is_deleted = '0'
             LIMIT 1`,
            [document_id, branch_id, username, SHARABLE_CATEGORY]
        );

        if (!rows.length) {
            return res.status(404).json({
                success: false,
                message: "Sharable document not found",
            });
        }

        await pool.query(
            `UPDATE documents
             SET is_deleted = '1', modify_by = ?, modify_date = NOW()
             WHERE document_id = ?
               AND branch_id = ?
               AND username = ?
               AND category_id = ?`,
            [username, document_id, branch_id, username, SHARABLE_CATEGORY]
        );

        return res.status(200).json({
            success: true,
            message: "Sharable document deleted successfully",
        });
    } catch (error) {
        console.error("CLIENT SHARABLE DOCUMENT DELETE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to delete sharable document",
        });
    }
});

export default router;
