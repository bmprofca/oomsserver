import express from "express";
import { authAdmin } from "../middleware/authAdmin.js";
import {
    getHelpSupportConfigRow,
    serializeHelpSupportConfig,
    upsertHelpSupportConfig,
} from "../helpers/helpSupportConfig.js";
import {
    listFaqs,
    createFaq,
    updateFaq,
    deleteFaq,
} from "../helpers/helpSupportFaqs.js";

const router = express.Router();

function actor(req) {
    return String(req.headers["username"] || "").trim() || null;
}

/** GET /admin/help-support/config */
router.get("/config", authAdmin, async (_req, res) => {
    try {
        const row = await getHelpSupportConfigRow();
        return res.status(200).json({
            success: true,
            message: "Help & Support config retrieved",
            data: serializeHelpSupportConfig(row),
        });
    } catch (error) {
        console.error("ADMIN HELP SUPPORT CONFIG GET ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error?.message || "Failed to load config",
        });
    }
});

/** PUT /admin/help-support/config */
router.put("/config", authAdmin, async (req, res) => {
    try {
        const data = await upsertHelpSupportConfig(req.body || {}, actor(req));
        return res.status(200).json({
            success: true,
            message: "Help & Support config saved",
            data,
        });
    } catch (error) {
        console.error("ADMIN HELP SUPPORT CONFIG PUT ERROR:", error);
        const status = error?.status || 500;
        return res.status(status).json({
            success: false,
            message: error?.message || "Failed to save config",
        });
    }
});

/** GET /admin/help-support/faqs */
router.get("/faqs", authAdmin, async (_req, res) => {
    try {
        const data = await listFaqs({ activeOnly: false });
        return res.status(200).json({
            success: true,
            message: "FAQs retrieved",
            data,
        });
    } catch (error) {
        console.error("ADMIN HELP SUPPORT FAQS GET ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error?.message || "Failed to load FAQs",
        });
    }
});

/** POST /admin/help-support/faqs */
router.post("/faqs", authAdmin, async (req, res) => {
    try {
        const data = await createFaq(req.body || {}, actor(req));
        return res.status(201).json({
            success: true,
            message: "FAQ created",
            data,
        });
    } catch (error) {
        console.error("ADMIN HELP SUPPORT FAQ CREATE ERROR:", error);
        const status = error?.status || 500;
        return res.status(status).json({
            success: false,
            message: error?.message || "Failed to create FAQ",
        });
    }
});

/** PUT /admin/help-support/faqs/:faqId */
router.put("/faqs/:faqId", authAdmin, async (req, res) => {
    try {
        const data = await updateFaq(req.params.faqId, req.body || {}, actor(req));
        return res.status(200).json({
            success: true,
            message: "FAQ updated",
            data,
        });
    } catch (error) {
        console.error("ADMIN HELP SUPPORT FAQ UPDATE ERROR:", error);
        const status = error?.status || 500;
        return res.status(status).json({
            success: false,
            message: error?.message || "Failed to update FAQ",
        });
    }
});

/** DELETE /admin/help-support/faqs/:faqId */
router.delete("/faqs/:faqId", authAdmin, async (req, res) => {
    try {
        await deleteFaq(req.params.faqId);
        return res.status(200).json({
            success: true,
            message: "FAQ deleted",
        });
    } catch (error) {
        console.error("ADMIN HELP SUPPORT FAQ DELETE ERROR:", error);
        const status = error?.status || 500;
        return res.status(status).json({
            success: false,
            message: error?.message || "Failed to delete FAQ",
        });
    }
});

export default router;
