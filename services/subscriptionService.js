import crypto from 'crypto';
import pool from '../db.js';

export const VALID_PLANS = ['Business', 'BusinessPlus', 'BusinessPro'];

export const PLAN_TIER = {
    Business: 1,
    BusinessPlus: 2,
    BusinessPro: 3,
};

export const SUBSCRIPTION_DAYS = {
    monthly: 30,
    yearly: 365,
};

const newSubscriptionId = () => `sub_${crypto.randomBytes(8).toString('hex')}`;

const emptyStatus = (branchId = '') => ({
    branch_id: branchId || null,
    is_subscribed: 'no',
    subscription_plan: 'None',
    subscription_expires_at: null,
    is_expired: true,
    effective_plan_source: 'branch',
    active_plans: [],
    features: {
        core: false,
        'salary-management': false,
        'live-chat': false,
    },
});

export function getSubscriptionDays(billingCycle) {
    return billingCycle === 'yearly' ? SUBSCRIPTION_DAYS.yearly : SUBSCRIPTION_DAYS.monthly;
}

export function addDays(date, days) {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
}

export function isPlanActive(expiresAt) {
    if (!expiresAt) return false;
    return new Date(expiresAt).getTime() > Date.now();
}

export function getHighestPlanTier(activePlanNames = []) {
    let highest = null;
    let tier = 0;
    for (const planName of activePlanNames) {
        const planTier = PLAN_TIER[planName] || 0;
        if (planTier > tier) {
            tier = planTier;
            highest = planName;
        }
    }
    return highest;
}

export function buildFeatureAccess(activePlanNames = []) {
    const set = new Set(activePlanNames);
    const hasCore = VALID_PLANS.some((plan) => set.has(plan));
    const hasPlusOrPro = set.has('BusinessPlus') || set.has('BusinessPro');
    const hasLiveChat = set.has('BusinessPro');

    return {
        core: hasCore,
        'salary-management': hasPlusOrPro,
        'live-chat': hasLiveChat,
    };
}

async function getBranchOwnerUsername(branchId, connection = null) {
    const runner = connection || pool;
    const [ownerRows] = await runner.query(
        `SELECT username
         FROM branch_mapping
         WHERE branch_id = ?
           AND type = 'admin'
           AND is_deleted = '0'
         LIMIT 1`,
        [branchId]
    );

    return ownerRows[0]?.username || null;
}

/**
 * Legacy mirror on users.is_subscribed / subscription_plan / subscription_expires_at.
 * Runtime access control MUST use user_subscriptions via getSubscriptionStatus — not these columns.
 */
async function syncBranchOwnerLegacySummary(branchId, connection = null) {
    const runner = connection || pool;
    const ownerUsername = await getBranchOwnerUsername(branchId, runner);
    if (!ownerUsername) return;

    const status = await getSubscriptionStatus(branchId, runner);
    const activeNames = (status.active_plans || [])
        .filter((plan) => plan.is_active)
        .map((plan) => plan.plan_name);

    const highestPlan = getHighestPlanTier(activeNames) || 'None';
    const latestExpiry = status.active_plans
        .filter((plan) => plan.is_active)
        .map((plan) => new Date(plan.expires_at))
        .sort((a, b) => b.getTime() - a.getTime())[0] || null;

    await runner.query(
        `UPDATE users
         SET is_subscribed = ?,
             subscription_plan = ?,
             subscription_expires_at = ?
         WHERE username = ?`,
        [
            activeNames.length > 0 ? 'yes' : 'no',
            highestPlan,
            latestExpiry,
            ownerUsername,
        ]
    );
}

export { syncBranchOwnerLegacySummary };

/**
 * Admin: set an absolute expiry datetime for a branch plan row.
 * Also refreshes status to active/expired based on the new date.
 */
export async function updatePlanExpiryByAdmin({
    branchId,
    subscriptionId,
    expiresAt,
    adminUsername = null,
    connection = null,
}) {
    if (!branchId) throw new Error('branch_id is required');
    if (!subscriptionId) throw new Error('subscription_id is required');

    const expiryDate = new Date(expiresAt);
    if (Number.isNaN(expiryDate.getTime())) {
        throw new Error('Invalid expires_at datetime');
    }

    const ownsConnection = !connection;
    const conn = connection || await pool.getConnection();

    try {
        if (ownsConnection) {
            await conn.beginTransaction();
        }

        const [rows] = await conn.query(
            `SELECT id, subscription_id, plan_name, expires_at, status
             FROM user_subscriptions
             WHERE branch_id = ? AND subscription_id = ?
             LIMIT 1
             FOR UPDATE`,
            [branchId, subscriptionId]
        );

        if (!rows.length) {
            const err = new Error('Subscription not found for this branch');
            err.statusCode = 404;
            throw err;
        }

        const nextStatus = isPlanActive(expiryDate) ? 'active' : 'expired';
        const remark = adminUsername
            ? `Admin ${adminUsername} set expiry`
            : 'Admin set expiry';

        await conn.query(
            `UPDATE user_subscriptions
             SET expires_at = ?,
                 status = ?,
                 payment_method = 'admin_manual',
                 payment_ref = ?,
                 modify_date = NOW()
             WHERE id = ?`,
            [expiryDate, nextStatus, remark, rows[0].id]
        );

        await syncBranchOwnerLegacySummary(branchId, conn);

        if (ownsConnection) {
            await conn.commit();
        }

        return {
            subscription_id: rows[0].subscription_id,
            plan_name: rows[0].plan_name,
            previous_expires_at: rows[0].expires_at,
            expires_at: expiryDate,
            status: nextStatus,
        };
    } catch (error) {
        if (ownsConnection) {
            await conn.rollback();
        }
        throw error;
    } finally {
        if (ownsConnection) {
            conn.release();
        }
    }
}

export async function getSubscriptionStatus(branchId, connection = null) {
    if (!branchId) {
        return emptyStatus();
    }

    const runner = connection || pool;
    const [rows] = await runner.query(
        `SELECT plan_name, billing_cycle, expires_at, status, payment_method, payment_ref, username
         FROM user_subscriptions
         WHERE branch_id = ?
         ORDER BY plan_name ASC`,
        [branchId]
    );

    const now = Date.now();
    const active_plans = rows.map((row) => {
        const expiresAt = row.expires_at;
        const active = isPlanActive(expiresAt);
        const diffMs = new Date(expiresAt).getTime() - now;
        const days_remaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

        return {
            plan_name: row.plan_name,
            billing_cycle: row.billing_cycle,
            expires_at: expiresAt,
            is_active: active,
            is_expired: !active,
            days_remaining: active ? days_remaining : 0,
            status: active ? 'active' : 'expired',
            payment_method: row.payment_method,
            purchased_by: row.username,
        };
    });

    const activeNames = active_plans.filter((plan) => plan.is_active).map((plan) => plan.plan_name);
    const features = buildFeatureAccess(activeNames);
    const highestPlan = getHighestPlanTier(activeNames) || 'None';
    const latestActiveExpiry = active_plans
        .filter((plan) => plan.is_active)
        .map((plan) => new Date(plan.expires_at))
        .sort((a, b) => b.getTime() - a.getTime())[0] || null;

    return {
        branch_id: branchId,
        is_subscribed: activeNames.length > 0 ? 'yes' : 'no',
        subscription_plan: highestPlan,
        subscription_expires_at: latestActiveExpiry,
        is_expired: activeNames.length === 0,
        effective_plan_source: 'branch',
        active_plans,
        features,
    };
}

/**
 * Activate (or replace) a plan for a branch.
 * Plans do NOT stack/extend: expiry is always now + billing period
 * (or an absolute expiresAt when provided).
 */
export async function activatePlan({
    branchId,
    username,
    planName,
    billingCycle = 'monthly',
    paymentRef = null,
    paymentMethod = 'wallet',
    expiresAt = null,
    connection = null,
}) {
    if (!branchId) {
        throw new Error('branch_id is required');
    }

    if (!VALID_PLANS.includes(planName)) {
        throw new Error('Invalid plan name');
    }

    const cycle = billingCycle === 'yearly' ? 'yearly' : 'monthly';
    const subscriptionDays = getSubscriptionDays(cycle);
    const now = new Date();

    let expiryDate;
    if (expiresAt != null && expiresAt !== '') {
        expiryDate = new Date(expiresAt);
        if (Number.isNaN(expiryDate.getTime())) {
            throw new Error('Invalid expires_at datetime');
        }
    } else {
        expiryDate = addDays(now, subscriptionDays);
    }

    const ownsConnection = !connection;
    const conn = connection || await pool.getConnection();

    try {
        if (ownsConnection) {
            await conn.beginTransaction();
        }

        const [existing] = await conn.query(
            `SELECT id, subscription_id, expires_at
             FROM user_subscriptions
             WHERE branch_id = ? AND plan_name = ?
             LIMIT 1
             FOR UPDATE`,
            [branchId, planName]
        );

        const nextStatus = isPlanActive(expiryDate) ? 'active' : 'expired';
        let subscriptionId;

        if (existing.length > 0) {
            subscriptionId = existing[0].subscription_id;
            await conn.query(
                `UPDATE user_subscriptions
                 SET billing_cycle = ?,
                     expires_at = ?,
                     payment_ref = ?,
                     payment_method = ?,
                     username = ?,
                     status = ?,
                     modify_date = NOW()
                 WHERE id = ?`,
                [
                    cycle,
                    expiryDate,
                    paymentRef,
                    paymentMethod,
                    username,
                    nextStatus,
                    existing[0].id,
                ]
            );
        } else {
            subscriptionId = newSubscriptionId();
            await conn.query(
                `INSERT INTO user_subscriptions (
                    subscription_id, branch_id, username, plan_name, billing_cycle,
                    expires_at, payment_ref, payment_method, status
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    subscriptionId,
                    branchId,
                    username,
                    planName,
                    cycle,
                    expiryDate,
                    paymentRef,
                    paymentMethod,
                    nextStatus,
                ]
            );
        }

        await syncBranchOwnerLegacySummary(branchId, conn);

        if (ownsConnection) {
            await conn.commit();
        }

        return {
            branch_id: branchId,
            subscription_id: subscriptionId,
            plan_name: planName,
            billing_cycle: cycle,
            expires_at: expiryDate,
            status: nextStatus,
            starts_from: now,
            days_added: expiresAt ? null : subscriptionDays,
            replaced_existing: existing.length > 0,
        };
    } catch (error) {
        if (ownsConnection) {
            await conn.rollback();
        }
        throw error;
    } finally {
        if (ownsConnection) {
            conn.release();
        }
    }
}

/** @deprecated Use activatePlan — kept for callers; does not extend remaining days. */
export async function activateOrExtendPlan(args) {
    return activatePlan(args);
}

/**
 * Admin assigns a plan to a branch without payment gateway.
 */
export async function assignPlanByAdmin({
    branchId,
    planName,
    billingCycle = 'monthly',
    expiresAt = null,
    adminUsername = null,
    connection = null,
}) {
    if (!branchId) throw new Error('branch_id is required');
    if (!VALID_PLANS.includes(planName)) {
        const err = new Error('Invalid planName. Must be Business, BusinessPlus, or BusinessPro.');
        err.statusCode = 400;
        throw err;
    }

    const ownerUsername = await getBranchOwnerUsername(branchId, connection);
    const username = ownerUsername || adminUsername || 'admin';

    let normalizedExpiry = expiresAt;
    if (expiresAt && /^\d{4}-\d{2}-\d{2}$/.test(String(expiresAt).trim())) {
        normalizedExpiry = `${String(expiresAt).trim()}T23:59:59`;
    }

    return activatePlan({
        branchId,
        username,
        planName,
        billingCycle,
        expiresAt: normalizedExpiry,
        paymentRef: adminUsername
            ? `admin_manual_${adminUsername}_${Date.now()}`
            : `admin_manual_${Date.now()}`,
        paymentMethod: 'admin_manual',
        connection,
    });
}

export function hasFeatureAccess(status, feature) {
    if (!status) return false;
    if (status.features?.[feature]) return true;

    const activeNames = (status.active_plans || [])
        .filter((plan) => plan.is_active)
        .map((plan) => plan.plan_name);
    const features = buildFeatureAccess(activeNames);

    if (feature === 'core') return features.core;
    if (feature === 'salary-management') return features['salary-management'];
    if (feature === 'live-chat') return features['live-chat'];
    return features.core;
}
