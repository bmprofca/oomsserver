import express from "express";
import { auth } from "../middleware/auth.js";
import {
    getHelpSupportConfigRow,
    serializeHelpSupportConfig,
} from "../helpers/helpSupportConfig.js";
import { listFaqs } from "../helpers/helpSupportFaqs.js";

const router = express.Router();

/** GET /help-support — active platform help & support details + FAQs for CLIENT */
router.get("/", auth, async (_req, res) => {
    try {
        const row = await getHelpSupportConfigRow();
        const data = serializeHelpSupportConfig(row);
        const faqs = await listFaqs({ activeOnly: true });

        if (data.status === "inactive") {
            return res.status(200).json({
                success: true,
                message: "Help & Support is currently unavailable",
                data: {
                    ...data,
                    configured: false,
                    support_email: "",
                    support_phone: "",
                    support_whatsapp: "",
                    support_hours: "",
                    support_address: "",
                    website_url: "",
                    intro_text:
                        data.intro_text ||
                        "Support details are not available right now. Please try again later.",
                    faqs,
                },
            });
        }

        return res.status(200).json({
            success: true,
            message: "Help & Support details retrieved",
            data: {
                ...data,
                faqs,
            },
        });
    } catch (error) {
        console.error("HELP SUPPORT GET ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error?.message || "Failed to load help & support",
        });
    }
});

export default router;
