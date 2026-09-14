import express from "express";
import { authAdmin } from "../middleware/authAdmin.js";
import {
    getSystemSmsConfigRow,
    serializeSystemSmsConfig,
    upsertSystemSmsConfig,
} from "../helpers/smsSystemConfig.js";
import {
    listSmsSystemTypes,
    listAdminSystemTemplates,
    getSystemTemplateById,
    createSystemTemplate,
    updateSystemTemplate,
    setSystemTemplateStatus,
    deleteSystemTemplate,
} from "../services/smsSystemTemplateService.js";

const router = express.Router();

function actor(req) {
    return String(req.headers["username"] || "").trim() || null;
}

function statusFromError(error) {
    if (error?.status) return error.status;
    const message = error?.message || "Request failed";
    if (
        message.includes("required") ||
        message.includes("must be") ||
        message.includes("Invalid") ||
        message.includes("already exists") ||
        message.includes("Map all")
    ) {
        return 400;
    }
    if (message.includes("not found") || message.includes("Not found")) {
        return 404;
    }
    return 500;
}

/** GET /admin/sms-system/types */
router.get("/types", authAdmin, async (_req, res) => {
    try {
        return res.status(200).json({
            success: true,
            message: "System SMS types retrieved",
            data: listSmsSystemTypes(),
        });
    } catch (error) {
        console.error("ADMIN SMS SYSTEM TYPES ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error?.message || "Failed to load types",
        });
    }
});

/** GET /admin/sms-system/config */
router.get("/config", authAdmin, async (_req, res) => {
    try {
        const row = await getSystemSmsConfigRow();
        return res.status(200).json({
            success: true,
            message: "System SMS config retrieved",
            data: serializeSystemSmsConfig(row),
        });
    } catch (error) {
        console.error("ADMIN SMS SYSTEM CONFIG GET ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error?.message || "Failed to load config",
        });
    }
});

/** PUT /admin/sms-system/config */
router.put("/config", authAdmin, async (req, res) => {
    try {
        const data = await upsertSystemSmsConfig(req.body || {}, actor(req));
        return res.status(200).json({
            success: true,
            message: "System SMS config saved",
            data,
        });
    } catch (error) {
        console.error("ADMIN SMS SYSTEM CONFIG PUT ERROR:", error);
        return res.status(statusFromError(error)).json({
            success: false,
            message: error?.message || "Failed to save config",
        });
    }
});

/** GET /admin/sms-system/templates */
router.get("/templates", authAdmin, async (req, res) => {
    try {
        const result = await listAdminSystemTemplates({
            type: req.query.type,
            search: req.query.search,
            status: req.query.status,
            page_no: req.query.page_no,
            limit: req.query.limit,
        });
        return res.status(200).json({
            success: true,
            message: "System SMS templates retrieved",
            data: result.data,
            pagination: result.pagination,
        });
    } catch (error) {
        console.error("ADMIN SMS SYSTEM TEMPLATES LIST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error?.message || "Failed to list templates",
        });
    }
});

/** GET /admin/sms-system/templates/:template_id */
router.get("/templates/:template_id", authAdmin, async (req, res) => {
    try {
        const data = await getSystemTemplateById(req.params.template_id);
        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Template not found",
            });
        }
        return res.status(200).json({
            success: true,
            message: "Template retrieved",
            data,
        });
    } catch (error) {
        console.error("ADMIN SMS SYSTEM TEMPLATE GET ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error?.message || "Failed to get template",
        });
    }
});

/** POST /admin/sms-system/templates */
router.post("/templates", authAdmin, async (req, res) => {
    try {
        const data = await createSystemTemplate(req.body || {}, actor(req));
        return res.status(201).json({
            success: true,
            message: "Template created",
            data,
        });
    } catch (error) {
        console.error("ADMIN SMS SYSTEM TEMPLATE CREATE ERROR:", error);
        return res.status(statusFromError(error)).json({
            success: false,
            message: error?.message || "Failed to create template",
        });
    }
});

/** PUT /admin/sms-system/templates/:template_id */
router.put("/templates/:template_id", authAdmin, async (req, res) => {
    try {
        const data = await updateSystemTemplate(
            req.params.template_id,
            req.body || {},
            actor(req)
        );
        return res.status(200).json({
            success: true,
            message: "Template updated",
            data,
        });
    } catch (error) {
        console.error("ADMIN SMS SYSTEM TEMPLATE UPDATE ERROR:", error);
        return res.status(statusFromError(error)).json({
            success: false,
            message: error?.message || "Failed to update template",
        });
    }
});

/** PUT /admin/sms-system/templates/:template_id/status */
router.put("/templates/:template_id/status", authAdmin, async (req, res) => {
    try {
        const data = await setSystemTemplateStatus(
            req.params.template_id,
            req.body?.status,
            actor(req)
        );
        return res.status(200).json({
            success: true,
            message: "Template status updated",
            data,
        });
    } catch (error) {
        console.error("ADMIN SMS SYSTEM TEMPLATE STATUS ERROR:", error);
        return res.status(statusFromError(error)).json({
            success: false,
            message: error?.message || "Failed to update status",
        });
    }
});

/** DELETE /admin/sms-system/templates/:template_id */
router.delete("/templates/:template_id", authAdmin, async (req, res) => {
    try {
        const data = await deleteSystemTemplate(req.params.template_id);
        return res.status(200).json({
            success: true,
            message: "Template deleted",
            data,
        });
    } catch (error) {
        console.error("ADMIN SMS SYSTEM TEMPLATE DELETE ERROR:", error);
        return res.status(statusFromError(error)).json({
            success: false,
            message: error?.message || "Failed to delete template",
        });
    }
});

export default router;
