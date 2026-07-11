import pool from "../db.js";
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

function sendSuccess(res, message, data = {}, extra = {}) {
    return res.json({ success: true, message, data, ...extra });
}

function sendError(res, error, code = 400) {
    return res.status(code).json({
        success: false,
        message: error?.message || "Request failed",
    });
}

const walletController = {
    async getBalance(req, res) {
        try {
            const data = await getOrCreateWallet(req.branch_id);
            return sendSuccess(res, "Wallet balance fetched successfully", data);
        } catch (error) {
            return sendError(res, error);
        }
    },

    async addMoney(req, res) {
        try {
            const { amount, purpose, details } = req.body || {};
            if (!amount || Number(amount) <= 0) {
                throw new Error("Amount must be a positive number");
            }
            const data = await creditWallet({
                branch_id: req.branch_id,
                amount,
                purpose: purpose || "Add Money",
                details,
            });
            return sendSuccess(res, "Money added to wallet successfully", data);
        } catch (error) {
            return sendError(res, error);
        }
    },

    async createCheckout(req, res) {
        try {
            const { amount, purpose, details } = req.body || {};
            const username = req.headers["username"] || req.headers["Username"] || "";
            const branchId = req.branch_id;
            const amountRupees = Number(amount);

            if (!amountRupees || Number.isNaN(amountRupees) || amountRupees < 1) {
                return sendError(res, new Error("Amount must be at least ₹1"), 400);
            }

            const amountPaise = Math.round(amountRupees * 100);
            const rechargePurpose = purpose || "Wallet Recharge";
            const rechargeDetails = details || "Wallet top-up via Razorpay";

            const { orderId, keyId } = await createRazorpayOrder({
                amountPaise,
                receipt: `wallet_${branchId}_${Date.now()}`,
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

            return sendSuccess(res, "Wallet checkout initialized", {
                key: keyId,
                amount: amountPaise,
                currency: "INR",
                order_id: orderId,
                name: "OOMS CRM",
                description: `Wallet recharge ₹${amountRupees.toFixed(2)}`,
            });
        } catch (error) {
            console.error("Wallet create checkout error:", error);
            return sendError(res, error, error.statusCode || 500);
        }
    },

    async verifyPayment(req, res) {
        try {
            const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
            const branchId = req.branch_id;

            if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
                return sendError(res, new Error("Missing payment verification parameters."), 400);
            }

            if (!verifyRazorpayPaymentSignature({
                orderId: razorpay_order_id,
                paymentId: razorpay_payment_id,
                signature: razorpay_signature,
            })) {
                return sendError(res, new Error("Payment signature verification failed."), 400);
            }

            const result = await fulfillRazorpayOrder({
                orderId: razorpay_order_id,
                paymentId: razorpay_payment_id,
                source: "verify",
            });

            if (!result.fulfilled && result.reason !== "already_paid") {
                return sendError(res, new Error("Payment order not found or could not be fulfilled."), 404);
            }

            const wallet = await getOrCreateWallet(branchId);
            return sendSuccess(
                res,
                result.reason === "already_paid"
                    ? "Wallet already credited for this payment."
                    : "Wallet recharged successfully",
                {
                branch_id: branchId,
                balance: wallet.balance,
                order_id: razorpay_order_id,
                payment_id: razorpay_payment_id,
            });
        } catch (error) {
            console.error("Wallet verify payment error:", error);
            return sendError(res, error, 500);
        }
    },

    async getTransactions(req, res) {
        try {
            const { page_no = 1, limit = 10 } = req.query;
            const result = await getTransactions({
                branch_id: req.branch_id,
                page_no,
                limit,
            });
            return sendSuccess(res, "Transaction history fetched successfully", result.data, {
                pagination: result.pagination,
            });
        } catch (error) {
            return sendError(res, error, 500);
        }
    },
};

export default walletController;
