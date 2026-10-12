require("dotenv").config();
const bcrypt = require("bcrypt");
const { loadConfig } = require("../lib/config");
const { createPool } = require("../db/connection");

async function main() {
  const [email, displayName, role = "STAFF"] = process.argv.slice(2);
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !displayName || !password) throw new Error("Usage: ADMIN_PASSWORD='<12+ chars>' npm run admin:create -- email display-name [OWNER|STAFF]");
  if (password.length < 12) throw new Error("ADMIN_PASSWORD must be at least 12 characters");
  if (!new Set(["OWNER", "STAFF"]).has(role)) throw new Error("Role must be OWNER or STAFF");
  const pool = createPool(loadConfig());
  try {
    const hash = await bcrypt.hash(password, 12);
    await pool.query(`INSERT INTO admin_users (email,display_name,password_hash,role)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (LOWER(email)) DO UPDATE SET
        display_name=EXCLUDED.display_name,
        password_hash=EXCLUDED.password_hash,
        role=EXCLUDED.role,
        is_active=true,
        failed_login_count=0,
        locked_until=NULL`, [email.toLowerCase(), displayName, hash, role]);
    console.log(`[admin:create] ensured ${role} ${email.toLowerCase()}`);
  } finally { await pool.end(); }
}

main().catch((error) => { console.error("[admin:create] failed:", error.message); process.exitCode = 1; });
