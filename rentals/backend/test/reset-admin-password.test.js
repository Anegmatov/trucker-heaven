const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { bcrypt } = require("../services/adminAuthService");
const { main, resetAdminPassword } = require("../scripts/resetAdminPassword");
const { assertCredentialFileProtected } = require("./support/credentialFileAssertion");

function createResetDatabase(users, sessions) {
  const calls = [];
  const database = {
    closed: false,
    released: false,
    connectCalls: 0,
    async connect() {
      database.connectCalls += 1;
      return {
        async query(sql, values = []) {
          calls.push({ sql, values });
          if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
          if (sql.startsWith("SELECT id, email FROM admin_users")) {
            const user = users.find((item) => item.email.toLowerCase() === values[0]);
            return { rows: user ? [{ id: user.id, email: user.email }] : [], rowCount: user ? 1 : 0 };
          }
          if (sql.startsWith("UPDATE admin_users SET password_hash")) {
            const user = users.find((item) => item.id === values[1]);
            user.password_hash = values[0];
            user.failed_login_attempts = 0;
            user.locked_until = null;
            return { rows: [], rowCount: 1 };
          }
          if (sql.startsWith("UPDATE admin_sessions SET revoked_at")) {
            const revoked = sessions.filter((item) => item.admin_user_id === values[0] && !item.revoked_at);
            revoked.forEach((item) => { item.revoked_at = new Date(); });
            return { rows: revoked.map((item) => ({ id: item.id })), rowCount: revoked.length };
          }
          throw new Error("Unexpected test query");
        },
        release() { database.released = true; }
      };
    },
    async end() { database.closed = true; }
  };
  return { calls, database };
}

async function protectedDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), "driveops-reset-test-"));
}

test("admin password reset updates only an existing admin, clears lockout, and revokes only that admin's sessions", async (t) => {
  const oldPassword = "OldPasswordForReset9";
  const temporaryPassword = "NewPasswordForReset8";
  const users = [
    { id: 1, email: "owner.local@driveops.test", password_hash: await bcrypt.hash(oldPassword, 12), failed_login_attempts: 4, locked_until: new Date() },
    { id: 2, email: "manager.local@driveops.test", password_hash: await bcrypt.hash("ManagerPassword9", 12), failed_login_attempts: 0, locked_until: null }
  ];
  const sessions = [
    { id: 10, admin_user_id: 1, revoked_at: null },
    { id: 11, admin_user_id: 1, revoked_at: null },
    { id: 12, admin_user_id: 2, revoked_at: null }
  ];
  const { database } = createResetDatabase(users, sessions);
  const directory = await protectedDirectory();
  const outputFile = path.join(directory, "owner.txt");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const result = await resetAdminPassword({ database, username: "owner.local@driveops.test", outputFile, passwordFactory: () => temporaryPassword });

  assert.deepEqual(result, { username: "owner.local@driveops.test", sessionsRevoked: 2, outputFile });
  assert.equal(await bcrypt.compare(oldPassword, users[0].password_hash), false);
  assert.equal(await bcrypt.compare(temporaryPassword, users[0].password_hash), true);
  assert.equal(users[0].failed_login_attempts, 0);
  assert.equal(users[0].locked_until, null);
  assert.ok(sessions[0].revoked_at);
  assert.ok(sessions[1].revoked_at);
  assert.equal(sessions[2].revoked_at, null);
  await assertCredentialFileProtected(outputFile);
  assert.equal(await fs.readFile(outputFile, "utf8"), `username=owner.local@driveops.test\ntemporary_password=${temporaryPassword}\n`);
  assert.equal(database.released, true);
});

test("admin password reset refuses missing users and existing credential files without changing sessions", async (t) => {
  const users = [{ id: 2, email: "manager.local@driveops.test", password_hash: "unchanged", failed_login_attempts: 0, locked_until: null }];
  const sessions = [{ id: 12, admin_user_id: 2, revoked_at: null }];
  const { database } = createResetDatabase(users, sessions);
  const directory = await protectedDirectory();
  const missingOutput = path.join(directory, "missing.txt");
  const existingOutput = path.join(directory, "existing.txt");
  await fs.writeFile(existingOutput, "preserve this", { mode: 0o600 });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  await assert.rejects(
    resetAdminPassword({ database, username: "missing.local@driveops.test", outputFile: missingOutput }),
    /No existing admin account/
  );
  assert.equal(sessions[0].revoked_at, null);
  await assert.rejects(
    resetAdminPassword({ database, username: "manager.local@driveops.test", outputFile: existingOutput }),
    /already exists/
  );
  assert.equal(await fs.readFile(existingOutput, "utf8"), "preserve this");
  assert.equal(database.connectCalls, 1);
});

test("operator command never writes the generated password to stdout or stderr and closes the database on success and failure", async (t) => {
  const users = [{ id: 1, email: "owner.local@driveops.test", password_hash: await bcrypt.hash("OldPasswordForReset9", 12), failed_login_attempts: 1, locked_until: null }];
  const sessions = [{ id: 10, admin_user_id: 1, revoked_at: null }];
  const success = createResetDatabase(users, sessions);
  const directory = await protectedDirectory();
  const outputFile = path.join(directory, "success.txt");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const stdout = { text: "", write(value) { this.text += value; } };
  const stderr = { text: "", write(value) { this.text += value; } };

  await main({ argv: ["--username", "owner.local@driveops.test", "--output-file", outputFile], database: success.database, stdout, stderr });
  const password = (await fs.readFile(outputFile, "utf8")).match(/^temporary_password=(.+)$/m)[1];
  assert.equal(stdout.text.includes(password), false);
  assert.equal(stderr.text.includes(password), false);
  assert.equal(success.database.closed, true);

  const failure = createResetDatabase([], []);
  const failureOutput = path.join(directory, "failure.txt");
  await assert.rejects(
    main({ argv: ["--username", "missing.local@driveops.test", "--output-file", failureOutput], database: failure.database, stdout: { write() {} }, stderr: { write() {} } }),
    /No existing admin account/
  );
  assert.equal(failure.database.closed, true);
  await assert.rejects(fs.stat(failureOutput));
});
