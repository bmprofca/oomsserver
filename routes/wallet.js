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

router.post("/create-checkout", auth, validateBranch, async (req, res) => {
    try {
        const { amount, purpose, details } = req.body || {};
        const username = req.headers["username"] || req.headers["Username"] || "";
        const branchId = req.branch_id;
        const amountRupees = Number(amount);

        if (!amountRupees || Number.isNaN(amountRupees) || amountRupees < 1) {
            return res.status(400).json({
                success: false,
                message: "Amount must be at least ₹1",
            });
        }

        const amountPaise = Math.round(amountRupees * 100);
        const rechargePurpose = purpose || "Wallet Recharge";
        const rechargeDetails = details || "Wallet top-up via Razorpay";

        const { orderId, keyId } = await createRazorpayOrder({
            amountPaise,
            receipt: `wallet${branchId}${Date.now()}`,
            notes: {
                orderType: "wallet",
                branchId,
                username,
                purpose: rechargePurpose,
                details: rechargeDetails,
            },
        });

        await pool.query(
            `INSERT INTO razorpay_orders
                (razorpay_order_id, username, branch_id, plan_name, billing_cycle, order_type, purpose, details, amount, status)
             VALUES (?, ?, ?, 'WalletTopup', 'one_time', 'wallet', ?, ?, ?, 'pending')`,
            [orderId, username, branchId, rechargePurpose, rechargeDetails, amountPaise]
        );

        return res.json({
            success: true,
            message: "Wallet checkout initialized",
            data: {
                key: keyId,
                amount: amountPaise,
                currency: "INR",
                order_id: orderId,
                name: "OOMS CRM",
                description: `Wallet recharge ₹${amountRupees.toFixed(2)}`,
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

        if (!verifyRazorpayPaymentSignature({
            orderId: razorpay_order_id,
            paymentId: razorpay_payment_id,
            signature: razorpay_signature,
        })) {
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
        const { amount, purpose, details } = req.body || {};

        if (!amount || Number(amount) <= 0) {
            return res.status(400).json({
                success: false,
                message: "Amount must be a positive number",
            });
        }

        const data = await creditWallet({
            branch_id: req.branch_id,
            amount,
            purpose: purpose || "Add Money",
            details,
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
