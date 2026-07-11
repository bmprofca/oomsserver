import pool from "../db.js";
import { activateOrExtendPlan } from "./subscriptionService.js";
import { creditWallet } from "./walletService.js";

async function getOrderByRazorpayId(orderId) {
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
            purpose,
            details
         FROM razorpay_orders
         WHERE razorpay_order_id = ?
         LIMIT 1`,
        [orderId]
    );
    return rows[0] || null;
}

async function markOrderPaid({ orderId, paymentId, connection = null }) {
    const runner = connection || pool;
    await runner.query(
        `UPDATE razorpay_orders
         SET status = 'paid', razorpay_payment_id = ?
         WHERE razorpay_order_id = ?`,
        [paymentId, orderId]
    );
}

async function markOrderFailed(orderId) {
    await pool.query(
        `UPDATE razorpay_orders SET status = 'failed' WHERE razorpay_order_id = ? AND status = 'pending'`,
        [orderId]
    );
}

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

    const orderType = order.order_type || "subscription";

    if (orderType === "wallet") {
        const amountRupees = Number(order.amount || 0) / 100;
        if (amountRupees <= 0) {
            throw new Error(`Invalid wallet top-up amount for order ${orderId}`);
        }

        await creditWallet({
            branch_id: order.branch_id,
            amount: amountRupees,
            purpose: order.purpose || "Wallet Recharge",
            details:
                order.details ||
                `Razorpay top-up (${source}) payment ${paymentId} for order ${orderId}`,
        });
    } else {
        if (!order.plan_name) {
            throw new Error(`Missing plan_name for subscription order ${orderId}`);
        }

        await activateOrExtendPlan({
            branchId: order.branch_id,
            username: order.username,
            planName: order.plan_name,
            billingCycle: order.billing_cycle || "monthly",
            paymentRef: paymentId,
            paymentMethod: source === "webhook" ? "razorpay_webhook" : "razorpay",
        });
    }

    await markOrderPaid({ orderId, paymentId });
    return { fulfilled: true, reason: "processed", order, orderType };
}

export async function handleRazorpayWebhookPayload(payload) {
    const event = payload?.event;
    if (!event) {
        return { handled: false, message: "Missing event" };
    }

    if (event === "payment.captured" || event === "order.paid") {
        const payment = payload?.payload?.payment?.entity;
        const orderId = payment?.order_id;
        const paymentId = payment?.id;

        if (!orderId || !paymentId) {
            return { handled: false, message: "Missing payment entity" };
        }

        const result = await fulfillRazorpayOrder({
            orderId,
            paymentId,
            source: "webhook",
        });

        return { handled: true, event, ...result };
    }

    if (event === "payment.failed") {
        const payment = payload?.payload?.payment?.entity;
        const orderId = payment?.order_id;
        if (orderId) {
            await markOrderFailed(orderId);
        }
        return { handled: true, event, reason: "payment_failed" };
    }

    return { handled: true, event, reason: "ignored" };
}
