import express from "express";
import path from "path";
import multer from "multer";
import { authAdmin } from "../middleware/authAdmin.js";
import { RANDOM_STRING } from "../helpers/function.js";
import {
    uploadProfileDocumentBuffer,
    getProfileDocumentAccessUrl,
} from "../helpers/b2Storage.js";
import {
    listAdminTemplates,
    getAdminTemplate,
    createSystemTemplate,
    updateSystemTemplate,
    setSystemTemplateStatus,
    deleteSystemTemplate,
    listCanonicalTypes,
    seedSystemTemplatesFromFile,
    importSystemTemplateFromOneChatting,
    countBodyPlaceholders,
} from "../services/wpSystemTemplateService.js";
import { listOneChattingProjectTemplates } from "../services/wpSystemWhatsappSendService.js";
import { TEMPLATELIST } from "../utils/WhatsAppTemplates.js";

const router = express.Router();

const MEDIA_HEADER_FORMATS = new Set(["IMAGE", "VIDEO", "DOCUMENT"]);
const WP_SYSTEM_HEADER_CATEGORY = "wp_system_header";

const HEADER_MIME_TO_EXT = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "text/plain": "txt",
};

const headerUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter(_req, file, cb) {
        const mime = String(file.mimetype || "").toLowerCase();
        const allowed =
            mime.startsWith("image/") ||
            mime.startsWith("video/") ||
            mime === "application/pdf" ||
            mime.includes("document") ||
            mime.includes("msword") ||
            mime.includes("sheet") ||
            mime.includes("excel") ||
            mime === "application/zip" ||
            mime === "text/plain";
        if (!allowed) {
            cb(new Error("Unsupported header media type"));
            return;
        }
        cb(null, true);
    },
});

function actor(req) {
    return String(req.headers["username"] || "").trim() || null;
}

function statusFromError(error) {
    const message = error?.message || "Request failed";
    if (
        message.includes("required") ||
        message.includes("must be") ||
        message.includes("Invalid") ||
        message.includes("already exists") ||
        message.includes("map exactly") ||
        message.includes("not configured") ||
        message.includes("Unsupported")
    ) {
        return 400;
    }
    if (message.includes("not found") || message.includes("Not found")) {
        return 404;
    }
    return 500;
}

function resolveHeaderFilename(file) {
    const originalExt = path
        .extname(file?.originalname || "")
        .toLowerCase()
        .replace(/^\./, "");
    const mime = String(file?.mimetype || "").toLowerCase();
    const ext = originalExt || HEADER_MIME_TO_EXT[mime] || "bin";
    return `${RANDOM_STRING(30)}.${ext}`;
}

function summarizeOneChattingTemplate(item) {
    const components = Array.isArray(item?.template?.components)
        ? item.template.components
        : [];
    const body = components.find((c) => c?.type === "BODY");
    const header = components.find((c) => c?.type === "HEADER");
    const headerFormat = header?.format
        ? String(header.format).trim().toUpperCase()
        : null;
    const headerHandle = header?.example?.header_handle?.[0] || null;
    const samples = Array.isArray(body?.example?.body_text?.[0])
        ? body.example.body_text[0]
        : [];

    return {
        template_id: item.template_id,
        template_name: item.template_name,
        category: item.category || item.template?.category || null,
        language: item.language_code || item.template?.language || "en",
        status: item.status || null,
        body_text: body?.text || "",
        placeholder_count: countBodyPlaceholders(body?.text),
        sample_values: samples,
        header_format: headerFormat,
        header_media: headerHandle,
        header_image: headerHandle,
        has_media_header: MEDIA_HEADER_FORMATS.has(headerFormat || ""),
        template: item.template || null,
        create_date: item.create_date || null,
    };
}

/** GET /admin/wp-system-templates/types */
router.get("/types", authAdmin, async (_req, res) => {
    try {
        return res.status(200).json({
            success: true,
            message: "System template types retrieved",
            data: TEMPLATELIST.map((item) => ({
                name: item.name,
                description: item.description,
                available_variables: item.available_variables || [],
            })),
        });
    } catch (error) {
        console.error("ADMIN WP SYSTEM TEMPLATE TYPES ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch template types",
        });
    }
});

/**
 * GET /admin/wp-system-templates/onechatting-list
 * Proxies OneChatting project template-list (same PROJECT token as OOMS System send).
 */
router.get("/onechatting-list", authAdmin, async (req, res) => {
    try {
        const status =
            req.query.status != null && String(req.query.status).trim() !== ""
                ? String(req.query.status).trim()
                : "APPROVED";
        const category =
            req.query.category != null ? String(req.query.category).trim() : "";
        const fetchAll =
            String(req.query.fetch_all || "").toLowerCase() === "true" ||
            req.query.fetch_all === "1";

        const result = await listOneChattingProjectTemplates({
            status,
            category,
            page_no: req.query.page_no,
            limit: req.query.limit || 100,
            fetch_all: fetchAll,
        });

        const search = req.query.search
            ? String(req.query.search).trim().toLowerCase()
            : "";
        let data = (result.data || []).map(summarizeOneChattingTemplate);
        if (search) {
            data = data.filter((item) =>
                [item.template_name, item.category, item.body_text, item.status]
                    .filter(Boolean)
                    .some((value) =>
                        String(value).toLowerCase().includes(search)
                    )
            );
        }

        return res.status(200).json({
            success: true,
            message: "OneChatting templates retrieved",
            data,
            count: data.length,
            meta: result.meta,
        });
    } catch (error) {
        console.error("ADMIN ONECHATTING TEMPLATE LIST ERROR:", error);
        const status =
            error?.code === "MISSING_PROJECT_TOKEN" ||
            error?.code === "MISSING_BASE_URL"
                ? 400
                : 500;
        return res.status(status).json({
            success: false,
            message:
                error?.response?.data?.message ||
                error?.message ||
                "Failed to fetch OneChatting templates",
        });
    }
});

/** GET /admin/wp-system-templates/list */
router.get("/list", authAdmin, async (req, res) => {
    try {
        const result = await listAdminTemplates({
            type: req.query.type,
            search: req.query.search,
            status: req.query.status,
            page_no: req.query.page_no,
            limit: req.query.limit,
        });
        return res.status(200).json({
            success: true,
            message: "OOMS system templates retrieved",
            data: result.data,
            pagination: result.pagination,
            types: listCanonicalTypes(),
        });
    } catch (error) {
        console.error("ADMIN WP SYSTEM TEMPLATE LIST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error?.message || "Failed to list system templates",
        });
    }
});

/**
 * POST /admin/wp-system-templates/upload-header
 * Upload custom header media to Backblaze B2 (IMAGE / VIDEO / DOCUMENT).
 */
router.post(
    "/upload-header",
    authAdmin,
    (req, res, next) => {
        headerUpload.single("file")(req, res, (err) => {
            if (err) {
                return res.status(400).json({
                    success: false,
                    message: err.message || "Upload failed",
                });
            }
            return next();
        });
    },
    async (req, res) => {
        try {
            if (!req.file?.buffer) {
                return res.status(400).json({
                    success: false,
                    message: "file is required",
                });
            }

            const mimeType =
                String(req.file.mimetype || "").trim() ||
                "application/octet-stream";
            const filename = resolveHeaderFilename(req.file);

            await uploadProfileDocumentBuffer(
                WP_SYSTEM_HEADER_CATEGORY,
                filename,
                req.file.buffer,
                mimeType
            );

            const url = await getProfileDocumentAccessUrl(
                WP_SYSTEM_HEADER_CATEGORY,
                filename
            );

            return res.status(201).json({
                success: true,
                message: "Header media uploaded",
                data: {
                    url,
                    filename,
                    category: WP_SYSTEM_HEADER_CATEGORY,
                    original_name: req.file.originalname || null,
                    mime_type: mimeType,
                    size: req.file.size || req.file.buffer.length || null,
                },
            });
        } catch (error) {
            console.error("ADMIN WP SYSTEM HEADER UPLOAD ERROR:", error);
            return res.status(500).json({
                success: false,
                message: error?.message || "Failed to upload header media",
            });
        }
    }
);

/**
 * POST /admin/wp-system-templates/import
 * Easy setup: pick OneChatting APPROVED template + map body vars → save to DB.
 * Body: { type, template_name OR onechatting_template_id, variable_keys[], status?, template_id?, header_media_url? }
 */
router.post("/import", authAdmin, async (req, res) => {
    try {
        const body = req.body || {};
        const type = body.type != null ? String(body.type).trim() : "";
        const templateName =
            body.template_name != null ? String(body.template_name).trim() : "";
        const onechattingId =
            body.onechatting_template_id != null
                ? String(body.onechatting_template_id).trim()
                : "";
        const variable_keys = Array.isArray(body.variable_keys)
            ? body.variable_keys
            : [];
        const header_media_url =
            body.header_media_url != null &&
            String(body.header_media_url).trim() !== ""
                ? String(body.header_media_url).trim()
                : null;

        if (!type) {
            return res.status(400).json({
                success: false,
                message: "type is required",
            });
        }
        if (!templateName && !onechattingId) {
            return res.status(400).json({
                success: false,
                message: "template_name or onechatting_template_id is required",
            });
        }

        const listed = await listOneChattingProjectTemplates({
            status: "APPROVED",
            fetch_all: true,
            limit: 100,
        });
        const match = (listed.data || []).find((item) => {
            if (onechattingId && String(item.template_id) === onechattingId) {
                return true;
            }
            if (
                templateName &&
                String(item.template_name || "").trim() === templateName
            ) {
                return true;
            }
            return false;
        });

        if (!match) {
            return res.status(404).json({
                success: false,
                message:
                    "APPROVED OneChatting template not found for the given name/id",
            });
        }

        const data = await importSystemTemplateFromOneChatting({
            type,
            oneChattingItem: match,
            variable_keys,
            status: body.status,
            template_id: body.template_id || null,
            header_media_url,
            username: actor(req),
        });

        return res.status(body.template_id ? 200 : 201).json({
            success: true,
            message: body.template_id
                ? "System template updated from OneChatting"
                : "System template imported from OneChatting",
            data,
        });
    } catch (error) {
        console.error("ADMIN WP SYSTEM TEMPLATE IMPORT ERROR:", error);
        return res.status(statusFromError(error)).json({
            success: false,
            message: error?.message || "Failed to import template",
        });
    }
});

/** GET /admin/wp-system-templates/:template_id */
router.get("/:template_id", authAdmin, async (req, res) => {
    try {
        const data = await getAdminTemplate(req.params.template_id);
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
        console.error("ADMIN WP SYSTEM TEMPLATE GET ERROR:", error);
        return res.status(statusFromError(error)).json({
            success: false,
            message: error?.message || "Failed to fetch template",
        });
    }
});

/** POST /admin/wp-system-templates/create */
router.post("/create", authAdmin, async (req, res) => {
    try {
        const body = req.body || {};
        const data = await createSystemTemplate({
            type: body.type,
            template_name: body.template_name,
            category: body.category,
            language: body.language,
            template: body.template,
            example: body.example,
            status: body.status,
            username: actor(req),
        });
        return res.status(201).json({
            success: true,
            message: "System template created",
            data,
        });
    } catch (error) {
        console.error("ADMIN WP SYSTEM TEMPLATE CREATE ERROR:", error);
        return res.status(statusFromError(error)).json({
            success: false,
            message: error?.message || "Failed to create template",
        });
    }
});

/** PUT /admin/wp-system-templates/edit */
router.put("/edit", authAdmin, async (req, res) => {
    try {
        const body = req.body || {};
        const data = await updateSystemTemplate({
            template_id: body.template_id,
            type: body.type,
            template_name: body.template_name,
            category: body.category,
            language: body.language,
            template: body.template,
            example: body.example,
            status: body.status,
            username: actor(req),
        });
        return res.status(200).json({
            success: true,
            message: "System template updated",
            data,
        });
    } catch (error) {
        console.error("ADMIN WP SYSTEM TEMPLATE EDIT ERROR:", error);
        return res.status(statusFromError(error)).json({
            success: false,
            message: error?.message || "Failed to update template",
        });
    }
});

/** PUT /admin/wp-system-templates/status */
router.put("/status", authAdmin, async (req, res) => {
    try {
        const body = req.body || {};
        const data = await setSystemTemplateStatus({
            template_id: body.template_id,
            status: body.status,
            username: actor(req),
        });
        return res.status(200).json({
            success: true,
            message: "Template status updated",
            data,
        });
    } catch (error) {
        console.error("ADMIN WP SYSTEM TEMPLATE STATUS ERROR:", error);
        return res.status(statusFromError(error)).json({
            success: false,
            message: error?.message || "Failed to update status",
        });
    }
});

/** DELETE /admin/wp-system-templates/delete */
router.delete("/delete", authAdmin, async (req, res) => {
    try {
        const template_id = req.body?.template_id || req.query?.template_id;
        const data = await deleteSystemTemplate({ template_id });
        return res.status(200).json({
            success: true,
            message: "System template deleted",
            data,
        });
    } catch (error) {
        console.error("ADMIN WP SYSTEM TEMPLATE DELETE ERROR:", error);
        return res.status(statusFromError(error)).json({
            success: false,
            message: error?.message || "Failed to delete template",
        });
    }
});

/** POST /admin/wp-system-templates/seed — re-run seed from helpers file (admin only) */
router.post("/seed", authAdmin, async (req, res) => {
    try {
        const force = Boolean(req.body?.force);
        const data = await seedSystemTemplatesFromFile({
            username: actor(req) || "admin",
            force,
        });
        return res.status(200).json({
            success: true,
            message: data.skipped
                ? "Templates already present; seed skipped"
                : "System templates seeded",
            data,
        });
    } catch (error) {
        console.error("ADMIN WP SYSTEM TEMPLATE SEED ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error?.message || "Failed to seed templates",
        });
    }
});

export default router;
