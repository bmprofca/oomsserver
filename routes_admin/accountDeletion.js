import express from "express";
import { authAdmin } from "../middleware/authAdmin.js";
import {
    isDeletionStatus,
    listAccountDeletionRequests,
    updateAccountDeletionRequest,
} from "../helpers/accountDeletionRequests.js";

const router = express.Router();

/** GET /admin/account-deletion */
router.get("/", authAdmin, async (req, res) => {
    try {
        const result = await listAccountDeletionRequests({
            status: req.query.status,
            search: req.query.search,
            page_no: req.query.page_no,
            limit: req.query.limit,
        });
        return res.status(200).json({
            success: true,
            message: "Account deletion requests retrieved",
            ...result,
        });
    } catch (error) {
        console.error("ADMIN ACCOUNT DELETION LIST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to load account deletion requests",
        });
    }
});

/** PUT /admin/account-deletion/:requestId */
router.put("/:requestId", authAdmin, async (req, res) => {
    try {
        const status = String(req.body?.status || "").trim().toLowerCase();
        const admin_remark = typeof req.body?.admin_remark === "string"
            ? req.body.admin_remark.trim().slice(0, 2000)
            : "";

        if (!isDeletionStatus(status)) {
            return res.status(400).json({
                success: false,
                message: "Status must be pending, in_review, completed, or rejected.",
            });
        }

        const reviewed_by = String(
            req.headers.username || req.headers.Username || ""
        ).trim();

        const row = await updateAccountDeletionRequest(req.params.requestId, {
            status,
            admin_remark,
            reviewed_by,
        });

        if (!row) {
            return res.status(404).json({
                success: false,
                message: "Request not found",
            });
        }

        return res.status(200).json({
            success: true,
            message: "Request updated",
            data: row,
        });
    } catch (error) {
        console.error("ADMIN ACCOUNT DELETION UPDATE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update the request",
        });
    }
});

export default router;
