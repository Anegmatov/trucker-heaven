require('dotenv').config();
const pool = require('../db');
if (process.env.NODE_ENV === 'production' && process.env.PARKING_ALLOW_PRODUCTION_SEED !== 'true') throw new Error('Refusing to seed production.');
(async () => { await pool.query('BEGIN'); try {
  const location = await pool.query(`INSERT INTO parking_locations(name,public_description,address,timezone,phone,arrival_instructions,booking_approval_mode,payment_instructions,cancellation_cutoff_hours,assignment_mode,exact_mode_active) VALUES ('Trucker Heaven Main Lot','Development seed data only — secure truck parking at Trucker Heaven.','8037 Eastgate Blvd, Mt. Juliet, TN 37122','America/Chicago','+16154705075','Check in with the parking office before parking. Have your reservation number ready.','AUTO_CONFIRM','Payment is due at the parking office when you arrive.',2,'ZONE_CAPACITY',false) ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name,assignment_mode='ZONE_CAPACITY',exact_mode_active=false RETURNING id`);
  const locationId = location.rows[0].id;
  for (const [code, name] of [['TRACTOR_TRAILER','Tractor + Trailer'],['BOBTAIL','Bobtail'],['TRAILER_ONLY','Trailer Only'],['TRACTOR_ONLY','Tractor Only']]) await pool.query('INSERT INTO parking_categories(code,name) VALUES($1,$2) ON CONFLICT(code) DO NOTHING',[code,name]);
  const zones = {};
  for (const [name, description] of [['North Zone', 'Main-lot north parking'], ['South Zone', 'Main-lot south parking']]) {
    const zone = await pool.query(`INSERT INTO parking_zones(location_id,name,description) VALUES($1,$2,$3)
      ON CONFLICT(location_id,name) DO UPDATE SET description=EXCLUDED.description RETURNING id`, [locationId, name, description]);
    zones[name] = zone.rows[0].id;
  }
  const categories = await pool.query('SELECT id,code FROM parking_categories');
  for (const category of categories.rows) {
    const northCapacity = { TRACTOR_TRAILER:40, BOBTAIL:15, TRAILER_ONLY:10, TRACTOR_ONLY:8 }[category.code];
    const southCapacity = { TRACTOR_TRAILER:0, BOBTAIL:15, TRAILER_ONLY:6, TRACTOR_ONLY:4 }[category.code];
    for (const [zoneName, capacity] of [['North Zone', northCapacity], ['South Zone', southCapacity]]) {
      await pool.query(`INSERT INTO parking_inventory(zone_id,category_id,capacity,public_description,public_remaining_capacity)
        VALUES($1,$2,$3,$4,true) ON CONFLICT(zone_id,category_id) DO UPDATE SET capacity=EXCLUDED.capacity`,
      [zones[zoneName], category.id, capacity, `${zoneName} ${category.code.replaceAll('_',' ')} parking`]);
    }
    await pool.query(`INSERT INTO parking_rate_rules(location_id,category_id,daily_rate_cents,weekly_rate_cents,monthly_rate_cents)
      SELECT $1,$2,$3,$4,$5 WHERE NOT EXISTS (SELECT 1 FROM parking_rate_rules WHERE location_id=$1 AND category_id=$2)`,
    [locationId,category.id,category.code==='BOBTAIL'?2500:3500,null,category.code==='BOBTAIL'?45000:60000]);
  }
  await pool.query('COMMIT'); console.log('Development-only parking seed loaded.');
} catch (error) { await pool.query('ROLLBACK'); throw error; } finally { await pool.end(); } })().catch(error => { console.error('Seed failed:',error.message); process.exit(1); });
