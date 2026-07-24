# Branch subscriptions — Server context

> **Purpose:** Tag when changing plan activation, admin manual assign, or middleware entitlement checks. Pair with [`CLIENT/context/subscription.md`](../../CLIENT/context/subscription.md).

---

## Mental model

```
Source of truth: user_subscriptions (unique branch_id + plan_name)
        ↓
getSubscriptionStatus(branchId)  →  active_plans / features / highest plan
        ↓
checkSubscription → requirePlan / requireFeature
```

**Do not** validate access from `users.is_subscribed` / `subscription_plan` / `subscription_expires_at`. Those columns are a **legacy mirror** only (`syncBranchOwnerLegacySummary`).

**Service:** `SERVER/services/subscriptionService.js`  
**Client pay routes:** `SERVER/routes/subscription.js`  
**Admin routes:** `SERVER/routes_admin/branch.js`  
**Middleware:** `SERVER/middleware/auth.js`

---

## Plans do not extend

`activatePlan` (alias `activateOrExtendPlan`) always sets expiry from **now + billing period** (or an absolute `expiresAt`). It **replaces** the existing row for that `(branch_id, plan_name)` — it does **not** stack remaining days.

Billing days: monthly = 30, yearly = 365.

---

## Admin manual assign (no payment)

| Method | Path | Body |
|--------|------|------|
| GET | `/admin/branch/:branch_id/subscriptions` | — |
| POST | `/admin/branch/:branch_id/subscriptions` | `{ plan_name, billing_cycle?, expires_at? }` |
| PATCH | `/admin/branch/:branch_id/subscriptions/:subscription_id/expiry` | `{ expires_at }` |

- `plan_name`: `Business` \| `BusinessPlus` \| `BusinessPro`
- `payment_method`: `admin_manual`
- Service: `assignPlanByAdmin` / `updatePlanExpiryByAdmin`

---

## Client purchase flow

| Method | Path | Notes |
|--------|------|------|
| POST | `/subscription/create-checkout` | Razorpay order |
| POST | `/subscription/verify-payment` | Signature + fulfill |
| POST | `/subscription/pay-from-wallet` | Debit wallet + `activatePlan` |
| GET | `/subscription/status` | Branch status for UI |

Fulfillment also via `razorpayWebhookService` → `activatePlan`.

---

## Middleware rules

`checkSubscription`:

1. Requires `username` + **branch** (`req.branch_id` or `branch` header / `branch_id` query).
2. Loads `req.subscription = await getSubscriptionStatus(branchId)` only.
3. Does **not** read `users.*` subscription columns.

`requirePlan(allowedPlans)` / `requireFeature(featureKey)`:

- Deny if no active plans (`expires_at > now`).
- Features: `core` (any paid), `salary-management` / `attendance-management` (Plus|Pro), `live-chat` (Pro).

---

## Valid plans / tiers

```js
VALID_PLANS = ['Business', 'BusinessPlus', 'BusinessPro']
PLAN_TIER   = { Business: 1, BusinessPlus: 2, BusinessPro: 3 }
```

Highest active tier drives `subscription_plan` summary for display.
