import express from "express";
import { authAdmin } from "../middleware/authAdmin.js";
import {
    deleteWebsiteLegalPage,
    getWebsiteLegalPageById,
    listWebsiteLegalPages,
    serializeWebsiteLegalPage,
    upsertWebsiteLegalPage,
} from "../helpers/websiteLegalPages.js";

const router = express.Router();

function actor(req) {
    return String(req.headers["username"] || "").trim() || null;
}

/** GET /admin/website-legal/pages */
router.get("/pages", authAdmin, async (_req, res) => {
    try {
        const rows = await listWebsiteLegalPages({ activeOnly: false });
        return res.status(200).json({
            success: true,
            message: "Website legal pages retrieved",
            data: rows.map((row) => serializeWebsiteLegalPage(row)),
        });
    } catch (error) {
        console.error("ADMIN WEBSITE LEGAL LIST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error?.message || "Failed to load legal pages",
        });
    }
});

/** GET /admin/website-legal/pages/:pageId */
router.get("/pages/:pageId", authAdmin, async (req, res) => {
    try {
        const row = await getWebsiteLegalPageById(req.params.pageId);
        if (!row) {
            return res.status(404).json({
                success: false,
                message: "Legal page not found",
            });
        }
        return res.status(200).json({
            success: true,
            message: "Website legal page retrieved",
            data: serializeWebsiteLegalPage(row),
        });
    } catch (error) {
        console.error("ADMIN WEBSITE LEGAL GET ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error?.message || "Failed to load legal page",
        });
    }
});

/** PUT /admin/website-legal/pages — create or update by page_id/slug */
router.put("/pages", authAdmin, async (req, res) => {
    try {
        const data = await upsertWebsiteLegalPage(req.body || {}, actor(req));
        return res.status(200).json({
            success: true,
            message: "Website legal page saved",
            data,
        });
    } catch (error) {
        console.error("ADMIN WEBSITE LEGAL PUT ERROR:", error);
        const status = error?.status || 500;
        return res.status(status).json({
            success: false,
            message: error?.message || "Failed to save legal page",
        });
    }
});

/** DELETE /admin/website-legal/pages/:pageId */
router.delete("/pages/:pageId", authAdmin, async (req, res) => {
    try {
        await deleteWebsiteLegalPage(req.params.pageId);
        return res.status(200).json({
            success: true,
            message: "Website legal page deleted",
        });
    } catch (error) {
        console.error("ADMIN WEBSITE LEGAL DELETE ERROR:", error);
        const status = error?.status || 500;
        return res.status(status).json({
            success: false,
            message: error?.message || "Failed to delete legal page",
        });
    }
});

export default router;
