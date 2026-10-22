# Wallet & Razorpay platform — Server context

> **Purpose:** Tag when changing wallet balance/recharge, payment requests, banks, or platform Razorpay config/fees. Pair with [`CLIENT/context/wallet.md`](../../CLIENT/context/wallet.md) and [`ADMIN/context/wallet-payments.md`](../../ADMIN/context/wallet-payments.md).

---

## Mental model

```
platform_settings RAZORPAY_* → keys, status, fee % / flat (helpers/razorpayConfig.js, walletPaymentConfig.js)
wallet_* / razorpay_orders   → gateway recharge
wallet_payment_banks         → admin banks for manual transfer
wallet_payment_requests      → user UTR requests (approve → credit, no fee)
```

Key areas: `routes` / `routes_admin` wallet + razorpay modules, `helpers` for fee/config, webhook in `routes/webhook.js` (orders verified against DB config keys).

---

## Rules

- Gateway fee from platform config on Razorpay recharge path.
- **Payment request approval credits wallet without gateway fee.**
- Razorpay keys and fees are platform settings (`platform_settings`), never hardcoded or env-only; see `context/platform-settings.md`.

---

## Migrations (examples)

- `20260921_wallet_gateway_fee_and_payment_requests.sql`
- `20260921_*razorpay*` / purpose→remark wallet column renames
- Scripts under `scripts/run_*wallet*` / `run_razorpay_*`
