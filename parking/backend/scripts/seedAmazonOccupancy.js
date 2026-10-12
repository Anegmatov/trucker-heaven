#!/usr/bin/env node
/*
 * Books every customer space in a number range for one long-term customer (default: Amazon,
 * spaces 130–204, Monthly, pay on site) through the staff Reservation Desk API — so the
 * reservations are real: a customer record, a vehicle per space, a confirmed monthly booking
 * with its ledger, visible in the Live Lot and excluded from public availability.
 *
 * Usage (against a running Parking API):
 *   node scripts/seedAmazonOccupancy.js --api http://127.0.0.1:3001 --login-file ../../logins/parking-owner.txt
 *     [--from 130] [--to 204] [--company "Amazon"] [--location 1]
 * Idempotent: spaces that already hold an active reservation are skipped.
 */
'use strict';
const fs = require('fs');
const crypto = require('crypto');

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback; };
const API = String(opt('api', process.env.PARKING_API_URL || 'http://127.0.0.1:3001')).replace(/\/$/, '');
const FROM = Number(opt('from', 130)); const TO = Number(opt('to', 204));
const COMPANY = opt('company', 'Amazon'); const LOCATION = Number(opt('location', 1));
const loginFile = opt('login-file', '');
let username = process.env.PARKING_ADMIN_USERNAME || ''; let password = process.env.PARKING_ADMIN_PASSWORD || '';
if (loginFile) {
  const text = fs.readFileSync(loginFile, 'utf8');
  username = (text.match(/Username:\s*(\S+)/) || [])[1] || username;
  password = (text.match(/Password:\s*(\S+)/) || [])[1] || password;
}
if (!username || !password) { console.error('Need --login-file or PARKING_ADMIN_USERNAME/PASSWORD'); process.exit(2); }

let cookie = ''; let csrf = '';
async function call(method, path, body, extra = {}) {
  const res = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf, ...extra }, body: body ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: res.status, json, text };
}

(async () => {
  const login = await call('POST', '/api/admin/auth/login', { username, password });
  if (login.status !== 200) throw new Error(`Login failed (${login.status}): ${login.text.slice(0, 200)}`);
  csrf = (await call('GET', '/api/admin/auth/csrf')).json.csrfToken;

  // Arrival: the next full hour, local time of the location (the desk refuses arrivals in the past).
  const tz = opt('timezone', 'America/Chicago');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })
    .formatToParts(new Date(Date.now() + 60 * 60 * 1000)).map(p => [p.type, p.value]));
  const arrivalLocal = `${parts.year}-${parts.month}-${parts.day}T${parts.hour === '24' ? '00' : parts.hour}:00`;

  const parking = { locationId: LOCATION, duration: 'MONTHLY', categoryCode: 'TRACTOR_TRAILER', arrivalLocal };
  const availability = await call('POST', '/api/admin/parking/v1/reservation-desk/availability', parking);
  if (availability.status !== 200) throw new Error(`Availability failed (${availability.status}): ${availability.text.slice(0, 300)}`);
  const options = availability.json.options.filter(o => o.available);
  const wanted = new Map(); // label -> { inventoryId, spotId }
  for (const option of options) for (const p of option.positions || []) {
    const n = Number(p.label); if (Number.isInteger(n) && n >= FROM && n <= TO) wanted.set(n, { inventoryId: option.inventoryId, spotId: p.id });
  }
  const labels = [...wanted.keys()].sort((a, b) => a - b);
  console.log(`[seed] ${labels.length} open Monthly spaces between ${FROM} and ${TO}; booking them for ${COMPANY}`);
  let booked = 0, failed = 0;
  for (const n of labels) {
    const { inventoryId, spotId } = wanted.get(n);
    const body = {
      parking: { ...parking, inventoryId, selectedSpotId: spotId },
      customer: { firstName: COMPANY, lastName: 'Logistics', mobilePhone: '6155550100', email: `fleet@${COMPANY.toLowerCase().replace(/[^a-z0-9]/g, '')}.example`, companyName: COMPANY },
      vehicle: { unitNumber: `${COMPANY.slice(0, 3).toUpperCase()}-${n}`, licensePlate: `${COMPANY.slice(0, 3).toUpperCase()}${String(n).padStart(4, '0')}`, licensePlateState: 'TN' },
      internalNotes: `${COMPANY} long-term lease — space ${n}`
    };
    const r = await call('POST', '/api/admin/parking/v1/reservation-desk/reservations', body, { 'idempotency-key': `seed-${COMPANY}-${n}-${crypto.randomBytes(8).toString('hex')}` });
    if (r.status === 201) { booked += 1; process.stdout.write(`${n} `); }
    else { failed += 1; console.error(`\n[seed] space ${n}: ${r.status} ${r.text.slice(0, 160)}`); }
  }
  console.log(`\n[seed] done: ${booked} booked, ${failed} failed, ${labels.length === 0 ? 'nothing to do' : ''}`);
  process.exit(failed ? 1 : 0);
})().catch(error => { console.error('[seed] failed:', error.message); process.exit(1); });
