const { writeAudit } = require("./adminAuthService");

const ROLES = Object.freeze(["OWNER", "STAFF"]);
const ADMIN_ACCOUNT_MUTATION_LOCK = 710947228;

function controlledConflict(code, message) {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = code;
  return error;
}
function validationError(message) { const error = new Error(message); error.statusCode = 400; error.code = "ADMIN_ACCOUNT_STATE_CONFLICT"; return error; }
function safeAccount(row) {
  return { id: row.id, email: row.email, role: row.role, isActive: Boolean(row.is_active), lastLoginAt: row.last_login_at, activeSessionCount: Number(row.active_session_count || 0), accountVersion: Number(row.account_version) };
}

async function listAdminUsers(database) {
  const result = await database.query(
    `SELECT u.id, u.email, u.role, u.is_active, u.last_login_at, u.account_version,
       COUNT(s.id) FILTER (WHERE s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP)::integer AS active_session_count
     FROM admin_users u LEFT JOIN admin_sessions s ON s.admin_user_id = u.id
     GROUP BY u.id ORDER BY LOWER(u.email) ASC`
  );
  return result.rows.map(safeAccount);
}

async function targetForUpdate(client, userId) {
  const result = await client.query("SELECT id, email, role, is_active, account_version FROM admin_users WHERE id = $1 FOR UPDATE", [userId]);
  if (!result.rowCount) { const error = new Error("Employee account not found"); error.statusCode = 404; throw error; }
  return result.rows[0];
}
async function activeOwnerCount(client) {
  const result = await client.query("SELECT id FROM admin_users WHERE is_active AND role = 'OWNER' FOR UPDATE");
  return result.rowCount;
}
function assertVersion(target, expected) {
  if (!Number.isInteger(Number(expected)) || Number(expected) !== Number(target.account_version)) throw controlledConflict("ADMIN_ACCOUNT_STATE_CONFLICT", "Employee account changed. Refresh and try again.");
}
function assertNotSelf(actor, target) {
  if (Number(actor.id) === Number(target.id)) throw controlledConflict("SELF_ACCOUNT_OPERATION_NOT_ALLOWED", "You cannot manage your own account from this screen.");
}
async function revokeTargetSessions(client, userId) {
  const result = await client.query("UPDATE admin_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE admin_user_id = $1 AND revoked_at IS NULL RETURNING id", [userId]);
  return result.rowCount;
}

async function mutateAdminUser({ database, actor, userId, operation, expectedAccountVersion, role }) {
  const client = await database.connect();
  let begun = false;
  try {
    await client.query("BEGIN"); begun = true;
    // A single transaction-scoped advisory lock gives every account-state
    // mutation one lock order before a target row or active OWNER rows are read.
    // This prevents two valid concurrent operations from removing both owners.
    await client.query("SELECT pg_advisory_xact_lock($1)", [ADMIN_ACCOUNT_MUTATION_LOCK]);
    const target = await targetForUpdate(client, userId);
    assertVersion(target, expectedAccountVersion);
    const name = String(operation || "").toUpperCase();
    if (!["CHANGE_ROLE", "DISABLE", "ENABLE", "REVOKE_SESSIONS"].includes(name)) throw validationError("Unknown employee account operation");
    const nextRole = name === "CHANGE_ROLE" ? String(role || "").trim().toUpperCase() : null;
    if (name === "CHANGE_ROLE" && !ROLES.includes(nextRole)) throw validationError("Role must be OWNER or STAFF");
    if (["CHANGE_ROLE", "DISABLE", "REVOKE_SESSIONS"].includes(name)) assertNotSelf(actor, target);
    if ((name === "DISABLE" || name === "CHANGE_ROLE") && target.is_active && target.role === "OWNER" && (name === "DISABLE" || nextRole !== "OWNER") && await activeOwnerCount(client) <= 1) {
      throw controlledConflict("LAST_ACTIVE_OWNER_REQUIRED", "At least one active Owner account is required.");
    }
    let sessionsRevoked = 0;
    if (name === "CHANGE_ROLE") {
      if (nextRole !== target.role) {
        sessionsRevoked = await revokeTargetSessions(client, target.id);
        await client.query("UPDATE admin_users SET role = $1, account_version = account_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [nextRole, target.id]);
      }
    } else if (name === "DISABLE") {
      if (target.is_active) {
        sessionsRevoked = await revokeTargetSessions(client, target.id);
        await client.query("UPDATE admin_users SET is_active = FALSE, disabled_at = CURRENT_TIMESTAMP, disabled_by_admin_user_id = $1, account_version = account_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [actor.id, target.id]);
      }
    } else if (name === "ENABLE") {
      if (!target.is_active) await client.query("UPDATE admin_users SET is_active = TRUE, disabled_at = NULL, disabled_by_admin_user_id = NULL, account_version = account_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [target.id]);
    } else {
      sessionsRevoked = await revokeTargetSessions(client, target.id);
    }
    await writeAudit(client, actor.id, `ADMIN_USER_${name}`, "ADMIN_USER", target.id, { targetUserId: target.id, ...(name === "CHANGE_ROLE" ? { role: String(role).trim().toUpperCase() } : {}), ...(sessionsRevoked ? { sessionsRevoked } : {}) });
    const updated = await client.query("SELECT id, email, role, is_active, last_login_at, account_version, 0::integer AS active_session_count FROM admin_users WHERE id = $1", [target.id]);
    await client.query("COMMIT"); begun = false;
    return { user: safeAccount(updated.rows[0]), sessionsRevoked };
  } catch (error) { if (begun) await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

module.exports = { ADMIN_ACCOUNT_MUTATION_LOCK, ROLES, controlledConflict, listAdminUsers, mutateAdminUser, safeAccount };
