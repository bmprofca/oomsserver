import pool from "../db.js";
import { activatePlan } from "./subscriptionService.js";
import { creditWallet } from "./walletService.js";

async function getOrderByRazorpayId(orderId) {
    try {
        const [rows] = await pool.query(
            `SELECT
                razorpay_order_id,
                username,
                branch_id,
                plan_name,
                billing_cycle,
                amount,
                status,
                order_type,
                remark,
                details,
                credit_amount,
                gateway_fee
             FROM razorpay_orders
             WHERE razorpay_order_id = ?
             LIMIT 1`,
            [orderId]
        );
        return rows[0] || null;
    } catch (error) {
        if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
        const [rows] = await pool.query(
            `SELECT
                razorpay_order_id,
                username,
                branch_id,
                plan_name,
                billing_cycle,
                amount,
                status,
                order_type,
                remark,
                details
             FROM razorpay_orders
             WHERE razorpay_order_id = ?
             LIMIT 1`,
            [orderId]
        );
        return rows[0] || null;
    }
}

async function markOrderFailed(orderId) {
    await pool.query(
        `UPDATE razorpay_orders
         SET status = 'failed'
         WHERE razorpay_order_id = ?
           AND status = 'pending'`,
        [orderId]
    );
}

async function walletAlreadyCreditedForPayment({ branchId, paymentId }) {
    if (!paymentId) return false;
    const [rows] = await pool.query(
        `SELECT transaction_id
         FROM wallet_transactions
         WHERE branch_id = ?
           AND type = 'credit'
           AND details LIKE ?
         LIMIT 1`,
        [branchId, `%${paymentId}%`]
    );
    return rows.length > 0;
}

/**
 * Idempotent fulfillment for checkout verify + webhooks.
 * Claims pending orders with a conditional update so concurrent handlers cannot double-fulfill.
 */
export async function fulfillRazorpayOrder({ orderId, paymentId, source = "webhook" }) {
    const order = await getOrderByRazorpayId(orderId);
    if (!order) {
        return { fulfilled: false, reason: "order_not_found" };
    }

    if (order.status === "paid") {
        return { fulfilled: true, reason: "already_paid", order };
    }

    if (!order.branch_id) {
        throw new Error(`Missing branch_id for Razorpay order ${orderId}`);
    }

    const [claimResult] = await pool.query(
        `UPDATE razorpay_orders
         SET status = 'processing', razorpay_payment_id = ?
         WHERE razorpay_order_id = ?
           AND status = 'pending'`,
        [paymentId, orderId]
    );

    if (Number(claimResult?.affectedRows || 0) === 0) {
        const latest = await getOrderByRazorpayId(orderId);
        if (latest?.status === "paid") {
            return { fulfilled: true, reason: "already_paid", order: latest };
        }
        return {
            fulfilled: false,
            reason: `order_status_${latest?.status || "unknown"}`,
            order: latest || order,
        };
    }

    const orderType = order.order_type || "subscription";

    try {
        if (orderType === "wallet") {
            const creditPaise =
                order.credit_amount != null && Number(order.credit_amount) > 0
                    ? Number(order.credit_amount)
                    : Number(order.amount || 0);
            const amountRupees = creditPaise / 100;
            if (amountRupees <= 0) {
                throw new Error(`Invalid wallet top-up amount for order ${orderId}`);
            }

            const feePaise = Number(order.gateway_fee) || 0;
            const feeNote =
                feePaise > 0
                    ? ` (gateway fee ₹${(feePaise / 100).toFixed(2)})`
                    : "";

            const alreadyCredited = await walletAlreadyCreditedForPayment({
                branchId: order.branch_id,
                paymentId,
            });
            if (!alreadyCredited) {
                await creditWallet({
                    branch_id: order.branch_id,
                    amount: amountRupees,
                    remark: order.remark || "Wallet Recharge",
                    details:
                        order.details ||
                        `Razorpay top-up (${source}) payment ${paymentId} for order ${orderId}${feeNote}`,
                });
            }
        } else {
            if (!order.plan_name) {
                throw new Error(`Missing plan_name for subscription order ${orderId}`);
            }

            await activatePlan({
                branchId: order.branch_id,
                username: order.username,
                planName: order.plan_name,
                billingCycle: order.billing_cycle || "monthly",
                paymentRef: paymentId,
                paymentMethod: source === "webhook" ? "razorpay_webhook" : "razorpay",
            });
        }

        await pool.query(
            `UPDATE razorpay_orders
             SET status = 'paid', razorpay_payment_id = ?
             WHERE razorpay_order_id = ?`,
            [paymentId, orderId]
        );

        return { fulfilled: true, reason: "processed", order, orderType };
    } catch (error) {
        await pool.query(
            `UPDATE razorpay_orders
             SET status = 'pending'
             WHERE razorpay_order_id = ?
               AND status = 'processing'`,
            [orderId]
        );
        throw error;
    }
}

function extractPaymentRefs(payload) {
    const payment = payload?.payload?.payment?.entity || null;
    const order = payload?.payload?.order?.entity || null;
    const orderId = payment?.order_id || order?.id || null;
    const paymentId = payment?.id || null;
    return { orderId, paymentId };
}

export async function handleRazorpayWebhookPayload(payload) {
    const event = payload?.event;
    if (!event) {
        return { handled: false, message: "Missing event" };
    }

    if (event === "payment.captured" || event === "order.paid") {
        const { orderId, paymentId } = extractPaymentRefs(payload);

        if (!orderId || !paymentId) {
            return {
                handled: false,
                message: "Missing payment/order entity",
                event,
            };
        }

        const result = await fulfillRazorpayOrder({
            orderId,
            paymentId,
            source: "webhook",
        });

        return { handled: true, event, ...result };
    }

    if (event === "payment.failed") {
        const { orderId } = extractPaymentRefs(payload);
        if (orderId) {
            await markOrderFailed(orderId);
        }
        return { handled: true, event, reason: "payment_failed" };
    }

    return { handled: true, event, reason: "ignored" };
}
