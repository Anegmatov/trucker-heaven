require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const db = require("../db/connection");
const { PASSWORD_HASH_ROUNDS, bcrypt, normalizeEmail } = require("../services/adminAuthService");
const {
  ensureProtectedOutputDirectory: ensureCredentialOutputDirectory,
  secureCredentialFile
} = require("../utils/credentialFileSecurity");

const EMPLOYEE_ROLES = Object.freeze(["STAFF"]);

class CreateEmployeeCommandError extends Error {}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--username", "--role", "--output-file"].includes(argument) || !argv[index + 1] || values[argument]) {
      throw new CreateEmployeeCommandError("Usage requires --username, --role, and --output-file exactly once.");
    }
    values[argument] = argv[index + 1];
    index += 1;
  }

  const username = normalizeEmail(values["--username"]);
  const role = String(values["--role"] || "").trim().toUpperCase();
  const outputFile = String(values["--output-file"] || "").trim();
  if (!username || !/^\S+@\S+\.\S+$/.test(username) || !EMPLOYEE_ROLES.includes(role) || !outputFile) {
    throw new CreateEmployeeCommandError("Usage requires a valid --username, a STAFF --role, and an --output-file.");
  }
  return { username, role, outputFile: path.resolve(outputFile) };
}

function generateTemporaryPassword(randomBytes = crypto.randomBytes) {
  return randomBytes(24).toString("base64url");
}

async function ensureProtectedOutputDirectory(outputFile, fsImpl = fs) {
  try {
    await ensureCredentialOutputDirectory(outputFile, { fsImpl });
  } catch (error) {
    throw new CreateEmployeeCommandError(error.message);
  }
}

async function removeReservedFile(file, outputFile, fsImpl = fs) {
  if (file) await file.close().catch(() => {});
  await fsImpl.unlink(outputFile).catch(() => {});
}

async function createEmployee({ database, username, role, outputFile, fsImpl = fs, bcryptImpl = bcrypt, passwordFactory = generateTemporaryPassword }) {
  await ensureProtectedOutputDirectory(outputFile, fsImpl);

  let credentialFile;
  let client;
  let committed = false;
  try {
    credentialFile = await fsImpl.open(outputFile, "wx", 0o600);
    await secureCredentialFile(outputFile, { fsImpl });
  } catch (error) {
    if (credentialFile) await removeReservedFile(credentialFile, outputFile, fsImpl);
    credentialFile = null;
    if (error?.code === "EEXIST") throw new CreateEmployeeCommandError("The credential output file already exists.");
    if (error?.message === "The credential output file could not be secured.") {
      throw new CreateEmployeeCommandError(error.message);
    }
    throw new CreateEmployeeCommandError("The credential output file could not be created.");
  }

  try {
    client = await database.connect();
    await client.query("BEGIN");
    const temporaryPassword = passwordFactory();
    const passwordHash = await bcryptImpl.hash(temporaryPassword, PASSWORD_HASH_ROUNDS);
    const result = await client.query(
      `INSERT INTO admin_users (email, password_hash, role, is_active, account_version)
       VALUES ($1, $2, $3, TRUE, 1)
       RETURNING id, email, role, is_active, account_version`,
      [username, passwordHash, role]
    );
    if (!result.rowCount) throw new CreateEmployeeCommandError("Employee account could not be created.");
    const account = result.rows[0];
    await credentialFile.writeFile(`username=${account.email}\ntemporary_password=${temporaryPassword}\n`, "utf8");
    await credentialFile.sync();
    await client.query("COMMIT");
    committed = true;
    await credentialFile.close();
    credentialFile = null;
    return { username: account.email, role: account.role, outputFile };
  } catch (error) {
    if (client && !committed) await client.query("ROLLBACK").catch(() => {});
    if (!committed) await removeReservedFile(credentialFile, outputFile, fsImpl);
    credentialFile = null;
    if (error?.code === "23505") throw new CreateEmployeeCommandError("An admin account with that username already exists.");
    if (error instanceof CreateEmployeeCommandError) throw error;
    throw new CreateEmployeeCommandError("Employee account could not be created.");
  } finally {
    if (credentialFile) await credentialFile.close().catch(() => {});
    client?.release();
  }
}

function safeFailureMessage(error) {
  return error instanceof CreateEmployeeCommandError ? error.message : "Employee account could not be created.";
}

async function main({ argv = process.argv.slice(2), database = db, stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const { username, role, outputFile } = parseArguments(argv);
    const result = await createEmployee({ database, username, role, outputFile });
    stdout.write(`[admin:create-employee] created ${result.username}; role ${result.role}; credentials written to ${result.outputFile}.\n`);
    return result;
  } catch (error) {
    stderr.write(`[admin:create-employee] ${safeFailureMessage(error)}\n`);
    throw error;
  } finally {
    await database.end();
  }
}

if (require.main === module) {
  main().catch(() => { process.exitCode = 1; });
}

module.exports = { CreateEmployeeCommandError, EMPLOYEE_ROLES, createEmployee, ensureProtectedOutputDirectory, generateTemporaryPassword, main, parseArguments };
