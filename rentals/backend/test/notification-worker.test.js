const assert = require("node:assert/strict");
const test = require("node:test");
const { backoffMs, renderTemplate, workerConfig } = require("../services/notificationWorker");
const { TEMPLATE_KEYS, eventKey, sha256 } = require("../services/notificationOutboxService");

test("notification event keys are deterministic and content hashes do not retain message content", () => {
  assert.equal(eventKey(42, "RESERVATION_CONFIRMED", 3), "reservation:42:RESERVATION_CONFIRMED:3");
  assert.equal(sha256("template-only").length, 64);
  assert.notEqual(sha256("template-only"), "template-only");
});

test("worker retry backoff is bounded and configuration rejects unsafe values", () => {
  const config = { initialDelayMs: 100, maxDelayMs: 500 };
  assert.equal(backoffMs(1, config), 100);
  assert.equal(backoffMs(2, config), 200);
  assert.equal(backoffMs(8, config), 500);
  assert.throws(() => workerConfig({ NOTIFICATION_MAX_ATTEMPTS: "0" }), /NOTIFICATION_MAX_ATTEMPTS/);
});

test("only known templates render and reservation phone is resolved at sending time", () => {
  const reservation = { customerphone: "+16155550199", pickupat: "2030-01-01T10:00:00Z", returnat: "2030-01-02T10:00:00Z", year: 2030, make: "Test", model: "Car" };
  const rendered = renderTemplate(TEMPLATE_KEYS.CUSTOMER_REQUEST_RECEIVED, reservation);
  assert.equal(rendered.destination, reservation.customerphone);
  assert.match(rendered.body, /received your reservation request/);
  assert.equal(renderTemplate("UNRECOGNIZED_TEMPLATE", reservation), null);
});
