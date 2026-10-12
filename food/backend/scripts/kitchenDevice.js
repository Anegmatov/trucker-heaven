require('dotenv').config();
const { loadConfig } = require('../lib/config');
const { createPool } = require('../db/connection');

async function main() {
  const [action, hash, email] = process.argv.slice(2);
  if (!['approve', 'revoke'].includes(action) || !/^[0-9a-f]{64}$/.test(hash || '') || (action === 'approve' && !email)) {
    throw new Error('Usage: node scripts/kitchenDevice.js approve <tablet activation ID> <active admin email> | revoke <tablet activation ID>');
  }
  const db = createPool(loadConfig());
  try {
    if (action === 'approve') {
      const result = await db.query(`INSERT INTO kitchen_devices(token_hash,admin_user_id)
        SELECT $1,id FROM admin_users WHERE LOWER(email)=LOWER($2) AND is_active=TRUE
        ON CONFLICT(token_hash) DO UPDATE SET is_active=TRUE,admin_user_id=EXCLUDED.admin_user_id
        RETURNING token_hash`, [hash, email]);
      if (!result.rowCount) throw new Error('No active administrator with that email.');
    } else {
      await db.query('UPDATE kitchen_devices SET is_active=FALSE WHERE token_hash=$1', [hash]);
    }
    console.log(`Kitchen device ${action} complete.`);
  } finally { await db.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
