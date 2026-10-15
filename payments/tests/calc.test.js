const test = require('node:test');
const assert = require('node:assert/strict');
const { splitPayment, cancellationRefund, depositRemaining, calcCommission } = require('../utils/calc');

const HOUR = 36e5;
const start = new Date('2026-11-10T09:00:00Z');
const base = { rentalAmount: 5000000, ownerEarning: 4500000, depositAmount: 2000000, startDate: start };

test('commission is 10% of rental only, never of deposit', () => {
  const s = splitPayment({ rentalAmount: 5000000, depositAmount: 2000000 }, 0.1);
  assert.equal(s.commissionAmount, 500000);
  assert.equal(s.ownerEarning, 4500000);
  assert.equal(s.totalAmount, 7000000);
  assert.equal(s.commissionAmount + s.ownerEarning, s.rentalAmount);
});

test('commission rounds to an integer and split always adds up', () => {
  for (const rental of [1, 33, 12345, 999999, 1500001]) {
    const s = splitPayment({ rentalAmount: rental, depositAmount: 0 }, 0.1);
    assert.ok(Number.isInteger(s.commissionAmount));
    assert.equal(s.commissionAmount + s.ownerEarning, rental);
  }
  assert.equal(calcCommission(100000, 0.075), 7500);
});

test('renter cancels 72h before start -> full rental + deposit back', () => {
  const r = cancellationRefund({ ...base, cancelledAt: new Date(start - 72 * HOUR), cancelledBy: 'renter' });
  assert.equal(r.refundRental, 5000000);
  assert.equal(r.refundDeposit, 2000000);
  assert.equal(r.refundTotal, 7000000);
  assert.equal(r.ownerEarningReversal, 4500000);
  assert.equal(r.commissionReversal, 500000);
});

test('renter cancels 30h before start -> 50% rental, full deposit', () => {
  const r = cancellationRefund({ ...base, cancelledAt: new Date(start - 30 * HOUR), cancelledBy: 'renter' });
  assert.equal(r.refundRental, 2500000);
  assert.equal(r.refundDeposit, 2000000);
  assert.equal(r.ownerEarningReversal, 2250000);
  assert.equal(r.ownerEarningReversal + r.commissionReversal, r.refundRental);
});

test('renter cancels 5h before start -> no rental refund, deposit still back', () => {
  const r = cancellationRefund({ ...base, cancelledAt: new Date(start - 5 * HOUR), cancelledBy: 'renter' });
  assert.equal(r.refundRental, 0);
  assert.equal(r.refundDeposit, 2000000);
  assert.equal(r.ownerEarningReversal, 0);
});

test('owner cancels any time before start -> full refund', () => {
  const r = cancellationRefund({ ...base, cancelledAt: new Date(start - 1 * HOUR), cancelledBy: 'owner' });
  assert.equal(r.refundTotal, 7000000);
});

test('boundary: exactly 48h and exactly 24h', () => {
  assert.equal(cancellationRefund({ ...base, cancelledAt: new Date(start - 48 * HOUR) }).rate, 1);
  assert.equal(cancellationRefund({ ...base, cancelledAt: new Date(start - 24 * HOUR) }).rate, 0.5);
});

test('after start the deposit is NOT refunded via cancellation', () => {
  const r = cancellationRefund({ ...base, cancelledAt: new Date(+start + HOUR), cancelledBy: 'renter' });
  assert.equal(r.refundDeposit, 0);
  assert.equal(r.refundRental, 0);
});

test('depositRemaining', () => {
  assert.equal(depositRemaining({ amount: 1000, deductedAmount: 300, releasedAmount: 0 }), 700);
  assert.equal(depositRemaining({ amount: 1000 }), 1000);
});
