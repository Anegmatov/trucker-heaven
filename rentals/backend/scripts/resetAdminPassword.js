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

class ResetCommandError extends Error {}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--username", "--output-file"].includes(argument) || !argv[index + 1] || values[argument]) {
      throw new ResetCommandError("Usage requires --username and --output-file exactly once.");
    }
    values[argument] = argv[index + 1];
    index += 1;
  }

  const username = normalizeEmail(values["--username"]);
  const outputFile = String(values["--output-file"] || "").trim();
  if (!username || !/^\S+@\S+\.\S+$/.test(username) || !outputFile) {
    throw new ResetCommandError("Usage requires a valid --username and an --output-file.");
  }
  return { username, outputFile: path.resolve(outputFile) };
}

function generateTemporaryPassword(randomBytes = crypto.randomBytes) {
  return randomBytes(24).toString("base64url");
}

async function ensureProtectedOutputDirectory(outputFile, fsImpl = fs) {
  try {
    await ensureCredentialOutputDirectory(outputFile, { fsImpl });
  } catch (error) {
    throw new ResetCommandError(error.message);
  }
}

async function removeReservedFile(file, outputFile, fsImpl = fs) {
  if (file) await file.close().catch(() => {});
  await fsImpl.unlink(outputFile).catch(() => {});
}

async function resetAdminPassword({ database, username, outputFile, fsImpl = fs, bcryptImpl = bcrypt, passwordFactory = generateTemporaryPassword }) {
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
    if (error?.code === "EEXIST") throw new ResetCommandError("The credential output file already exists.");
    if (error?.message === "The credential output file could not be secured.") {
      throw new ResetCommandError(error.message);
    }
    throw new ResetCommandError("The credential output file could not be created.");
  }

  try {
    client = await database.connect();
    await client.query("BEGIN");
    const accountResult = await client.query(
      "SELECT id, email FROM admin_users WHERE LOWER(email) = $1 FOR UPDATE",
      [username]
    );
    const account = accountResult.rows[0];
    if (!account) throw new ResetCommandError("No existing admin account matches that username.");

    const temporaryPassword = passwordFactory();
    const passwordHash = await bcryptImpl.hash(temporaryPassword, PASSWORD_HASH_ROUNDS);
    await client.query(
      "UPDATE admin_users SET password_hash = $1, failed_login_attempts = 0, locked_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
      [passwordHash, account.id]
    );
    const revokedResult = await client.query(
      "UPDATE admin_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE admin_user_id = $1 AND revoked_at IS NULL RETURNING id",
      [account.id]
    );

    await credentialFile.writeFile(`username=${account.email}\ntemporary_password=${temporaryPassword}\n`, "utf8");
    await credentialFile.sync();
    await client.query("COMMIT");
    committed = true;
    await credentialFile.close();
    credentialFile = null;
    return { username: account.email, sessionsRevoked: revokedResult.rowCount, outputFile };
  } catch (error) {
    if (client && !committed) await client.query("ROLLBACK").catch(() => {});
    if (!committed) await removeReservedFile(credentialFile, outputFile, fsImpl);
    credentialFile = null;
    if (error instanceof ResetCommandError) throw error;
    throw new ResetCommandError("Password reset could not be completed.");
  } finally {
    if (credentialFile) await credentialFile.close().catch(() => {});
    client?.release();
  }
}

function safeFailureMessage(error) {
  return error instanceof ResetCommandError ? error.message : "Password reset could not be completed.";
}

async function main({ argv = process.argv.slice(2), database = db, stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const { username, outputFile } = parseArguments(argv);
    const result = await resetAdminPassword({ database, username, outputFile });
    stdout.write(`[admin:reset-password] ${result.username}; ${result.sessionsRevoked} active sessions revoked; lockout cleared; credentials written to ${result.outputFile}.\n`);
    return result;
  } catch (error) {
    stderr.write(`[admin:reset-password] ${safeFailureMessage(error)}\n`);
    throw error;
  } finally {
    await database.end();
  }
}

if (require.main === module) {
  main().catch(() => { process.exitCode = 1; });
}

module.exports = { ResetCommandError, ensureProtectedOutputDirectory, generateTemporaryPassword, main, parseArguments, resetAdminPassword };
