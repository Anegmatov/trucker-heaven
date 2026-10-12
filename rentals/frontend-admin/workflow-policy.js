(function adminWorkflowPolicyScope(root, factory) {
  const policy = factory();
  if (typeof module === "object" && module.exports) module.exports = policy;
  else root.AdminWorkflowPolicy = Object.freeze(policy);
})(typeof globalThis === "object" ? globalThis : this, function createAdminWorkflowPolicy() {
  "use strict";

  const MUTATING_ROLES = Object.freeze(["OWNER", "STAFF"]);
  const actions = Object.freeze({
    PENDING_REQUEST: Object.freeze(["CONFIRMED", "DECLINED", "CANCELLED"]),
    CONFIRMED: Object.freeze(["READY_FOR_PICKUP", "CANCELLED", "NO_SHOW"]),
    READY_FOR_PICKUP: Object.freeze(["CHECKED_OUT", "CANCELLED", "NO_SHOW"]),
    CHECKED_OUT: Object.freeze(["RETURNED_PENDING_INSPECTION"]),
    RETURNED_PENDING_INSPECTION: Object.freeze(["COMPLETED"])
  });

  function normalizeRole(role) {
    return String(role || "").trim().toUpperCase();
  }

  function canMutate(role) {
    return MUTATING_ROLES.includes(normalizeRole(role));
  }

  function canConfigure(role) {
    return normalizeRole(role) === "OWNER";
  }

  function accessBadge(role) {
    switch (normalizeRole(role)) {
      case "OWNER":
        return Object.freeze({ label: "Owner access", readOnly: false });
      case "STAFF":
        return Object.freeze({ label: "Operations access", readOnly: false });
      default:
        return Object.freeze({ label: "Read-only access", readOnly: true });
    }
  }

  function reservationActions(status, role) {
    if (!canMutate(role)) return [];
    return [...(actions[String(status || "").trim().toUpperCase()] || [])];
  }

  function failureBehavior(status) {
    if (status === 401) return { clearSession: true, refresh: false, kind: "authentication" };
    if (status === 403) return { clearSession: false, refresh: false, kind: "permission" };
    if (status === 404) return { clearSession: false, refresh: true, kind: "missing" };
    if (status === 409) return { clearSession: false, refresh: true, kind: "conflict" };
    if (status === 400) return { clearSession: false, refresh: false, kind: "validation" };
    return { clearSession: false, refresh: false, kind: "temporary" };
  }

  return { MUTATING_ROLES, accessBadge, canConfigure, canMutate, failureBehavior, normalizeRole, reservationActions };
});
