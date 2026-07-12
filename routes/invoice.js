import express from "express";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { TODAY_DATE } from "../helpers/function.js";
import { getFormatSamplePdfsBase64 } from "../helpers/invoiceFormatSamplePdfs.js";
import {
    ALLOWED_GENERATE_TYPES,
    buildInvoicePdfBuffer,
    isBranchStaffOrAdmin,
    normInvoiceType,
    saveInvoicePdfLink,
} from "../services/invoiceGenerateService.js";

const router = express.Router();

const INVOICE_TYPE_TO_FORMAT_COLUMN = {
    sale: "sale",
    purchase: "purchase",
    payment: "payment",
    receive: "receive",
    "payment receive": "receive",
    journal: "journal",
    contra: "contra",
    expense: "expense",
};

const INVOICE_FORMAT_COLUMNS = ["sale", "purchase", "payment", "receive", "journal", "contra", "expense"];

const FORMAT_VARIANT_IDS = [
    "classic", 
    "compact", 
    "minimal",
    "premium_modern",    
    "premium_elegant",   
    "premium_corporate", 
    "premium_creative",  
    "premium_luxury"     
];

function getFormatColumnForInvoiceType(invoiceType) {
    if (invoiceType == null) return null;
    const key = String(invoiceType).trim().toLowerCase();
    return INVOICE_TYPE_TO_FORMAT_COLUMN[key] ?? null;
}

function isValidFormatKey(key) {
    return FORMAT_VARIANT_IDS.includes(key);
}

async function ensureBranchInvoiceFormatsRow(branch_id) {
    const [existing] = await pool.query(
        "SELECT * FROM `invoice_formats` WHERE `branch_id` = ? ORDER BY `id` ASC LIMIT 1",
        [branch_id]
    );
    if (existing.length > 0) {
        return existing[0];
    }
    await pool.query(
        `INSERT INTO \`invoice_formats\` (\`branch_id\`, \`sale\`, \`purchase\`, \`payment\`, \`receive\`, \`journal\`, \`contra\`, \`expense\`)
         VALUES (?, 'classic', 'classic', 'classic', 'classic', 'classic', 'classic', 'classic')`,
        [branch_id]
    );
    const [again] = await pool.query(
        "SELECT * FROM `invoice_formats` WHERE `branch_id` = ? ORDER BY `id` ASC LIMIT 1",
        [branch_id]
    );
    return again[0];
}

async function getActiveFormatKeyForInvoiceType(branch_id, invoiceType) {
    const col = getFormatColumnForInvoiceType(invoiceType);
    if (!col) {
        return "classic";
    }
    const row = await ensureBranchInvoiceFormatsRow(branch_id);
    const raw = row[col];
    return raw || "classic";
}

/** Body `response` for POST /generate: pdf (default) | base64 | link */
function normGenerateResponseMode(s) {
    const n = String(s == null || s === "" ? "pdf" : s).trim().toLowerCase();
    if (n === "pdf" || n === "base64" || n === "link") return n;
    return null;
}

router.get("/formats", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const rawType = req.query?.type;
        const bodyType = normInvoiceType(rawType || "sale");
        const active_format = await getActiveFormatKeyForInvoiceType(branch_id, bodyType);
        const samples = await getFormatSamplePdfsBase64(bodyType);
        
        return res.status(200).json({
            success: true,
            message: "Format sample PDFs retrieved successfully",
            data: {
                branch_id,
                type: bodyType,
                active_format,
                samples,
            },
        });
    } catch (error) {
        console.error("Invoice formats GET error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to load format sample PDFs",
            error: error.message,
        });
    }
});

router.put("/update-format", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const caller = String(req.headers["username"] || req.headers["Username"] || "").trim();
        const staff = await isBranchStaffOrAdmin(caller, branch_id);
        if (!staff) {
            return res.status(403).json({
                success: false,
                message: "Only branch staff or admin can update invoice formats",
            });
        }

        const body = req.body || {};
        if (body.type == null || String(body.type).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "type is required",
            });
        }
        const bodyType = normInvoiceType(body.type);
        const col = getFormatColumnForInvoiceType(bodyType);
        if (!col || !INVOICE_FORMAT_COLUMNS.includes(col)) {
            return res.status(400).json({
                success: false,
                message: "Invalid invoice type mapping for formats",
            });
        }

        const rawFormat = body.format_id;
        if (rawFormat == null || String(rawFormat).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "format_id is required",
            });
        }
        if (!isValidFormatKey(rawFormat)) {
            return res.status(400).json({
                success: false,
                message: 'format_id must be one of: classic, compact, minimal, premium_modern, premium_elegant, premium_corporate, premium_creative, premium_luxury',
            });
        }

        await ensureBranchInvoiceFormatsRow(branch_id);
        await pool.query(
            `UPDATE \`invoice_formats\` SET \`${col}\` = ? WHERE \`branch_id\` = ? LIMIT 1`,
            [rawFormat, branch_id]
        );

        const [updated] = await pool.query(
            "SELECT * FROM `invoice_formats` WHERE `branch_id` = ? ORDER BY `id` ASC LIMIT 1",
            [branch_id]
        );
        const row = updated[0];
        const settings = {};
        for (let i = 0; i < INVOICE_FORMAT_COLUMNS.length; i++) {
            const c = INVOICE_FORMAT_COLUMNS[i];
            settings[c] = row[c] || "classic";
        }
        
        return res.status(200).json({
            success: true,
            message: "Invoice format updated successfully",
            data: {
                branch_id,
                type: bodyType,
                format_id: rawFormat,
                settings,
            },
        });
    } catch (error) {
        console.error("Invoice update-formats PUT error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update invoice formats",
            error: error.message,
        });
    }
});

// Support both /generate and /generate-invoice under /invoice
const generateHandler = async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const caller = String(req.headers["username"] || req.headers["Username"] || "").trim();
        const { invoice_id, type: bodyType, response: responseRaw } = req.body || {};

        if (!invoice_id || String(invoice_id).trim() === "") {
            return res.status(400).json({ success: false, message: "invoice_id is required" });
        }
        if (bodyType == null || String(bodyType).trim() === "") {
            return res.status(400).json({
                success: false,
                message:
                    "type is required (e.g. sale, purchase, payment, receive, payment receive, journal, contra, expense)",
            });
        }
        if (!ALLOWED_GENERATE_TYPES.has(normInvoiceType(bodyType))) {
            return res.status(400).json({
                success: false,
                message: `Invalid type. Allowed: ${[...ALLOWED_GENERATE_TYPES].sort().join(", ")}`,
            });
        }

        const responseMode = normGenerateResponseMode(responseRaw);
        if (responseMode == null) {
            return res.status(400).json({
                success: false,
                message: 'response must be "pdf", "base64", or "link" (omit for pdf)',
            });
        }

        const built = await buildInvoicePdfBuffer(branch_id, caller, invoice_id, bodyType);
        if (built.error) {
            return res.status(built.error.status).json({
                success: false,
                message: built.error.message,
            });
        }

        if (responseMode === "pdf") {
            res.setHeader("Content-Type", "application/pdf");
            res.setHeader("Content-Disposition", `attachment; filename="${built.filename}"`);
            res.setHeader("Cache-Control", "no-cache");
            return res.send(built.buffer);
        }

        if (responseMode === "base64") {
            return res.status(200).json({
                success: true,
                message: "Invoice PDF generated successfully",
                data: {
                    invoice_id: built.invoice_id,
                    type: built.type,
                    format_id: built.formatKey,
                    filename: built.filename,
                    data: built.buffer.toString("base64"),
                },
            });
        }

        const saved = await saveInvoicePdfLink(built);
        return res.status(200).json({
            success: true,
            message: "Invoice PDF saved",
            data: {
                invoice_id: built.invoice_id,
                type: built.type,
                format_id: built.formatKey,
                url: saved.url,
                filename: saved.filename,
                suggested_filename: saved.suggested_filename,
            },
        });
    } catch (error) {
        console.error("Invoice generate error:", error);
        if (!res.headersSent) {
            return res.status(500).json({
                success: false,
                message: "Failed to generate invoice",
                error: error.message,
            });
        }
    }
};

router.post("/generate", auth, validateBranch, generateHandler);
router.post("/generate-invoice", auth, validateBranch, generateHandler);

router.get("/prefix/list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const [rows] = await pool.query("SELECT * FROM `invoice_prefix` WHERE `branch_id` = ? AND is_deleted = '0'", [branch_id]);

        const data = rows.map(row => ({
            id: row.id,
            type: row.type,
            prefix: row.prefix,
            current: Number(row.current || 0) + 1,
            issue_date: row.issue_date,
            expire_date: row.expire_date
        }));

        return res.status(200).json({ success: true, message: "Invoice prefix list retrieved successfully", data: data });
    } catch (error) {
        console.error("Invoice prefix list GET error:", error);
        return res.status(500).json({ success: false, message: "Failed to retrieve invoice prefix list", error: error.message });
    }
});

router.post("/prefix/create", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const caller = String(req.headers["username"] || req.headers["Username"] || "").trim();
        const { type, prefix, issue_date, expire_date, current } = req.body || {};
        if (!type || !prefix || !issue_date || !expire_date) {
            return res.status(400).json({ success: false, message: "type, prefix, issue_date, and expire_date are required" });
        }

        const currentNum = Number(current || 1) - 1;

        await pool.query("INSERT INTO `invoice_prefix` (`branch_id`, `type`, `prefix`, `current`, `issue_date`, `expire_date`, `create_by`, `modify_by`, `create_date`, `modify_date`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [branch_id, type, prefix, currentNum, issue_date, expire_date, caller, caller, TODAY_DATE(), TODAY_DATE()]);

        return res.status(200).json({
            success: true,
            message: "Invoice prefix created successfully",
            data: {
                type: type,
                prefix: prefix,
                current: currentNum + 1,
                issue_date: issue_date,
                expire_date: expire_date,
            }
        });
    } catch (error) {
        console.error("Invoice prefix create POST error:", error);
        return res.status(500).json({ success: false, message: "Failed to create invoice prefix", error: error.message });
    }
});

router.delete("/prefix/delete", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const caller = String(req.headers["username"] || req.headers["Username"] || "").trim();
        const { id } = req.body || {};
        await pool.query("UPDATE `invoice_prefix` SET `is_deleted` = '1', `deleted_by` = ?, `modify_by` = ?, `modify_date` = ? WHERE `id` = ?", [caller, caller, TODAY_DATE(), id]);
        return res.status(200).json({ success: true, message: "Invoice prefix deleted successfully" });
    } catch (error) {
        console.error("Invoice prefix delete DELETE error:", error);
        return res.status(500).json({ success: false, message: "Failed to delete invoice prefix", error: error.message });
    }
});

export default router;
