const express = require("express");
const defaultDatabase = require("../db/connection");
const { requireAdminSession, requireCsrf, requireRole } = require("../middleware/requireAdmin");
const { listAdminUsers, mutateAdminUser } = require("../services/adminUserService");
const { logFailure } = require("../utils/safeLog");

function createAdminUsersRouter({ database = defaultDatabase } = {}) {
  const router = express.Router();
  router.get("/users", requireAdminSession, requireRole("OWNER"), async (_req, res) => {
    try { return res.json({ users: await listAdminUsers(database) }); }
    catch (error) { logFailure("admin.users.list", error); return res.status(500).json({ error: "Failed to load employee accounts" }); }
  });
  const operations = { "change-role": "CHANGE_ROLE", disable: "DISABLE", enable: "ENABLE", "revoke-sessions": "REVOKE_SESSIONS" };
  router.post("/users/:userId/operations/:operation", requireAdminSession, requireRole("OWNER"), requireCsrf, async (req, res) => {
    const operation = operations[String(req.params.operation || "").toLowerCase()];
    if (!operation) return res.status(404).json({ error: "Employee account operation was not found" });
    try {
      const result = await mutateAdminUser({ database, actor: req.admin, userId: req.params.userId, operation, expectedAccountVersion: req.body?.expectedAccountVersion, role: req.body?.role });
      return res.json(result);
    } catch (error) {
      if ([400, 404, 409].includes(error.statusCode)) return res.status(error.statusCode).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      logFailure("admin.users.mutate", error); return res.status(500).json({ error: "Employee account operation failed" });
    }
  });
  return router;
}
const router = createAdminUsersRouter();
module.exports = router;
module.exports.createAdminUsersRouter = createAdminUsersRouter;
