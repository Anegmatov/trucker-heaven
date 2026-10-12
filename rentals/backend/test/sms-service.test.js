const assert = require("node:assert/strict");
const test = require("node:test");

const { createSmsService } = require("../services/smsService");

test("SMS provider requests have a bounded timeout and log no phone or message body", async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...values) => errors.push(values.join(" "));
  try {
    const service = createSmsService({
      enabled: true,
      accountSid: "AC_test",
      authToken: "test-token",
      fromNumber: "+15550000000",
      timeoutMs: 25,
      fetchImpl: () => new Promise(() => undefined)
    });
    const startedAt = Date.now();
    const result = await service.sendSms("+16155551234", "private reservation message");
    assert.equal(result.status, "failed");
    assert.equal(result.ambiguous, true);
    assert.equal(result.code, "DELIVERY_OUTCOME_UNKNOWN");
    assert.ok(Date.now() - startedAt < 500);
    const output = errors.join(" ");
    assert.doesNotMatch(output, /16155551234|private reservation message/);
  } finally {
    console.error = originalError;
  }
});
