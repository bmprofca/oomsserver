import express from "express";
import axios from "axios";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { getOrCreateWallet, debitWallet } from "../services/walletService.js";

const router = express.Router();

/**
 * 1. POST /create-checkout
 * Initiates a Razorpay Order for a specific subscription plan.
 * Body: { planName: 'Business' | 'BusinessPlus' | 'BusinessPro', billingCycle: 'monthly' | 'yearly' }
 */
router.post("/create-checkout", auth, async (req, res) => {
    try {
        const { planName, billingCycle } = req.body || {};
        const username = req.headers["username"] || req.headers["Username"] || '';

        if (!planName || !["Business", "BusinessPlus", "BusinessPro"].includes(planName)) {
            return res.status(400).json({
                success: false,
                message: "Invalid planName. Must be Business, BusinessPlus, or BusinessPro."
            });
        }

        const cycle = billingCycle === "yearly" ? "yearly" : "monthly";

        // Plan pricing in INR Rupees
        const pricing = {
            Business: { monthly: 999, yearly: 9999 },
            BusinessPlus: { monthly: 1999, yearly: 19999 },
            BusinessPro: { monthly: 2999, yearly: 29999 }
        };

        const amountRupees = pricing[planName][cycle];
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
                receipt: `rcpt_${username}_${Date.now()}`,
                notes: {
                    planName,
                    billingCycle: cycle,
                    username
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
                (razorpay_order_id, username, plan_name, billing_cycle, amount, status) 
             VALUES (?, ?, ?, ?, ?, 'pending')`,
            [orderId, username, planName, cycle, amountPaise]
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
router.post("/verify-payment", auth, async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, planName, billingCycle } = req.body || {};
        const username = req.headers["username"] || req.headers["Username"] || '';

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

        // Calculate Plan Expiration Date
        const expiresAt = new Date();
        if (billingCycle === "yearly") {
            expiresAt.setFullYear(expiresAt.getFullYear() + 1);
        } else {
            expiresAt.setMonth(expiresAt.getMonth() + 1);
        }

        // Update database with subscription state
        await pool.query(
            `UPDATE users 
             SET is_subscribed = 'yes', 
                 subscription_plan = ?, 
                 subscription_expires_at = ?, 
                 razorpay_subscription_id = ? 
             WHERE username = ?`,
            [planName, expiresAt, razorpay_order_id, username]
        );

        // Update orders tracking (convert to paise or retrieve)
        const pricing = {
            Business: { monthly: 999, yearly: 9999 },
            BusinessPlus: { monthly: 1999, yearly: 19999 },
            BusinessPro: { monthly: 2999, yearly: 29999 }
        };
        const amountPaise = (pricing[planName]?.[billingCycle || 'monthly'] || 0) * 100;

        await pool.query(
            `INSERT INTO razorpay_orders 
                (razorpay_order_id, username, plan_name, billing_cycle, amount, status, razorpay_payment_id) 
             VALUES (?, ?, ?, ?, ?, 'paid', ?) 
             ON DUPLICATE KEY UPDATE status = 'paid', razorpay_payment_id = ?`,
            [razorpay_order_id, username, planName, billingCycle || 'monthly', amountPaise, razorpay_payment_id, razorpay_payment_id, razorpay_payment_id]
        );

        return res.status(200).json({
            success: true,
            message: "Subscription successfully activated.",
            data: {
                is_subscribed: "yes",
                subscription_plan: planName,
                subscription_expires_at: expiresAt
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
 * Retrieves current subscription details for user and active branch.
 */
router.get("/status", auth, async (req, res) => {
    try {
        const username = req.headers["username"] || req.headers["Username"] || '';
        const branch_id = req.headers["branch"] || req.headers["Branch"] || req.query.branch_id || '';

        // Fetch current user details
        const [userRows] = await pool.query(
            "SELECT is_subscribed, subscription_plan, subscription_expires_at FROM users WHERE username = ? LIMIT 1",
            [username]
        );

        if (userRows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "User account not found."
            });
        }

        const currentUser = userRows[0];

        // Resolve branch subscription status if branch context is present
        let targetUserSub = currentUser;
        let source = "self";

        if (branch_id) {
            const [ownerRows] = await pool.query(
                `SELECT bm.username 
                 FROM branch_mapping bm 
                 WHERE bm.branch_id = ? AND bm.type = 'admin' AND bm.is_deleted = '0' 
                 LIMIT 1`,
                [branch_id]
            );

            if (ownerRows.length > 0) {
                const ownerUsername = ownerRows[0].username;
                if (ownerUsername !== username) {
                    const [ownerSubRows] = await pool.query(
                        "SELECT is_subscribed, subscription_plan, subscription_expires_at FROM users WHERE username = ? LIMIT 1",
                        [ownerUsername]
                    );
                    if (ownerSubRows.length > 0) {
                        targetUserSub = ownerSubRows[0];
                        source = "branch_owner";
                    }
                }
            }
        }

        const isSubscribed = targetUserSub.is_subscribed === "yes";
        const hasExpired = targetUserSub.subscription_expires_at && new Date(targetUserSub.subscription_expires_at) < new Date();

        return res.status(200).json({
            success: true,
            data: {
                is_subscribed: isSubscribed && !hasExpired ? "yes" : "no",
                subscription_plan: isSubscribed && !hasExpired ? targetUserSub.subscription_plan : "None",
                subscription_expires_at: targetUserSub.subscription_expires_at,
                is_expired: !!hasExpired,
                effective_plan_source: source
            }
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
 * 4. POST /pay-from-wallet
 * Subscribes a user to a plan by debiting the active branch's wallet balance.
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

        // Plan pricing in INR Rupees
        const pricing = {
            Business: { monthly: 999, yearly: 9999 },
            BusinessPlus: { monthly: 1999, yearly: 19999 },
            BusinessPro: { monthly: 2999, yearly: 29999 }
        };

        const amountRupees = pricing[planName][cycle];

        // Fetch and verify wallet balance
        const wallet = await getOrCreateWallet(branchId);
        if (wallet.balance < amountRupees) {
            return res.status(400).json({
                success: false,
                message: `Insufficient wallet balance. Plan price is ₹${amountRupees}, but your wallet balance is ₹${wallet.balance}. Please add money to your wallet.`
            });
        }

        // Calculate Plan Expiration Date
        const expiresAt = new Date();
        if (cycle === "yearly") {
            expiresAt.setFullYear(expiresAt.getFullYear() + 1);
        } else {
            expiresAt.setMonth(expiresAt.getMonth() + 1);
        }

        const walletOrderId = `wallet_pay_${branchId}_${Date.now()}`;

        // Process payment and activate subscription inside transaction
        conn = await pool.getConnection();
        await conn.beginTransaction();

        // 1. Debit wallet
        await debitWallet({
            branch_id: branchId,
            amount: amountRupees,
            purpose: `Subscription: ${planName} (${cycle})`,
            details: `Subscribed via wallet payment for user ${username}`,
            connection: conn
        });

        // 2. Update user subscription status
        await conn.query(
            `UPDATE users 
             SET is_subscribed = 'yes', 
                 subscription_plan = ?, 
                 subscription_expires_at = ?, 
                 razorpay_subscription_id = ? 
             WHERE username = ?`,
            [planName, expiresAt, walletOrderId, username]
        );

        // 3. Record transaction in orders table (amount in Paise)
        await conn.query(
            `INSERT INTO razorpay_orders 
                (razorpay_order_id, username, plan_name, billing_cycle, amount, status, razorpay_payment_id) 
             VALUES (?, ?, ?, ?, ?, 'paid', ?)`,
            [walletOrderId, username, planName, cycle, amountRupees * 100, walletOrderId]
        );

        await conn.commit();

        return res.status(200).json({
            success: true,
            message: "Subscription successfully paid and activated via wallet.",
            data: {
                is_subscribed: "yes",
                subscription_plan: planName,
                subscription_expires_at: expiresAt,
                remaining_wallet_balance: wallet.balance - amountRupees
            }
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
            error: error.message
        });
    } finally {
        if (conn) conn.release();
    }
});

export default router;
// Trigger reload: loaded Razorpay test credentials
