import express from "express";
import { createAccountDeletionRequest } from "../helpers/accountDeletionRequests.js";

const router = express.Router();

function trim(value) {
    return typeof value === "string" ? value.trim() : "";
}

function isEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** POST /public/account-deletion — public account deletion request (no auth). */
router.post("/account-deletion", async (req, res) => {
    try {
        const name = trim(req.body?.name);
        const email = trim(req.body?.email).toLowerCase();
        const mobile = trim(req.body?.mobile).replace(/\D/g, "").slice(-10);
        const username = trim(req.body?.username);
        const reason = trim(req.body?.reason);
        const confirmed = req.body?.confirm === true || req.body?.confirm === "true" || req.body?.confirm === 1;

        if (name.length < 2 || name.length > 150) {
            return res.status(400).json({
                success: false,
                message: "Please enter your full name.",
            });
        }
        if (!isEmail(email) || email.length > 190) {
            return res.status(400).json({
                success: false,
                message: "Please enter a valid email address.",
            });
        }
        if (mobile.length !== 10) {
            return res.status(400).json({
                success: false,
                message: "Please enter a valid 10-digit mobile number.",
            });
        }
        if (username.length > 100) {
            return res.status(400).json({
                success: false,
                message: "Username is too long.",
            });
        }
        if (reason.length > 2000) {
            return res.status(400).json({
                success: false,
                message: "Reason must be 2000 characters or fewer.",
            });
        }
        if (!confirmed) {
            return res.status(400).json({
                success: false,
                message: "Please confirm that you want this account deleted.",
            });
        }

        const row = await createAccountDeletionRequest({
            name,
            email,
            mobile,
            username,
            reason,
            create_ip: req.ip,
        });

        return res.status(201).json({
            success: true,
            message: "Your account deletion request has been submitted.",
            data: {
                request_id: row.request_id,
                status: row.status,
            },
        });
    } catch (error) {
        console.error("PUBLIC ACCOUNT DELETION POST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to submit the deletion request.",
        });
    }
});

export default router;
