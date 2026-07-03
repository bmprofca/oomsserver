import express from "express";
import axios from "axios";
import pool from "../db.js";
import { auth } from "../middleware/auth.js";

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

        // Plan pricing in INR (represented in Paise, where 1 INR = 100 Paise)
        const pricing = {
            Business: { monthly: 99900, yearly: 999900 },
            BusinessPlus: { monthly: 199900, yearly: 1999900 },
            BusinessPro: { monthly: 299900, yearly: 2999900 }
        };

        const amount = pricing[planName][cycle];

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
                amount,
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

        // Insert pending order status in DB
        await pool.query(
            `INSERT INTO razorpay_orders 
                (razorpay_order_id, username, plan_name, billing_cycle, amount, status) 
             VALUES (?, ?, ?, ?, ?, 'pending')`,
            [orderId, username, planName, cycle, amount]
        );

        return res.status(200).json({
            success: true,
            data: {
                key: keyId,
                amount,
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

        // Update orders tracking
        await pool.query(
            `INSERT INTO razorpay_orders 
                (razorpay_order_id, username, plan_name, billing_cycle, status, razorpay_payment_id) 
             VALUES (?, ?, ?, ?, 'paid', ?) 
             ON DUPLICATE KEY UPDATE status = 'paid', razorpay_payment_id = ?`,
            [razorpay_order_id, username, planName, billingCycle || 'monthly', razorpay_payment_id, razorpay_payment_id]
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

export default router;
