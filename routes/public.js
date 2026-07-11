import express from "express";
import pool from "../db.js";
import { USER_SNIPPED_DATA } from "../helpers/function.js";
import { BASE_DOMAIN } from "../helpers/Config.js";
import { activateOrExtendPlan } from "../services/subscriptionService.js";

const router = express.Router();

async function getInvitationByToken(token) {
    const [rows] = await pool.query(
        `SELECT
            bm.map_id,
            bm.branch_id,
            bm.username,
            bm.type,
            bm.designation,
            bm.is_accepted,
            bm.status,
            bm.is_deleted,
            bm.create_by,
            bl.name AS branch_name,
            bl.logo,
            bl.address_line_1,
            bl.address_line_2,
            bl.city,
            bl.state,
            bl.country,
            bl.pincode,
            bl.mobile_1,
            bl.mobile_2,
            bl.email_1,
            bl.email_2,
            bl.is_deleted AS branch_is_deleted
         FROM branch_mapping bm
         LEFT JOIN branch_list bl ON bl.branch_id = bm.branch_id
         WHERE bm.invitation_token = ?
         LIMIT 1`,
        [token]
    );

    return rows[0] || null;
}

function validatePendingInvitation(invitation) {
    if (!invitation) {
        return { valid: false, status: 404, message: "Invalid invitation token" };
    }

    if (invitation.is_deleted != "0") {
        return { valid: false, status: 404, message: "Invalid invitation token" };
    }

    if (invitation.branch_is_deleted != "0") {
        return { valid: false, status: 404, message: "Branch is no longer available" };
    }

    if (invitation.is_accepted == "1") {
        return { valid: false, status: 400, message: "Invitation has already been accepted" };
    }

    if (invitation.status != "1") {
        return { valid: false, status: 400, message: "Invitation is no longer active" };
    }

    return { valid: true };
}

function formatBranchDetails(invitation) {
    return {
        branch_id: invitation.branch_id,
        name: invitation.branch_name,
        logo:
            invitation.logo != null && invitation.logo !== ""
                ? `${BASE_DOMAIN}/media/logo/${invitation.logo}`
                : null,
        address: {
            address_line_1: invitation.address_line_1,
            address_line_2: invitation.address_line_2,
            city: invitation.city,
            state: invitation.state,
            country: invitation.country,
            pincode: invitation.pincode,
        },
        mobile: invitation.mobile_1,
        mobile_2: invitation.mobile_2,
        email: invitation.email_1,
        email_2: invitation.email_2,
    };
}

router.get("/invitation-details", async (req, res) => {
    try {
        const token = req.query?.token;

        if (!token || String(token).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "token is required",
            });
        }

        const invitation = await getInvitationByToken(String(token).trim());
        const validation = validatePendingInvitation(invitation);

        if (!validation.valid) {
            return res.status(validation.status).json({
                success: false,
                message: validation.message,
            });
        }

        const [invitedUser, invitedBy] = await Promise.all([
            USER_SNIPPED_DATA(invitation.username),
            USER_SNIPPED_DATA(invitation.create_by),
        ]);

        return res.status(200).json({
            success: true,
            message: "Invitation details retrieved successfully",
            data: {
                map_id: invitation.map_id,
                type: invitation.type,
                designation: invitation.designation || null,
                invited_user: invitedUser,
                invited_by: invitedBy,
                branch: formatBranchDetails(invitation),
            },
        });
    } catch (error) {
        console.error("Error fetching invitation details:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch invitation details",
            error: error.message,
        });
    }
});

router.post("/invitation-accept", async (req, res) => {
    let conn;

    try {
        const token = req.body?.token;

        if (!token || String(token).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "token is required",
            });
        }

        const trimmedToken = String(token).trim();
        const invitation = await getInvitationByToken(trimmedToken);
        const validation = validatePendingInvitation(invitation);

        if (!validation.valid) {
            return res.status(validation.status).json({
                success: false,
                message: validation.message,
            });
        }

        conn = await pool.getConnection();
        await conn.beginTransaction();

        const [pendingRows] = await conn.query(
            `SELECT map_id, branch_id, username, type, designation
             FROM branch_mapping
             WHERE invitation_token = ?
               AND is_accepted = '0'
               AND status = '1'
               AND is_deleted = '0'
             LIMIT 1
             FOR UPDATE`,
            [trimmedToken]
        );

        if (!pendingRows.length) {
            await conn.rollback();
            return res.status(404).json({
                success: false,
                message: "Invalid invitation token",
            });
        }

        const pendingInvitation = pendingRows[0];

        await conn.query(
            `UPDATE branch_mapping
             SET is_accepted = '1', modify_date = CURRENT_TIMESTAMP
             WHERE invitation_token = ?`,
            [trimmedToken]
        );

        const [branchRows] = await conn.query(
            `SELECT branch_id, name AS branch_name
             FROM branch_list
             WHERE branch_id = ? AND is_deleted = '0'
             LIMIT 1`,
            [pendingInvitation.branch_id]
        );

        if (!branchRows.length) {
            await conn.rollback();
            return res.status(404).json({
                success: false,
                message: "Branch is no longer available",
            });
        }

        await conn.commit();

        return res.status(200).json({
            success: true,
            message: "Invitation accepted successfully",
            data: {
                map_id: pendingInvitation.map_id,
                username: pendingInvitation.username,
                branch_id: branchRows[0].branch_id,
                branch_name: branchRows[0].branch_name,
                type: pendingInvitation.type,
                designation: pendingInvitation.designation || null,
            },
        });
    } catch (error) {
        if (conn) await conn.rollback();
        console.error("Error accepting invitation:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to accept invitation",
            error: error.message,
        });
    } finally {
        if (conn) conn.release();
    }
});

router.get("/contact", async (req, res) => {
    return res.status(200).json({
        success: true,
        message: "Contact details retrieved successfully",
        data: {
            email: [
                {
                    type: 'sale',
                    email: 'sale@example.com'
                },
                {
                    type: 'technical',
                    email: 'technical@example.com'
                },
                {
                    type: 'general',
                    email: 'general@example.com'
                }
            ],
            phone: [
                {
                    type: 'sale',
                    phone: '+91 9876543210'
                },
                {
                    type: 'technical',
                    phone: '+91 9876543210'
                },
                {
                    type: 'general',
                    phone: '+91 9876543210'
                }
            ],
            whatsapp: [
                {
                    type: 'sale',
                    whatsapp: '+91 9876543210'
                },
                {
                    type: 'technical',
                    whatsapp: '+91 9876543210'
                },
                {
                    type: 'general',
                    whatsapp: '+91 9876543210'
                }
            ],
            address: [
                {
                    type: 'head office',
                    address: '123, Main Street, Anytown, USA'
                },
                {
                    type: 'branch office',
                    address: '123, Main Street, Anytown, USA'
                },
                {
                    type: 'branch office',
                    address: '123, Main Street, Anytown, USA'
                }
            ]
        }
    });
});

/**
 * POST /webhook/razorpay
 * Unauthenticated webhook handler to listen for Razorpay payment notifications.
 */
router.post("/webhook/razorpay", async (req, res) => {
    const signature = req.headers["x-razorpay-signature"];
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

    // Optional webhook signature verification
    if (webhookSecret && signature) {
        try {
            const crypto = await import("crypto");
            const shasum = crypto.createHmac("sha256", webhookSecret);
            shasum.update(JSON.stringify(req.body));
            const digest = shasum.digest("hex");

            if (digest !== signature) {
                console.error("Razorpay Webhook Signature verification failed.");
                return res.status(400).json({ success: false, message: "Invalid signature" });
            }
        } catch (err) {
            console.error("Webhook signature calculation error:", err);
            return res.status(500).json({ success: false, message: "Signature verification failed error" });
        }
    }

    const event = req.body?.event;
    console.log("Razorpay Webhook Received. Event:", event);

    try {
        if (event === "order.paid" || event === "payment.captured") {
            const payload = req.body.payload;
            const payment = payload?.payment?.entity;
            const orderId = payment?.order_id;

            if (orderId) {
                // Fetch the pending order details
                const [orders] = await pool.query(
                    "SELECT username, branch_id, plan_name, billing_cycle FROM razorpay_orders WHERE razorpay_order_id = ? LIMIT 1",
                    [orderId]
                );

                if (orders.length > 0) {
                    const { username, branch_id, plan_name, billing_cycle } = orders[0];

                    if (!branch_id) {
                        console.error(`Razorpay Webhook: missing branch_id for order ${orderId}`);
                    } else {
                        await activateOrExtendPlan({
                            branchId: branch_id,
                            username,
                            planName: plan_name,
                            billingCycle: billing_cycle || "monthly",
                            paymentRef: orderId,
                            paymentMethod: "razorpay_webhook",
                        });
                    }

                    // Update order status to paid
                    await pool.query(
                        "UPDATE razorpay_orders SET status = 'paid', razorpay_payment_id = ? WHERE razorpay_order_id = ?",
                        [payment.id, orderId]
                    );

                    console.log(`Razorpay Webhook processed successfully. Plan: ${plan_name} for User: ${username}`);
                }
            }
        }

        return res.status(200).json({ status: "ok" });
    } catch (error) {
        console.error("Razorpay Webhook Processing Error:", error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
