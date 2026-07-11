import express from "express";
import axios from "axios";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { getOrCreateWallet, getWalletBalance, debitWallet } from "../services/walletService.js";
import {
    activateOrExtendPlan,
    getSubscriptionStatus,
} from "../services/subscriptionService.js";

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

/**
 * 1. POST /create-checkout
 * Initiates a Razorpay Order for a specific subscription plan.
 * Body: { planName: 'Business' | 'BusinessPlus' | 'BusinessPro', billingCycle: 'monthly' | 'yearly' }
 */
router.post("/create-checkout", auth, validateBranch, async (req, res) => {
    try {
        const { planName, billingCycle } = req.body || {};
        const username = req.headers["username"] || req.headers["Username"] || '';
        const branchId = req.branch_id;

        if (!planName || !["Business", "BusinessPlus", "BusinessPro"].includes(planName)) {
            return res.status(400).json({
                success: false,
                message: "Invalid planName. Must be Business, BusinessPlus, or BusinessPro."
            });
        }

        const cycle = billingCycle === "yearly" ? "yearly" : "monthly";
        const amountRupees = getPlanBasePrice(planName, cycle);
        const amountPaise = amountRupees * 100;

        const keyId = process.env.RAZORPAY_KEY_ID;
        const keySecret = process.env.RAZORPAY_KEY_SECRET;

        if (!keyId || !keySecret) {
            console.error("Razorpay API Keys are not configured in .env");
            return res.status(500).json({
                success: false,
                message: "Razorpay integration keys are not configured on the server."
            });
        }

        // Call Razorpay REST API to create an Order
        const authHeader = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
        const response = await axios.post(
            "https://api.razorpay.com/v1/orders",
            {
                amount: amountPaise,
                currency: "INR",
                receipt: `rcpt_${branchId}_${Date.now()}`,
                notes: {
                    planName,
                    billingCycle: cycle,
                    username,
                    branchId,
                }
            },
            {
                headers: {
                    Authorization: `Basic ${authHeader}`,
                    "Content-Type": "application/json"
                }
            }
        );

        const orderId = response.data.id;

        // Insert pending order status in DB (amount stored in Paise)
        await pool.query(
            `INSERT INTO razorpay_orders 
                (razorpay_order_id, username, branch_id, plan_name, billing_cycle, amount, status) 
             VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
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
                description: `${planName} Plan Subscription (${cycle})`
            }
        });
    } catch (error) {
        console.error("Create Checkout Error:", error.response?.data || error.message);
        return res.status(500).json({
            success: false,
            message: "Failed to initialize subscription checkout",
            error: error.response?.data?.error?.description || error.message
        });
    }
});

/**
 * 2. POST /verify-payment
 * Verifies payment signature and immediately activates subscription.
 * Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature, planName, billingCycle }
 */
router.post("/verify-payment", auth, validateBranch, async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, planName, billingCycle } = req.body || {};
        const username = req.headers["username"] || req.headers["Username"] || '';
        const branchId = req.branch_id;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !planName) {
            return res.status(400).json({
                success: false,
                message: "Missing payment verification parameters."
            });
        }

        const keySecret = process.env.RAZORPAY_KEY_SECRET;
        if (!keySecret) {
            return res.status(500).json({
                success: false,
                message: "Razorpay Key Secret is not configured on the server."
            });
        }

        // Verify SHA256 signature
        const crypto = await import("crypto");
        const generatedSignature = crypto
            .createHmac("sha256", keySecret)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest("hex");

        if (generatedSignature !== razorpay_signature) {
            return res.status(400).json({
                success: false,
                message: "Payment signature verification failed. Untrusted request."
            });
        }

        const cycle = billingCycle === "yearly" ? "yearly" : "monthly";
        const activation = await activateOrExtendPlan({
            branchId,
            username,
            planName,
            billingCycle: cycle,
            paymentRef: razorpay_payment_id,
            paymentMethod: "razorpay",
        });

        const amountPaise = (PLAN_PRICING[planName]?.[billingCycle || 'monthly'] || 0) * 100;

        await pool.query(
            `INSERT INTO razorpay_orders 
                (razorpay_order_id, username, branch_id, plan_name, billing_cycle, amount, status, razorpay_payment_id) 
             VALUES (?, ?, ?, ?, ?, ?, 'paid', ?) 
             ON DUPLICATE KEY UPDATE status = 'paid', razorpay_payment_id = ?, branch_id = VALUES(branch_id)`,
            [razorpay_order_id, username, branchId, planName, billingCycle || 'monthly', amountPaise, razorpay_payment_id, razorpay_payment_id]
        );

        const status = await getSubscriptionStatus(branchId);

        return res.status(200).json({
            success: true,
            message: "Subscription successfully activated.",
            data: {
                ...status,
                activated_plan: activation,
            }
        });
    } catch (error) {
        console.error("Verify Payment Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to verify payment and activate subscription",
            error: error.message
        });
    }
});

/**
 * 3. GET /status
 * Retrieves current subscription details for the active branch.
 */
router.get("/status", auth, validateBranch, async (req, res) => {
    try {
        const branchId = req.branch_id;
        const status = await getSubscriptionStatus(branchId);

        return res.status(200).json({
            success: true,
            data: status
        });
    } catch (error) {
        console.error("Get Subscription Status Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to retrieve subscription status",
            error: error.message
        });
    }
});

/**
 * GET /wallet-balance
 * Returns the active branch wallet balance for subscription checkout.
 */
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

/**
 * 4. POST /pay-from-wallet
 * Subscribes a branch to a plan by debiting the active branch's wallet balance.
 * Body: { planName: 'Business' | 'BusinessPlus' | 'BusinessPro', billingCycle: 'monthly' | 'yearly' }
 */
router.post("/pay-from-wallet", auth, validateBranch, async (req, res) => {
    let conn;
    try {
        const { planName, billingCycle } = req.body || {};
        const username = req.headers["username"] || req.headers["Username"] || '';
        const branchId = req.branch_id;

        if (!planName || !["Business", "BusinessPlus", "BusinessPro"].includes(planName)) {
            return res.status(400).json({
                success: false,
                message: "Invalid planName. Must be Business, BusinessPlus, or BusinessPro."
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
            connection: conn
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
                (razorpay_order_id, username, branch_id, plan_name, billing_cycle, amount, status, razorpay_payment_id) 
             VALUES (?, ?, ?, ?, ?, ?, 'paid', ?)`,
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
            } catch (_) { }
        }
        console.error("Wallet Subscription Payment Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to process wallet payment for subscription",
            error: error.message
        });
    } finally {
        if (conn) conn.release();
    }
});

export default router;
