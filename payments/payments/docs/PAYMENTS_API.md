# RentIt - Payment & Deposit API (for frontend)

Base URL: `/api` · Auth: `Authorization: Bearer <JWT>` on everything except the webhook.

## Rules that apply to EVERY endpoint

1. **Money is always an integer in kobo.** ₦1,500.00 = `150000`. Never send or expect decimals. Format on the client: `(kobo / 100).toLocaleString('en-NG', { style: 'currency', currency: 'NGN' })`.
2. **Response envelope**
   ```json
   { "success": true, "data": { }, "meta": { "page": 1, "limit": 20, "total": 40, "pages": 2 } }
   { "success": false, "error": { "code": "INSUFFICIENT_FUNDS", "message": "Insufficient wallet balance" } }
   ```
   `meta` only appears on list endpoints (`?page=1&limit=20`). Switch UI behaviour on `error.code`, never on `message`.
3. Roles: **renter**, **owner**, **admin**. Wrong role → `403 FORBIDDEN`.

## Statuses

| Thing | Values |
|---|---|
| Payment | `pending` `succeeded` `failed` `expired` `partially_refunded` `refunded` |
| Deposit | `pending` `held` `released` `partially_deducted` `forfeited` |
| Refund | `pending` `processed` `failed` |
| Payout | `requested` `approved` `paid` `rejected` |

## The renter flow (what to build)

1. Booking approved by owner → show **Pay** button.
2. `GET /payments/quote/:bookingId` → show breakdown (rental, deposit, total).
3. User picks card or wallet → `POST /payments/checkout`.
   - `method: "wallet"` → returns a `succeeded` payment immediately. Done.
   - `method: "card"` → returns `checkoutUrl`. `window.location = checkoutUrl`.
4. Gateway redirects back to `PAYMENT_CALLBACK_URL?reference=XXXX`. On that page call
   `GET /payments/verify/:reference` and show success/failed from `data.status`.
5. Show deposit state with `GET /deposits/booking/:bookingId`.

**Demo mode** (no real gateway): the `checkoutUrl` goes straight to the callback page. Call verify as above and it succeeds. Or skip the redirect entirely with `POST /payments/:id/demo-confirm`.

---

## Payments

### `GET /payments/quote/:bookingId` · renter
```json
{ "bookingId": "…", "currency": "NGN", "rentalAmount": 5000000, "depositAmount": 2000000,
  "commissionRate": 0.1, "commissionAmount": 500000, "ownerEarning": 4500000, "totalAmount": 7000000 }
```
The renter is charged `totalAmount`. Don't show `commissionAmount`/`ownerEarning` to renters; show them to owners.

### `POST /payments/checkout` · renter
```json
{ "bookingId": "…", "method": "card" }
```
`method`: `"card"` (default) or `"wallet"`. Returns `201` with the payment object:
`{ _id, reference, status, method, totalAmount, rentalAmount, depositAmount, checkoutUrl, … }`.
Calling again for the same unpaid booking returns the same pending checkout (30 min) instead of duplicating.

Errors: `BOOKING_NOT_PAYABLE` (owner hasn't approved), `ALREADY_PAID`, `INSUFFICIENT_FUNDS` (wallet), `FORBIDDEN` (not the renter).

### `GET /payments/verify/:reference` · authenticated
Re-checks with the gateway and settles. Safe to call repeatedly. Returns the payment.

### `GET /payments/:id` · renter/owner/admin involved · `GET /payments/my?status=&page=&limit=`

### `POST /payments/:id/demo-confirm` · demo provider, non-production only

### `POST /payments/webhook` · public (gateway only - frontend never calls this)

### `GET /payments/admin/summary` · admin
`{ payments, grossRentals, depositsCollected, platformCommission, ownerEarnings, refunded }` - `platformCommission` and `ownerEarnings` are **net of refunds** (a cancelled booking's commission is not counted).

---

## Wallet

### `GET /wallet`
```json
{ "balance": 4500000, "pendingBalance": 0, "currency": "NGN" }
```
`balance` = spendable/withdrawable. `pendingBalance` = owner earnings from paid rentals that are not completed yet.

### `GET /wallet/transactions?page=&limit=&type=`
Each row: `{ direction: "credit"|"debit", bucket, type, amount, balanceAfter, description, createdAt }`.
`type`: `topup` `rental_payment` `owner_earning` `earning_release` `earning_reversal` `deposit_release` `damage_deduction` `refund` `payout` `payout_reversal`.

### `POST /wallet/topup` · renter
```json
{ "amount": 500000 }
```
Min ₦500, max ₦1,000,000. Returns a payment with `checkoutUrl` - same redirect + verify flow as card checkout.

---

## Security deposit

### `GET /deposits/booking/:bookingId` · renter/owner/admin involved
```json
{ "_id": "…", "amount": 2000000, "status": "held", "releaseDueAt": "2026-11-12T09:00:00Z",
  "deductedAmount": 0, "releasedAmount": 0, "claimLock": { "locked": false } }
```
- `held` → platform is holding it.
- `claimLock.locked: true` → a damage claim is open; auto-release is paused.
- `released` → fully back in the renter's wallet. `partially_deducted` → part to owner, rest to renter. `forfeited` → all to owner.
- Unclaimed deposits auto-release to the renter's wallet 48h after the rental end date.

### `POST /deposits/:id/release` · owner/admin
Owner confirms the equipment came back fine → deposit goes to renter's wallet now. Errors: `DEPOSIT_NOT_HELD`, `DEPOSIT_LOCKED_BY_CLAIM`.

### `POST /deposits/:id/deduct` · admin
`{ "amount": 300000, "reason": "Cracked housing" }` - normally the Damage Claim flow does this automatically.

---

## Cancellation refunds

Policy (before rental start): owner/admin cancels → 100% rental · renter ≥48h → 100% · renter 24-48h → 50% · renter <24h → 0%. **The deposit is always fully refunded on a pre-start cancellation.**

### `GET /refunds/preview/:bookingId` - show this BEFORE the user confirms cancelling
```json
{ "cancelledBy": "renter", "rate": 0.5, "reason": "…", "hoursBeforeStart": 30,
  "refundRental": 2500000, "refundDeposit": 2000000, "refundTotal": 4500000 }
```

### `POST /refunds/booking/:bookingId`
`{ "destination": "wallet" }` (default; instant) or `"original"` (back to card; admin processes, status stays `pending`). The booking must already be `cancelled`. Idempotent: calling twice returns the same refund.

### `GET /refunds` (own, or all for admin) · `POST /refunds/:id/process` · admin (gateway refunds)

---

## Owner payouts

### `POST /payouts` · owner
```json
{ "amount": 2000000, "bankName": "GTBank", "bankCode": "058", "accountNumber": "0123456789", "accountName": "Ada Obi" }
```
Min ₦1,000. Money leaves the wallet immediately (status `requested`). `accountNumber` must be 10 digits. Errors: `INSUFFICIENT_FUNDS`, `INVALID_AMOUNT`, `INVALID_BANK_DETAILS`.
Account numbers come back masked (`******6789`).

### `GET /payouts` (own, or all for admin) · `GET /payouts/:id`
### Admin: `PATCH /payouts/:id/approve` · `PATCH /payouts/:id/mark-paid` `{ "transferReference": "…" }` · `PATCH /payouts/:id/reject` `{ "reason": "…" }` (rejecting returns the money to the owner's wallet)

---

## Error codes you should handle

`UNAUTHENTICATED` 401 · `FORBIDDEN` 403 · `INVALID_ID` / `INVALID_AMOUNT` / `INVALID_METHOD` / `INVALID_BANK_DETAILS` / `VALIDATION_ERROR` 400 · `INSUFFICIENT_FUNDS` 402 · `BOOKING_NOT_FOUND` / `PAYMENT_NOT_FOUND` / `DEPOSIT_NOT_FOUND` / `PAYOUT_NOT_FOUND` / `REFUND_NOT_FOUND` 404 · `BOOKING_NOT_PAYABLE` / `ALREADY_PAID` / `BOOKING_NOT_CANCELLED` / `DEPOSIT_NOT_HELD` / `DEPOSIT_LOCKED_BY_CLAIM` / `DEDUCTION_TOO_HIGH` / `INVALID_STATE` / `AMOUNT_MISMATCH` 409 · `GATEWAY_ERROR` 502.
