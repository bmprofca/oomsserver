import express from "express";
import pool from "../db.js";
import { authAdmin } from "../middleware/authAdmin.js";
import { creditWallet } from "../services/walletService.js";
import {
    getGatewayFeeSettings,
    updateGatewayFeeSettings,
    listPaymentBanks,
    upsertPaymentBank,
    deletePaymentBank,
    listPaymentRequests,
    reviewPaymentRequest,
} from "../helpers/walletPaymentConfig.js";

const router = express.Router();

function actor(req) {
    return String(req.headers["username"] || "").trim() || null;
}

/** GET /admin/wallet/gateway-fee */
router.get("/gateway-fee", authAdmin, async (_req, res) => {
    try {
        const data = await getGatewayFeeSettings();
        return res.status(200).json({
            success: true,
            message: "Gateway fee settings retrieved",
            data,
        });
    } catch (error) {
        console.error("ADMIN WALLET GATEWAY FEE GET ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error?.message || "Failed to load gateway fee",
        });
    }
});

/** PUT /admin/wallet/gateway-fee */
router.put("/gateway-fee", authAdmin, async (req, res) => {
    try {
        const data = await updateGatewayFeeSettings(req.body || {}, actor(req));
        return res.status(200).json({
            success: true,
            message: "Gateway fee settings saved",
            data,
        });
    } catch (error) {
        console.error("ADMIN WALLET GATEWAY FEE PUT ERROR:", error);
        const status = error?.status || 500;
        return res.status(status).json({
            success: false,
            message: error?.message || "Failed to save gateway fee",
        });
    }
});

/** GET /admin/wallet/banks */
router.get("/banks", authAdmin, async (_req, res) => {
    try {
        const data = await listPaymentBanks({ activeOnly: false });
        return res.status(200).json({
            success: true,
            message: "Payment banks retrieved",
            data,
        });
    } catch (error) {
        console.error("ADMIN WALLET BANKS GET ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error?.message || "Failed to load banks",
        });
    }
});

/** POST /admin/wallet/banks */
router.post("/banks", authAdmin, async (req, res) => {
    try {
        const data = await upsertPaymentBank(req.body || {}, actor(req));
        return res.status(200).json({
            success: true,
            message: "Bank account saved",
            data,
        });
    } catch (error) {
        console.error("ADMIN WALLET BANKS POST ERROR:", error);
        const status = error?.status || 500;
        return res.status(status).json({
            success: false,
            message: error?.message || "Failed to save bank",
        });
    }
});

/** PUT /admin/wallet/banks/:bank_id */
router.put("/banks/:bank_id", authAdmin, async (req, res) => {
    try {
        const data = await upsertPaymentBank(
            { ...(req.body || {}), bank_id: req.params.bank_id },
            actor(req)
        );
        return res.status(200).json({
            success: true,
            message: "Bank account updated",
            data,
        });
    } catch (error) {
        console.error("ADMIN WALLET BANKS PUT ERROR:", error);
        const status = error?.status || 500;
        return res.status(status).json({
            success: false,
            message: error?.message || "Failed to update bank",
        });
    }
});

/** DELETE /admin/wallet/banks/:bank_id */
router.delete("/banks/:bank_id", authAdmin, async (req, res) => {
    try {
        const data = await deletePaymentBank(req.params.bank_id);
        return res.status(200).json({
            success: true,
            message: "Bank account deleted",
            data,
        });
    } catch (error) {
        console.error("ADMIN WALLET BANKS DELETE ERROR:", error);
        const status = error?.status || 500;
        return res.status(status).json({
            success: false,
            message: error?.message || "Failed to delete bank",
        });
    }
});

/** GET /admin/wallet/payment-requests */
router.get("/payment-requests", authAdmin, async (req, res) => {
    try {
        const { status = "all", page_no = 1, limit = 20 } = req.query || {};
        const result = await listPaymentRequests({
            status,
            page_no,
            limit,
        });
        return res.status(200).json({
            success: true,
            message: "Payment requests retrieved",
            data: result.data,
            pagination: result.pagination,
        });
    } catch (error) {
        console.error("ADMIN WALLET PAYMENT REQUESTS GET ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error?.message || "Failed to load payment requests",
        });
    }
});

/** POST /admin/wallet/payment-requests/:request_id/review */
router.post("/payment-requests/:request_id/review", authAdmin, async (req, res) => {
    try {
        const { action, admin_remark } = req.body || {};
        const reviewed = await reviewPaymentRequest({
            requestId: req.params.request_id,
            action,
            adminRemark: admin_remark,
            actor: actor(req),
        });

        if (reviewed.shouldCredit) {
            try {
                await creditWallet({
                    branch_id: reviewed.branch_id,
                    amount: reviewed.amount,
                    remark: reviewed.remark || "Payment request approved",
                    details: `Manual payment request ${reviewed.request_id} approved by ${actor(req) || "admin"}`,
                });
            } catch (creditError) {
                // Revert approval so admin can retry
                await pool.query(
                    `UPDATE wallet_payment_requests
                     SET status = 'pending', reviewed_by = NULL, reviewed_at = NULL, admin_remark = ?
                     WHERE request_id = ?`,
                    [
                        `Credit failed: ${creditError?.message || "unknown"}`,
                        reviewed.request_id,
                    ]
                );
                throw creditError;
            }
        }

        return res.status(200).json({
            success: true,
            message:
                reviewed.shouldCredit
                    ? "Payment request approved and wallet credited"
                    : "Payment request rejected",
            data: reviewed.request,
        });
    } catch (error) {
        console.error("ADMIN WALLET PAYMENT REQUEST REVIEW ERROR:", error);
        const status = error?.status || 500;
        return res.status(status).json({
            success: false,
            message: error?.message || "Failed to review payment request",
        });
    }
});

export default router;
