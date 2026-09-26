import express from "express";
import {
    getWebsiteLegalPageBySlug,
    listWebsiteLegalPages,
    serializeWebsiteLegalListItem,
    serializeWebsiteLegalPage,
} from "../helpers/websiteLegalPages.js";

const router = express.Router();

/** GET /public/legal — active legal pages (for footer/nav). */
router.get("/legal", async (_req, res) => {
    try {
        const rows = await listWebsiteLegalPages({ activeOnly: true });
        return res.status(200).json({
            success: true,
            message: "Legal pages retrieved successfully",
            data: rows.map(serializeWebsiteLegalListItem),
        });
    } catch (error) {
        console.error("PUBLIC LEGAL LIST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch legal pages",
            error: error.message,
        });
    }
});

/** GET /public/legal/:slug — active legal page content. */
router.get("/legal/:slug", async (req, res) => {
    try {
        const row = await getWebsiteLegalPageBySlug(req.params.slug, {
            activeOnly: true,
        });
        if (!row) {
            return res.status(404).json({
                success: false,
                message: "Legal page not found",
            });
        }
        return res.status(200).json({
            success: true,
            message: "Legal page retrieved successfully",
            data: serializeWebsiteLegalPage(row),
        });
    } catch (error) {
        console.error("PUBLIC LEGAL GET ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch legal page",
            error: error.message,
        });
    }
});

export default router;
