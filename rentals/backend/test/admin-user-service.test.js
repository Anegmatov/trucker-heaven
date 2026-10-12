const assert = require("node:assert/strict");
const test = require("node:test");
const { ROLES, controlledConflict, safeAccount } = require("../services/adminUserService");

test("employee account safe projection excludes password and session secrets", () => {
  const account = safeAccount({ id: 9, email: "staff@example.test", role: "STAFF", is_active: true, account_version: 2, active_session_count: 3, password_hash: "must-not-leak" });
  assert.deepEqual(account, { id: 9, email: "staff@example.test", role: "STAFF", isActive: true, lastLoginAt: undefined, activeSessionCount: 3, accountVersion: 2 });
  assert.equal(Object.hasOwn(account, "password_hash"), false);
  assert.deepEqual(ROLES, ["OWNER", "STAFF"]);
});

test("controlled employee conflicts have safe explicit codes", () => {
  const error = controlledConflict("LAST_ACTIVE_OWNER_REQUIRED", "At least one active Owner account is required.");
  assert.equal(error.statusCode, 409);
  assert.equal(error.code, "LAST_ACTIVE_OWNER_REQUIRED");
});
