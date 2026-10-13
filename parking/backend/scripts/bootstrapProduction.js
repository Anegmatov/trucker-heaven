/*
 * One-time parking setup for a fresh database, run by the shared API after it starts
 * (PARKING_BOOTSTRAP=true). Mirrors what the local kit does on first run, so production
 * ends up with the same data the owner reviewed locally:
 *
 *   1. base records (location, categories)            — once, when the location is missing
 *   2. OWNER staff account                             — once, from PARKING_OWNER_USERNAME/PASSWORD
 *   3. prices (Daily 19, Weekly 100, Monthly 150/250)  — once; the office changes them later in staff
 *   4. the real lot map, imported and published        — whenever the layout file's version changes
 *   5. Amazon's monthly occupancy (130-204, bobtail 10-59 and 60-67) — once, through the Reservation Desk
 *
 * Every step records itself in parking_bootstrap_state, so a redeploy does nothing it already did.
 * Nothing here destroys data: there is no drop, reset or re-seed.
 */
const path = require('path');
const { spawn } = require('child_process');
const { Pool } = require('pg');
const { createDatabasePoolConfig } = require('../databaseConnection');

const backend = path.join(__dirname, '..');
const LAYOUT = path.join(backend, 'data', 'trucker-heaven-real-lot-layout.v1.json');

function runScript(script, args, env, log) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(backend, 'scripts', script), ...args], { cwd: backend, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const tail = [];
    const keep = chunk => { for (const line of String(chunk).split('\n')) if (line.trim()) { tail.push(line.trim()); if (tail.length > 20) tail.shift(); log(`  ${script}: ${line.trim().slice(0, 300)}`); } };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${script} exited with ${code}: ${tail.slice(-3).join(' | ')}`)));
  });
}

async function run({ databaseUrl = process.env.PARKING_DATABASE_URL, apiBase, log = console.log } = {}) {
  if (!databaseUrl) throw new Error('PARKING_DATABASE_URL is required');
  const pool = new Pool(createDatabasePoolConfig(databaseUrl, { allowLocal: true }));
  const env = { PARKING_DATABASE_URL: databaseUrl, DATABASE_URL: databaseUrl };
  try {
    await pool.query('CREATE TABLE IF NOT EXISTS parking_bootstrap_state (key text PRIMARY KEY, value text, done_at timestamptz NOT NULL DEFAULT now())');
    const state = async key => (await pool.query('SELECT value FROM parking_bootstrap_state WHERE key=$1', [key])).rows[0]?.value ?? null;
    const done = (key, value = 'done') => pool.query('INSERT INTO parking_bootstrap_state(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,done_at=now()', [key, value]);
    const dbName = (await pool.query('SELECT current_database() name')).rows[0].name;

    // 1. base records
    const location = await pool.query("SELECT id FROM parking_locations WHERE name='Trucker Heaven Main Lot'");
    if (!location.rowCount) {
      log('creating the parking location and categories');
      // the seed's base records (location, categories, zones) are exactly what a fresh install needs
      await runScript('seedDevelopment.js', [], { ...env, PARKING_ALLOW_PRODUCTION_SEED: 'true' }, log);
      await pool.query(`UPDATE parking_locations SET
        public_description='Secure truck and bobtail parking at Trucker Heaven, Mt. Juliet, TN.',
        payment_instructions='Pay at the Trucker Heaven office. Daily and Weekly parking is paid when you leave; Monthly parking is due on the 1st of each month.'
        WHERE name='Trucker Heaven Main Lot'`);
    }

    // 2. owner account
    const username = String(process.env.PARKING_OWNER_USERNAME || 'owner').trim().toLowerCase();
    const password = process.env.PARKING_OWNER_PASSWORD || '';
    const owner = await pool.query("SELECT id FROM parking_admin_users WHERE role='OWNER' AND active ORDER BY id LIMIT 1");
    if (!owner.rowCount) {
      if (!password) { log('no OWNER staff account yet and PARKING_OWNER_PASSWORD is not set; stopping here'); return; }
      const bcrypt = require('bcrypt');
      await pool.query('INSERT INTO parking_admin_users(username,password_hash,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [username, await bcrypt.hash(password, 12), 'OWNER']);
      log(`created OWNER staff account "${username}"`);
    }

    // 3. prices (before the import: the importer refuses spaces whose plan has no Weekly price)
    const setPrices = () => pool.query(`UPDATE parking_rate_rules r SET daily_rate_cents=1900, weekly_rate_cents=10000,
      monthly_rate_cents=CASE WHEN c.code='BOBTAIL' THEN 15000 ELSE 25000 END
      FROM parking_categories c WHERE c.id=r.category_id`);
    const pricesDone = await state('prices');
    if (!pricesDone) await setPrices();

    // 4. the real lot
    const layoutVersion = String(JSON.parse(require('fs').readFileSync(LAYOUT, 'utf8')).version);
    if ((await state('lot-version')) !== layoutVersion) {
      log(`importing the real lot map (layout v${layoutVersion})`);
      await runScript('importTruckerHeavenRealLot.js', ['--apply', '--publish', '--expected-database', dbName], env, log);
      await done('lot-version', layoutVersion);
    }
    if (!pricesDone) { await setPrices(); await done('prices'); }

    // 5. Amazon occupancy, through the Reservation Desk like a staff member would
    if (!apiBase) { log('no API base given; skipping the Amazon occupancy seed'); return; }
    if (!password) { log('PARKING_OWNER_PASSWORD is not set; skipping the Amazon occupancy seed'); return; }
    const seedEnv = { ...env, PARKING_ADMIN_USERNAME: username, PARKING_ADMIN_PASSWORD: password };
    const seeds = [
      ['amazon-trucks', []],
      ['amazon-bobtail-10-59', ['--category', 'BOBTAIL', '--from', '10', '--to', '59']],
      ['amazon-bobtail-60-67', ['--category', 'BOBTAIL', '--from', '60', '--to', '67']]
    ];
    for (const [key, args] of seeds) {
      if (await state(key)) continue;
      log(`seeding ${key}`);
      await runScript('seedAmazonOccupancy.js', ['--api', apiBase, ...args], seedEnv, log);
      await done(key);
    }
    log('parking bootstrap complete');
  } finally {
    await pool.end();
  }
}

module.exports = { run };
if (require.main === module) {
  run({ apiBase: process.argv[2] || '', log: m => console.log(`[bootstrap] ${m}`) })
    .catch(error => { console.error('Parking bootstrap failed:', error.message); process.exit(1); });
}
