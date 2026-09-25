import express from "express";
import {
    getWebsiteContactConfigRow,
    serializeWebsiteContactPublic,
} from "../helpers/websiteContactConfig.js";

const router = express.Router();

/** GET /public/contact — website contact details (no auth). */
router.get("/contact", async (_req, res) => {
    try {
        const row = await getWebsiteContactConfigRow();
        const useRow = row && row.status === "active" ? row : null;
        const data = serializeWebsiteContactPublic(useRow);

        return res.status(200).json({
            success: true,
            message: "Contact details retrieved successfully",
            data,
        });
    } catch (error) {
        console.error("PUBLIC CONTACT GET ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch contact details",
            error: error.message,
        });
    }
});

export default router;
