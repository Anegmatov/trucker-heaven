const test = require("node:test");
const assert = require("node:assert/strict");
const { summarize } = require("../services/rentalCounterService");

test("rental balance adds extra charges and subtracts payments and refunds", () => {
  const ledger = summarize({ estimatedtotal: "180.00", depositamount: "200.00" },
    [{ amount_cents: 2500 }, { amount_cents: -1000 }],
    [{ kind: "PAYMENT", amount_cents: 15000 }, { kind: "REFUND", amount_cents: 500 }, { kind: "DEPOSIT", amount_cents: 20000 }, { kind: "DEPOSIT_REFUND", amount_cents: 5000 }]);
  assert.deepEqual(ledger, {
    rentalCents: 18000, chargesCents: 1500, totalCents: 19500, paidCents: 14500, balanceCents: 5000,
    depositRequiredCents: 20000, depositHeldCents: 15000, settled: false
  });
});

test("a fully paid rental is settled even with a deposit still held", () => {
  const ledger = summarize({ estimatedtotal: 90, depositamount: 0 }, [], [{ kind: "PAYMENT", amount_cents: 9000 }]);
  assert.equal(ledger.settled, true);
  assert.equal(ledger.balanceCents, 0);
});

test("rental days follow the office clock across daylight saving changes", () => {
  const { calculateDays } = require("../routes/reservations");
  // Sat Oct 31 9:00 AM CDT -> Mon Nov 2 9:00 AM CST is 49 elapsed hours but two rental days.
  assert.equal(calculateDays("2026-10-31T14:00:00.000Z", "2026-11-02T15:00:00.000Z"), 2);
  assert.equal(calculateDays("2026-10-08T14:00:00.000Z", "2026-10-09T15:00:00.000Z"), 2);
  assert.equal(calculateDays("2026-10-08T14:00:00.000Z", "2026-10-09T14:00:00.000Z"), 1);
});
