require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");
const db = require("../db/connection");
const { PASSWORD_HASH_ROUNDS, bcrypt, normalizeEmail } = require("../services/adminAuthService");
const { moduleEnv } = require("../config/env");

function strongPassword(password) {
  return password.length >= 12 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password);
}

async function promptPassword(prompt) {
  // Keep an interactive bootstrap password out of terminal scrollback. Environment
  // variables remain available for managed secret-injection workflows.
  output.write("Owner password: ");
  prompt._mute = true;
  prompt._writeToOutput = (value) => output.write(prompt._mute ? "*" : value);
  const password = await prompt.question("");
  prompt._mute = false;
  output.write("\n");
  return password;
}

async function main() {
  const prompt = readline.createInterface({ input, output });
  try {
    const email = normalizeEmail(moduleEnv().ADMIN_BOOTSTRAP_EMAIL || await prompt.question("Owner email: "));
    const password = moduleEnv().ADMIN_BOOTSTRAP_PASSWORD || await promptPassword(prompt);
    if (!email || !/^\S+@\S+\.\S+$/.test(email) || !strongPassword(password)) throw new Error("Use a valid email and a 12+ character password with upper, lower, and numeric characters.");
    const hash = await bcrypt.hash(password, PASSWORD_HASH_ROUNDS);
    const result = await db.query(`INSERT INTO admin_users (email, password_hash, role) VALUES ($1, $2, 'OWNER') ON CONFLICT DO NOTHING RETURNING id`, [email, hash]);
    if (result.rowCount === 0) throw new Error("An admin account with that email already exists.");
    console.log("[admin:create] owner account created.");
  } finally { prompt.close(); await db.end(); }
}
main().catch(() => { console.error("[admin:create] failed."); process.exitCode = 1; });
