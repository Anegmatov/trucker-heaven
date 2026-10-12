const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { bcrypt } = require("../services/adminAuthService");
const { createEmployee, main, parseArguments } = require("../scripts/createEmployee");
const { assertCredentialFileProtected } = require("./support/credentialFileAssertion");

function createDatabase(users = [], sessions = []) {
  const database = { closed: false, released: false, connectCalls: 0, queries: [] };
  database.connect = async () => {
    database.connectCalls += 1;
    return {
      async query(sql, values = []) {
        database.queries.push({ sql, values });
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
        if (sql.startsWith("INSERT INTO admin_users")) {
          const [email, passwordHash, role] = values;
          if (users.some((user) => user.email.toLowerCase() === email)) {
            const error = new Error("duplicate");
            error.code = "23505";
            throw error;
          }
          const user = { id: users.length + 1, email, password_hash: passwordHash, role, is_active: true, account_version: 1 };
          users.push(user);
          return { rows: [user], rowCount: 1 };
        }
        throw new Error("Unexpected test query");
      },
      release() { database.released = true; }
    };
  };
  database.end = async () => { database.closed = true; };
  return { database, users, sessions };
}

async function protectedDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), "driveops-create-employee-test-"));
}

test("creates active STAFF accounts with authenticating generated passwords and no sessions", async (t) => {
  const { database, users, sessions } = createDatabase();
  const directory = await protectedDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  for (const [username, role, password] of [["staff.phase7d@driveops.test", "STAFF", "StaffTemporaryPassword7D"]]) {
    const outputFile = path.join(directory, `${role.toLowerCase()}.txt`);
    const result = await createEmployee({ database, username, role, outputFile, passwordFactory: () => password });
    const user = users.find((item) => item.email === username);
    assert.deepEqual(result, { username, role, outputFile });
    assert.equal(user.is_active, true);
    assert.equal(user.account_version > 0, true);
    assert.equal(await bcrypt.compare(password, user.password_hash), true);
    await assertCredentialFileProtected(outputFile);
    assert.equal(await fs.readFile(outputFile, "utf8"), `username=${username}\ntemporary_password=${password}\n`);
  }
  assert.deepEqual(sessions, []);
  assert.equal(database.released, true);
});

test("rejects OWNER, unknown roles, missing arguments, and duplicate usernames without overwriting credentials", async (t) => {
  const directory = await protectedDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  assert.throws(() => parseArguments(["--username", "x@example.test", "--role", "OWNER", "--output-file", path.join(directory, "x")]), /STAFF/);
  assert.throws(() => parseArguments(["--username", "x@example.test", "--role", "AUDITOR", "--output-file", path.join(directory, "x")]), /STAFF/);
  assert.throws(() => parseArguments(["--username", "x@example.test", "--role", "STAFF"]), /output-file/);

  const { database } = createDatabase([{ id: 1, email: "staff.phase7d@driveops.test", password_hash: "unchanged", role: "STAFF", is_active: true, account_version: 1 }]);
  const duplicateFile = path.join(directory, "duplicate.txt");
  await assert.rejects(createEmployee({ database, username: "staff.phase7d@driveops.test", role: "STAFF", outputFile: duplicateFile }), /already exists/);
  await assert.rejects(fs.stat(duplicateFile));

  const existingFile = path.join(directory, "existing.txt");
  await fs.writeFile(existingFile, "preserve this", { mode: 0o600 });
  await assert.rejects(createEmployee({ database, username: "new.phase7d@driveops.test", role: "STAFF", outputFile: existingFile }), /already exists/);
  assert.equal(await fs.readFile(existingFile, "utf8"), "preserve this");
});

test("operator output omits generated passwords and closes the database on success and failure", async (t) => {
  const directory = await protectedDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const success = createDatabase();
  const stdout = { text: "", write(value) { this.text += value; } };
  const stderr = { text: "", write(value) { this.text += value; } };
  const outputFile = path.join(directory, "success.txt");

  await main({ argv: ["--username", "staff.phase7d@driveops.test", "--role", "STAFF", "--output-file", outputFile], database: success.database, stdout, stderr });
  const password = (await fs.readFile(outputFile, "utf8")).match(/^temporary_password=(.+)$/m)[1];
  assert.equal(stdout.text.includes(password), false);
  assert.equal(stderr.text.includes(password), false);
  assert.equal(success.database.closed, true);

  const failure = createDatabase();
  await assert.rejects(main({ argv: ["--username", "staff.phase7d@driveops.test", "--role", "OWNER", "--output-file", path.join(directory, "failure.txt")], database: failure.database, stdout: { write() {} }, stderr: { write() {} } }), /STAFF/);
  assert.equal(failure.database.closed, true);
});
