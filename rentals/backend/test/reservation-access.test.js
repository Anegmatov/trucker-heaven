const assert = require("node:assert/strict");
const test = require("node:test");
const { issueToken, tokenHash } = require("../services/reservationAccessService");
const { createReservationAccessRouter } = require("../routes/reservationAccess");

test("reservation access tokens have 256-bit entropy and SHA-256 storage representation", () => {
  const token = issueToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(tokenHash(token).length, 64);
  assert.notEqual(tokenHash(token), token);
});

test("reservation access router separates public lookup from authenticated administration mounts", () => {
  const database = { query: async () => ({ rows: [], rowCount: 0 }) };
  const publicPaths = createReservationAccessRouter({ database, includeAdmin: false }).stack.map((layer) => layer.route?.path).filter(Boolean);
  const adminPaths = createReservationAccessRouter({ database, includePublic: false }).stack.map((layer) => layer.route?.path).filter(Boolean);
  assert.deepEqual(publicPaths, [
    "/reservation-access",
    "/reservation-access/find",
    "/reservation-access/cancel",
    "/reservation-access/documents",
    "/reservation-access/documents/:documentType",
    "/reservation-access/documents/:documentType/download"
  ]);
  assert.deepEqual(adminPaths, [
    "/admin/reservations/:id/access/:action",
    "/admin/reservations/:id/documents",
    "/admin/reservations/:id/documents/:documentId/download",
    "/admin/reservations/:id/documents/:documentId/approve",
    "/admin/reservations/:id/documents/:documentId/reject"
  ]);
});

test("email + phone lookup grants are signed, time-limited and reservation-bound", () => {
  const { issueGrant, verifyGrant } = require("../utils/accessGrant");
  const grant = issueGrant(42, { now: 1_000_000_000_000 });
  assert.equal(verifyGrant(grant, { now: 1_000_000_000_000 }), 42);
  assert.equal(verifyGrant(grant, { now: 1_000_000_000_000 + 25 * 3600 * 1000 }), null, "expires after 24h");
  assert.equal(verifyGrant(grant.replace(/\.42\./, ".43."), { now: 1_000_000_000_000 }), null, "id is covered by the signature");
  assert.equal(verifyGrant(grant.slice(0, -1) + (grant.endsWith("A") ? "B" : "A"), { now: 1_000_000_000_000 }), null);
});
