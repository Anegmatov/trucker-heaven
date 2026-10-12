const transitions = Object.freeze({
  PENDING: new Set(["CONFIRMED", "CANCELLED"]),
  // New orders move directly from accepted to ready. PREPARING remains a
  // read-only legacy state so existing historical orders can still finish.
  CONFIRMED: new Set(["READY", "CANCELLED"]),
  PREPARING: new Set(["READY"]),
  READY: new Set(["COMPLETED"]),
  COMPLETED: new Set(),
  CANCELLED: new Set()
});

function canTransition(from, to) {
  return Boolean(transitions[from]?.has(to));
}

function calculateTotals(items, taxBasisPoints = 0) {
  const subtotalCents = items.reduce((sum, item) => sum + (item.unitPriceCents + (item.modifierTotalCents || 0)) * item.quantity, 0);
  const taxCents = Math.round((subtotalCents * taxBasisPoints) / 10000);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

function publicOrderNumber(now = new Date(), random = require("node:crypto").randomBytes(3).toString("hex").toUpperCase()) {
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `FO-${date}-${random}`;
}

module.exports = { transitions, canTransition, calculateTotals, publicOrderNumber };
