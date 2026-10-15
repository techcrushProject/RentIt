# RentIt - Payment & Deposit module

Covers everything under "Payment & Deposit Module" plus the pieces the Damage Claim module plugs into:
rental payment processing, security deposit collection/hold/release/deduction, platform commission,
owner payouts, refund processing, digital wallet (with append-only ledger).

Frontend contract: **docs/PAYMENTS_API.md**

## Install (3 steps)

1. Copy this folder into the backend (e.g. `src/payments/`). No new npm packages needed (Express + Mongoose + Node 18+).
2. In `app.js`:
   ```js
   const { createPaymentsRouter, startDepositScheduler } = require('./payments');

   // capture raw body so webhook signatures can be verified
   app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

   app.use('/api', createPaymentsRouter({ protect }));  // protect = existing JWT middleware (sets req.user)
   startDepositScheduler();                             // optional: auto-release unclaimed deposits
   ```
   `req.user` needs `_id` (or `id`), `role`, `email`. Role strings are matched loosely (`Renter`, `EquipmentOwner`, `owner`, `Admin`...).
3. Map the Booking schema in `config.js -> booking.fields` (field names, payable statuses, naira vs kobo). This is the only coupling to the Booking module.

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `PAYMENT_PROVIDER` | `demo` | `demo` or `paystack` |
| `PAYSTACK_SECRET_KEY` | - | required for paystack (also signs webhooks) |
| `PAYMENT_WEBHOOK_SECRET` | `demo-webhook-secret` | demo provider webhook HMAC key |
| `PAYMENT_CALLBACK_URL` | `http://localhost:3000/payment/callback` | frontend page the gateway redirects to |
| `PLATFORM_COMMISSION_RATE` | `0.1` | taken from rental amount only, never the deposit |
| `DEPOSIT_AUTO_RELEASE_HOURS` | `48` | after rental end date |
| `CANCEL_FULL_REFUND_HOURS` / `CANCEL_PARTIAL_REFUND_HOURS` / `CANCEL_PARTIAL_REFUND_RATE` | `48` / `24` / `0.5` | |
| `MIN_PAYOUT_AMOUNT` / `MIN_TOPUP_AMOUNT` / `MAX_TOPUP_AMOUNT` | `100000` / `50000` / `100000000` | kobo |
| `CHECKOUT_EXPIRY_MINUTES` | `30` | |

Paystack webhook URL to register: `POST https://<your-domain>/api/payments/webhook`.

## Hooks for other modules

```js
const pay = require('./payments');

// Booking module
await pay.onRentalCompleted(bookingId);                       // owner earning pending -> withdrawable
await pay.refundCancelledBooking(bookingId, req.user);        // after marking the booking cancelled

// Damage Claim module
await pay.lockDepositForClaim(depositId, claimId);            // claim opened: pauses auto-release
await pay.resolveDamageClaim(depositId, { claimId, approvedAmount, reason }); // deduct to owner, rest to renter
await pay.unlockDepositClaim(depositId, claimId);             // claim dropped, no deduction
```
`approvedAmount` is kobo; `0` releases the whole deposit.

## How money moves

```
Renter pays total = rental + deposit
 ├─ deposit            -> Deposit(held)
 ├─ rental × 10%       -> platform commission (Payment.commissionAmount)
 └─ rental × 90%       -> owner wallet.pendingBalance
Rental completed       -> owner pendingBalance -> balance (withdrawable)
Deposit settled        -> renter wallet (release) and/or owner wallet (damage deduction)
Cancellation           -> refund per policy; owner's pending earning reversed proportionally
Owner requests payout  -> wallet.balance debited; admin marks paid (or rejects -> money returned)
```

Safety properties: every wallet movement is an idempotent ledger row (duplicate webhooks / retries can't double-credit),
debits are guarded in the DB query so a balance can't go negative, a booking can only be paid once (unique partial index),
webhook signatures and gateway amounts are verified, and multi-step moves run in a MongoDB transaction when the server supports it
(Atlas does; a standalone local `mongod` falls back to non-transactional).

## Testing

- Run everything: `node --test tests/*.test.js` (no npm install needed; Node 18+).
- The tests run the real services, controllers, routes and role guards against **in-memory stand-ins** for Mongoose and
  Express (`tests/helpers/`). They check the logic: commission and refund maths, double-payment / duplicate-webhook
  protection, wallet balances never going negative, deposit holds / claim locks / deductions, payout flow, webhook
  signatures, role guards, transaction rollback, and 200 randomised rentals where every kobo paid must be accounted for.
- The stand-ins copy how Mongoose is *expected* to behave, so they cannot prove the real Mongoose queries are right.
  Still do one real run against MongoDB (below) before the frontend team depends on it.
- Demo transaction with Postman, no gateway needed: accept a booking → `POST /payments/checkout` →
  `POST /payments/:id/demo-confirm` → `GET /wallet` (owner) shows `pendingBalance` → `POST /deposits/:id/release`
  (owner) → `GET /wallet` (renter) shows the deposit back.

## Not included (by design)

- Automatic bank transfers for payouts: admins mark payouts paid manually. Paystack Transfers can be added in `payout.service.js` later.
- Owner identity/KYC gating on payouts: depends on the User Management module's verification status.
