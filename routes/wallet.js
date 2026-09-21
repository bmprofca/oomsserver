import express from "express";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import {
    createRazorpayOrder,
    verifyRazorpayPaymentSignature,
} from "../services/razorpayService.js";
import { fulfillRazorpayOrder } from "../services/razorpayWebhookService.js";
import {
    getOrCreateWallet,
    creditWallet,
    getTransactions,
} from "../services/walletService.js";
import { generateWalletTransactionInvoice } from "../services/walletInvoiceService.js";
import {
    getGatewayFeeSettings,
    computeGatewayFee,
    listPaymentBanks,
    createPaymentRequest,
    listPaymentRequests,
} from "../helpers/walletPaymentConfig.js";

const router = express.Router();

router.get("/balance", auth, validateBranch, async (req, res) => {
    try {
        const data = await getOrCreateWallet(req.branch_id);
        return res.json({
            success: true,
            message: "Wallet balance fetched successfully",
            data,
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error?.message || "Request failed",
        });
    }
});

router.get("/transactions", auth, validateBranch, async (req, res) => {
    try {
        const { page_no = 1, limit = 10 } = req.query;
        const result = await getTransactions({
            branch_id: req.branch_id,
            page_no,
            limit,
        });

        return res.json({
            success: true,
            message: "Transaction history fetched successfully",
            data: result.data,
            pagination: result.pagination,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error?.message || "Request failed",
        });
    }
});

router.get("/transactions/:transaction_id/invoice", auth, validateBranch, async (req, res) => {
    try {
        const { transaction_id } = req.params;
        if (!transaction_id) {
            return res.status(400).json({
                success: false,
                message: "Transaction ID is required",
            });
        }

        const data = await generateWalletTransactionInvoice({
            branchId: req.branch_id,
            transactionId: transaction_id,
        });

        return res.json({
            success: true,
            message: "Wallet invoice generated successfully",
            data,
        });
    } catch (error) {
        console.error("Wallet invoice generation error:", error);
        return res.status(error.statusCode || 500).json({
            success: false,
            message: error?.message || "Failed to generate wallet invoice",
        });
    }
});

/** GET /wallet/gateway-fee — public fee preview for Razorpay top-ups */
router.get("/gateway-fee", auth, validateBranch, async (req, res) => {
    try {
        const settings = await getGatewayFeeSettings();
        const amount = Number(req.query?.amount);
        const breakdown =
            Number.isFinite(amount) && amount > 0
                ? computeGatewayFee(amount, settings)
                : null;
        return res.json({
            success: true,
            message: "Gateway fee settings",
            data: {
                ...settings,
                breakdown,
            },
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error?.message || "Failed to load gateway fee",
        });
    }
});

router.post("/create-checkout", auth, validateBranch, async (req, res) => {
    try {
        const { amount, remark, details } = req.body || {};
        const username = req.headers["username"] || req.headers["Username"] || "";
        const branchId = req.branch_id;
        const amountRupees = Number(amount);

        if (!amountRupees || Number.isNaN(amountRupees) || amountRupees < 1) {
            return res.status(400).json({
                success: false,
                message: "Amount must be at least ₹1",
            });
        }

        const feeSettings = await getGatewayFeeSettings();
        const fee = computeGatewayFee(amountRupees, feeSettings);
        const creditPaise = Math.round(fee.net_amount * 100);
        const feePaise = Math.round(fee.gateway_fee * 100);
        const chargePaise = Math.round(fee.total_amount * 100);
        const rechargeRemark =
            String(remark || details || "Wallet Recharge").trim() || "Wallet Recharge";

        const orderDetails =
            fee.gateway_fee > 0
                ? `${rechargeRemark} · net ₹${fee.net_amount.toFixed(2)} + fee ₹${fee.gateway_fee.toFixed(2)}`
                : rechargeRemark;

        const { orderId, keyId } = await createRazorpayOrder({
            amountPaise: chargePaise,
            receipt: `wallet${branchId}${Date.now()}`,
            notes: {
                orderType: "wallet",
                branchId,
                username,
                remark: rechargeRemark,
                netAmount: String(fee.net_amount),
                gatewayFee: String(fee.gateway_fee),
            },
        });

        try {
            await pool.query(
                `INSERT INTO razorpay_orders
                    (razorpay_order_id, username, branch_id, plan_name, billing_cycle, order_type, remark, details, amount, credit_amount, gateway_fee, status)
                 VALUES (?, ?, ?, 'WalletTopup', 'one_time', 'wallet', ?, ?, ?, ?, ?, 'pending')`,
                [
                    orderId,
                    username,
                    branchId,
                    rechargeRemark,
                    orderDetails,
                    chargePaise,
                    creditPaise,
                    feePaise,
                ]
            );
        } catch (error) {
            if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
            await pool.query(
                `INSERT INTO razorpay_orders
                    (razorpay_order_id, username, branch_id, plan_name, billing_cycle, order_type, remark, details, amount, status)
                 VALUES (?, ?, ?, 'WalletTopup', 'one_time', 'wallet', ?, ?, ?, 'pending')`,
                [orderId, username, branchId, rechargeRemark, orderDetails, chargePaise]
            );
        }

        return res.json({
            success: true,
            message: "Wallet checkout initialized",
            data: {
                key: keyId,
                amount: chargePaise,
                currency: "INR",
                order_id: orderId,
                name: "OOMS CRM",
                description:
                    fee.gateway_fee > 0
                        ? `Wallet ₹${fee.net_amount.toFixed(2)} + fee ₹${fee.gateway_fee.toFixed(2)}`
                        : `Wallet recharge ₹${fee.net_amount.toFixed(2)}`,
                net_amount: fee.net_amount,
                gateway_fee: fee.gateway_fee,
                total_amount: fee.total_amount,
                gateway_fee_percent: fee.gateway_fee_percent,
                gateway_fee_flat: fee.gateway_fee_flat,
            },
        });
    } catch (error) {
        console.error("Wallet create checkout error:", error);
        return res.status(error.statusCode || 500).json({
            success: false,
            message: error?.message || "Failed to initialize wallet checkout",
        });
    }
});

/** GET /wallet/payment-banks — active bank accounts for manual transfer */
router.get("/payment-banks", auth, validateBranch, async (_req, res) => {
    try {
        const data = await listPaymentBanks({ activeOnly: true });
        return res.json({
            success: true,
            message: "Payment banks fetched",
            data,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error?.message || "Failed to load payment banks",
        });
    }
});

/** GET /wallet/payment-requests — current branch requests */
router.get("/payment-requests", auth, validateBranch, async (req, res) => {
    try {
        const { status = "all", page_no = 1, limit = 10 } = req.query || {};
        const result = await listPaymentRequests({
            branchId: req.branch_id,
            status,
            page_no,
            limit,
        });
        return res.json({
            success: true,
            message: "Payment requests fetched",
            data: result.data,
            pagination: result.pagination,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error?.message || "Failed to load payment requests",
        });
    }
});

/** POST /wallet/payment-requests — submit manual transfer request (no gateway fee) */
router.post("/payment-requests", auth, validateBranch, async (req, res) => {
    try {
        const username =
            req.headers["username"] || req.headers["Username"] || "";
        const { amount, remark, bank_id, transfer_ref, transfer_date } =
            req.body || {};

        const data = await createPaymentRequest({
            branchId: req.branch_id,
            username,
            amount,
            remark,
            bankId: bank_id,
            transferRef: transfer_ref,
            transferDate: transfer_date,
        });

        return res.json({
            success: true,
            message: "Payment request submitted. Awaiting admin approval.",
            data,
        });
    } catch (error) {
        const status = error?.status || 500;
        return res.status(status).json({
            success: false,
            message: error?.message || "Failed to submit payment request",
        });
    }
});

router.post("/verify-payment", auth, validateBranch, async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
        const branchId = req.branch_id;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({
                success: false,
                message: "Missing payment verification parameters.",
            });
        }

        if (!(await verifyRazorpayPaymentSignature({
            orderId: razorpay_order_id,
            paymentId: razorpay_payment_id,
            signature: razorpay_signature,
        }))) {
            return res.status(400).json({
                success: false,
                message: "Payment signature verification failed.",
            });
        }

        const result = await fulfillRazorpayOrder({
            orderId: razorpay_order_id,
            paymentId: razorpay_payment_id,
            source: "verify",
        });

        if (!result.fulfilled && result.reason !== "already_paid") {
            return res.status(404).json({
                success: false,
                message: "Payment order not found or could not be fulfilled.",
            });
        }

        const wallet = await getOrCreateWallet(branchId);

        return res.json({
            success: true,
            message:
                result.reason === "already_paid"
                    ? "Wallet already credited for this payment."
                    : "Wallet recharged successfully",
            data: {
                branch_id: branchId,
                balance: wallet.balance,
                order_id: razorpay_order_id,
                payment_id: razorpay_payment_id,
            },
        });
    } catch (error) {
        console.error("Wallet verify payment error:", error);
        return res.status(500).json({
            success: false,
            message: error?.message || "Failed to verify wallet payment",
        });
    }
});

router.post("/add-money", auth, validateBranch, async (req, res) => {
    try {
        const { amount, remark, details } = req.body || {};

        if (!amount || Number(amount) <= 0) {
            return res.status(400).json({
                success: false,
                message: "Amount must be a positive number",
            });
        }

        const data = await creditWallet({
            branch_id: req.branch_id,
            amount,
            remark: remark || details || "Add Money",
            details: details || null,
        });

        return res.json({
            success: true,
            message: "Money added to wallet successfully",
            data,
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error?.message || "Request failed",
        });
    }
});

export default router;
