import express from "express";
import { authAdmin } from "../middleware/authAdmin.js";
import {
    deleteInvoiceFormat,
    getInvoiceFormatById,
    isInvoiceFormatType,
    listInvoiceFormats,
    updateInvoiceFormat,
    variablesForInvoiceType,
} from "../helpers/invoiceFormatCatalog.js";
import { INVOICE_GENERATE_TYPES as FORMAT_TYPES } from "../helpers/invoiceFormatMapping.js";

const router = express.Router();

router.get("/", authAdmin, async (req, res) => {
    try {
        const type = String(req.query.type || "").trim().toLowerCase();
        if (type && !isInvoiceFormatType(type)) {
            return res.status(400).json({
                success: false,
                message: `Type must be one of: ${FORMAT_TYPES.join(", ")}`,
            });
        }
        const formats = await listInvoiceFormats({ invoiceType: type || undefined });
        return res.status(200).json({
            success: true,
            message: "Invoice formats retrieved",
            data: {
                types: FORMAT_TYPES,
                variables: type ? variablesForInvoiceType(type) : null,
                formats,
            },
        });
    } catch (error) {
        console.error("ADMIN INVOICE FORMATS LIST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to load invoice formats",
        });
    }
});

router.get("/variables", authAdmin, async (req, res) => {
    try {
        const type = String(req.query.type || "sale").trim().toLowerCase();
        if (!isInvoiceFormatType(type)) {
            return res.status(400).json({
                success: false,
                message: `Type must be one of: ${FORMAT_TYPES.join(", ")}`,
            });
        }
        return res.status(200).json({
            success: true,
            data: variablesForInvoiceType(type),
        });
    } catch (error) {
        console.error("ADMIN INVOICE FORMAT VARIABLES ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to load variables",
        });
    }
});

router.get("/:id", authAdmin, async (req, res) => {
    try {
        const row = await getInvoiceFormatById(Number(req.params.id));
        if (!row) {
            return res.status(404).json({ success: false, message: "Format not found" });
        }
        return res.status(200).json({
            success: true,
            data: {
                ...row,
                variables: variablesForInvoiceType(row.invoice_type),
            },
        });
    } catch (error) {
        console.error("ADMIN INVOICE FORMAT GET ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to load invoice format",
        });
    }
});

router.put("/:id", authAdmin, async (req, res) => {
    try {
        const result = await updateInvoiceFormat(Number(req.params.id), req.body || {});
        if (result.error) {
            return res.status(result.status || 400).json({ success: false, message: result.error });
        }
        return res.status(200).json({
            success: true,
            message: "Invoice format updated",
            data: result.row,
        });
    } catch (error) {
        console.error("ADMIN INVOICE FORMAT UPDATE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update invoice format",
        });
    }
});

router.delete("/:id", authAdmin, async (req, res) => {
    try {
        const result = await deleteInvoiceFormat(Number(req.params.id));
        if (result.error) {
            return res.status(result.status || 400).json({ success: false, message: result.error });
        }
        return res.status(200).json({
            success: true,
            message: "Invoice format deleted",
        });
    } catch (error) {
        console.error("ADMIN INVOICE FORMAT DELETE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to delete invoice format",
        });
    }
});

export default router;
