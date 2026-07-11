import express from "express";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { getOrCreateWallet, getWalletBalance, debitWallet } from "../services/walletService.js";
import {
    activateOrExtendPlan,
    getSubscriptionStatus,
} from "../services/subscriptionService.js";
import {
    createRazorpayOrder,
    verifyRazorpayPaymentSignature,
} from "../services/razorpayService.js";
import { fulfillRazorpayOrder } from "../services/razorpayWebhookService.js";

const router = express.Router();

const GST_RATE = 0.18;

const PLAN_PRICING = {
    Business: { monthly: 999, yearly: 9999 },
    BusinessPlus: { monthly: 1999, yearly: 19999 },
    BusinessPro: { monthly: 2999, yearly: 29999 },
};

const getPlanBasePrice = (planName, cycle) => PLAN_PRICING[planName][cycle];

const getPlanTotalWithGst = (planName, cycle) => {
    const base = getPlanBasePrice(planName, cycle);
    return Math.round(base * (1 + GST_RATE) * 100) / 100;
};

router.post("/create-checkout", auth, validateBranch, async (req, res) => {
    try {
        const { planName, billingCycle } = req.body || {};
        const username = req.headers["username"] || req.headers["Username"] || "";
        const branchId = req.branch_id;

        if (!planName || !["Business", "BusinessPlus", "BusinessPro"].includes(planName)) {
            return res.status(400).json({
                success: false,
                message: "Invalid planName. Must be Business, BusinessPlus, or BusinessPro.",
            });
        }

        const cycle = billingCycle === "yearly" ? "yearly" : "monthly";
        const baseAmountRupees = getPlanBasePrice(planName, cycle);
        const amountRupees = getPlanTotalWithGst(planName, cycle);
        const amountPaise = Math.round(amountRupees * 100);

        const { orderId, keyId } = await createRazorpayOrder({
            amountPaise,
            receipt: `sub_${branchId}_${Date.now()}`,
            notes: {
                orderType: "subscription",
                planName,
                billingCycle: cycle,
                username,
                branchId,
                baseAmountRupees: String(baseAmountRupees),
                gstRate: String(GST_RATE),
            },
        });

        await pool.query(
            `INSERT INTO razorpay_orders
                (razorpay_order_id, username, branch_id, plan_name, billing_cycle, order_type, amount, status)
             VALUES (?, ?, ?, ?, ?, 'subscription', ?, 'pending')`,
            [orderId, username, branchId, planName, cycle, amountPaise]
        );

        return res.status(200).json({
            success: true,
            data: {
                key: keyId,
                amount: amountPaise,
                currency: "INR",
                order_id: orderId,
                name: "OOMS CRM",
                description: `${planName} Plan Subscription (${cycle}, incl. GST)`,
                base_amount: baseAmountRupees,
                total_amount: amountRupees,
                gst_rate: GST_RATE,
            },
        });
    } catch (error) {
        console.error("Create Checkout Error:", error.response?.data || error.message);
        return res.status(error.statusCode || 500).json({
            success: false,
            message: error.message || "Failed to initialize subscription checkout",
            error: error.response?.data?.error?.description || error.message,
        });
    }
});

router.post("/verify-payment", auth, validateBranch, async (req, res) => {
    try {
        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            planName,
            billingCycle,
        } = req.body || {};
        const username = req.headers["username"] || req.headers["Username"] || "";
        const branchId = req.branch_id;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !planName) {
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
                message: "Payment signature verification failed. Untrusted request.",
            });
        }

        const cycle = billingCycle === "yearly" ? "yearly" : "monthly";
        const amountPaise = Math.round(getPlanTotalWithGst(planName, cycle) * 100);

        await pool.query(
            `INSERT INTO razorpay_orders
                (razorpay_order_id, username, branch_id, plan_name, billing_cycle, order_type, amount, status, razorpay_payment_id)
             VALUES (?, ?, ?, ?, ?, 'subscription', ?, 'pending', ?)
             ON DUPLICATE KEY UPDATE
                username = VALUES(username),
                branch_id = VALUES(branch_id),
                plan_name = VALUES(plan_name),
                billing_cycle = VALUES(billing_cycle),
                order_type = 'subscription',
                amount = VALUES(amount)`,
            [razorpay_order_id, username, branchId, planName, cycle, amountPaise, razorpay_payment_id]
        );

        const result = await fulfillRazorpayOrder({
            orderId: razorpay_order_id,
            paymentId: razorpay_payment_id,
            source: "verify",
        });

        const status = await getSubscriptionStatus(branchId);

        return res.status(200).json({
            success: true,
            message: result.reason === "already_paid"
                ? "Subscription is already active for this payment."
                : "Subscription successfully activated.",
            data: status,
        });
    } catch (error) {
        console.error("Verify Payment Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to verify payment and activate subscription",
            error: error.message,
        });
    }
});

router.get("/status", auth, validateBranch, async (req, res) => {
    try {
        const branchId = req.branch_id;
        const status = await getSubscriptionStatus(branchId);

        return res.status(200).json({
            success: true,
            data: status,
        });
    } catch (error) {
        console.error("Get Subscription Status Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to retrieve subscription status",
            error: error.message,
        });
    }
});

router.get("/wallet-balance", auth, validateBranch, async (req, res) => {
    try {
        const branchId = req.branch_id;
        const balance = await getWalletBalance(branchId);

        return res.status(200).json({
            success: true,
            data: {
                branch_id: branchId,
                balance,
            },
        });
    } catch (error) {
        console.error("Get Subscription Wallet Balance Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch wallet balance",
            error: error.message,
        });
    }
});

router.post("/pay-from-wallet", auth, validateBranch, async (req, res) => {
    let conn;
    try {
        const { planName, billingCycle } = req.body || {};
        const username = req.headers["username"] || req.headers["Username"] || "";
        const branchId = req.branch_id;

        if (!planName || !["Business", "BusinessPlus", "BusinessPro"].includes(planName)) {
            return res.status(400).json({
                success: false,
                message: "Invalid planName. Must be Business, BusinessPlus, or BusinessPro.",
            });
        }

        const cycle = billingCycle === "yearly" ? "yearly" : "monthly";
        const baseAmountRupees = getPlanBasePrice(planName, cycle);
        const amountRupees = getPlanTotalWithGst(planName, cycle);

        const wallet = await getOrCreateWallet(branchId);
        if (wallet.balance < amountRupees) {
            return res.status(400).json({
                success: false,
                message: `Insufficient wallet balance. Total incl. GST is ₹${amountRupees.toFixed(2)}, but your wallet balance is ₹${wallet.balance.toFixed(2)}. Please add money to your wallet.`,
                data: {
                    required_amount: amountRupees,
                    base_amount: baseAmountRupees,
                    gst_rate: GST_RATE,
                    wallet_balance: wallet.balance,
                },
            });
        }

        const walletOrderId = `wallet_pay_${branchId}_${Date.now()}`;

        conn = await pool.getConnection();
        await conn.beginTransaction();

        await debitWallet({
            branch_id: branchId,
            amount: amountRupees,
            purpose: `Subscription: ${planName} (${cycle}, incl. GST)`,
            details: `Subscribed via wallet payment for branch ${branchId} by ${username}. Base ₹${baseAmountRupees}, GST ${GST_RATE * 100}%, total ₹${amountRupees}`,
            connection: conn,
        });

        const activation = await activateOrExtendPlan({
            branchId,
            username,
            planName,
            billingCycle: cycle,
            paymentRef: walletOrderId,
            paymentMethod: "wallet",
            connection: conn,
        });

        await conn.query(
            `INSERT INTO razorpay_orders
                (razorpay_order_id, username, branch_id, plan_name, billing_cycle, order_type, amount, status, razorpay_payment_id)
             VALUES (?, ?, ?, ?, ?, 'subscription', ?, 'paid', ?)`,
            [walletOrderId, username, branchId, planName, cycle, amountRupees * 100, walletOrderId]
        );

        await conn.commit();

        const remainingBalance = await getWalletBalance(branchId);
        const status = await getSubscriptionStatus(branchId);

        return res.status(200).json({
            success: true,
            message: "Subscription successfully paid and activated via wallet.",
            data: {
                ...status,
                activated_plan: activation,
                remaining_wallet_balance: remainingBalance,
                amount_paid: amountRupees,
                base_amount: baseAmountRupees,
                gst_rate: GST_RATE,
            },
        });
    } catch (error) {
        if (conn) {
            try {
                await conn.rollback();
            } catch (_) {}
        }
        console.error("Wallet Subscription Payment Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to process wallet payment for subscription",
            error: error.message,
        });
    } finally {
        if (conn) conn.release();
    }
});

export default router;
