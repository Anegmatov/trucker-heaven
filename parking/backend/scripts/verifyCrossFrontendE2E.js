'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const bcrypt = require('bcrypt');
const pool = require('../db');
const app = require('../server');
const { bookingActions: publicBookingActions } = require('../services/publicBookingContract');
const stripeGateway = require('../services/stripeGateway');
const { apiError } = require('../utils');

if (process.env.PARKING_TEST_DATABASE !== 'parkingops_test' || !String(process.env.PARKING_DATABASE_URL || '').includes('parkingops_test')) {
  throw new Error('Refusing cross-frontend E2E: use only the disposable parkingops_test database.');
}

const repository = path.resolve(__dirname, '..', '..');
const customerRoot = path.join(repository, 'frontend-customer');
const adminRoot = path.join(repository, 'frontend-admin');
const geckodriver = process.env.GECKODRIVER_PATH
  || (process.env.GECKOWEBDRIVER ? path.join(process.env.GECKOWEBDRIVER, 'geckodriver') : '/snap/bin/geckodriver');
const webdriverUrl = new URL(process.env.WEBDRIVER_URL || 'http://127.0.0.1:4458');
const webdriverBase = `${webdriverUrl.origin}${webdriverUrl.pathname.replace(/\/$/, '')}`;
const runId = `${process.pid}-${Date.now()}`;
const customerEmail = `cross.frontend.${runId}@example.test`;
const areaEmail = `cross.area.${runId}@example.test`;
const password = 'ParkingOps-lifecycle-test-2034';
const ownerPassword = 'ParkingOps-area-capacity-test-2034';
const legacyLookupCredential = `legacy-${runId}-credential`;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function staticServer(root, apiPort) {
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
  return http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      const proxy = http.request({ hostname: '127.0.0.1', port: apiPort, method: request.method, path: request.url,
        headers: { ...request.headers, host: `127.0.0.1:${apiPort}` } }, upstream => {
        response.writeHead(upstream.statusCode || 502, upstream.headers);
        upstream.pipe(response);
      });
      proxy.on('error', error => {
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'LOCAL_API_UNAVAILABLE', message: error.message } }));
      });
      request.pipe(proxy);
      return;
    }
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    const candidate = path.resolve(root, relative);
    const file = candidate.startsWith(`${root}${path.sep}`) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
      ? candidate : path.join(root, 'index.html');
    response.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(response);
  });
}

const listen = (server, port) => new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));

function localParts(date, zone = 'America/Chicago') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

async function makeCanonicalFixture() {
  const location = (await pool.query(`SELECT id,timezone FROM parking_locations
    WHERE name LIKE 'Operational Lifecycle Integration Lot %' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.ok(location, 'Run the operational lifecycle focused test before cross-frontend E2E.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('parking.layout_publication','on',true)");
    await client.query(`UPDATE parking_lot_layouts SET name=$2 WHERE location_id=$1 AND status='PUBLISHED'`,
      [location.id, `Trucker Heaven physical lot · cross frontend ${runId}`]);
    // The lifecycle suite deliberately disables Bobtail pricing in its final
    // negative-path assertion. Restore only this disposable fixture so the
    // browser can exercise canonical area capacity.
    await client.query(`UPDATE parking_rate_rules SET active=true
      WHERE location_id=$1 AND category_id=(SELECT id FROM parking_categories WHERE code='BOBTAIL')`, [location.id]);
    let legacy = (await client.query(`SELECT booking.id,booking.reservation_number,booking.assigned_spot_label,booking.status
      FROM parking_bookings booking
      JOIN reservation_spot_assignments assignment ON assignment.booking_id=booking.id AND assignment.released_at IS NULL
      WHERE booking.location_id=$1 AND booking.assignment_mode_snapshot='EXACT_SPOT'
        AND booking.status='CONFIRMED'
      ORDER BY booking.departure_at DESC,booking.id DESC LIMIT 1`, [location.id])).rows[0];
    if (!legacy) {
      const spot = (await client.query(`SELECT spot.id,spot.public_label,spot.inventory_id,inventory.category_id
        FROM parking_spots spot JOIN parking_inventory inventory ON inventory.id=spot.inventory_id
        WHERE spot.location_id=$1 AND spot.active=true ORDER BY spot.public_label,spot.id LIMIT 1`, [location.id])).rows[0];
      assert.ok(spot, 'The lifecycle fixture must contain a physical space for historical compatibility verification.');
      legacy = (await client.query(`INSERT INTO parking_bookings(
          reservation_number,public_token,lookup_credential_hash,inventory_id,location_id,category_id,status,
          arrival_at,departure_at,first_name,last_name,mobile_phone,email,company_name,tractor_unit_number,
          license_plate,license_plate_state,assigned_spot_label,terms_accepted_at,cancellation_terms_accepted_at,
          assignment_mode_snapshot,parking_product,payment_status)
        VALUES($1,$2,$3,$4,$5,$6,'CONFIRMED','2038-06-10T14:00:00Z','2038-06-10T18:00:00Z',
          'Legacy','Driver','+16155550998',$7,'Historical Carrier','LEGACY-CROSS','LEGACY','TN',$8,
          now(),now(),'EXACT_SPOT','LEGACY','NOT_REQUIRED')
        RETURNING id,reservation_number,assigned_spot_label,status,arrival_at,departure_at`,
      [`TH-CROSS-LEGACY-${runId}`, `cross-legacy-token-${runId}`, await bcrypt.hash(legacyLookupCredential, 4),
        spot.inventory_id, location.id, spot.category_id, customerEmail, spot.public_label])).rows[0];
      await client.query(`INSERT INTO reservation_spot_assignments(
          booking_id,parking_spot_id,reserved_arrival_at,reserved_departure_at,protected_until_at,assignment_source)
        VALUES($1,$2,$3,$4,$4,'SYSTEM')`, [legacy.id, spot.id, legacy.arrival_at, legacy.departure_at]);
      await client.query(`INSERT INTO parking_booking_price_snapshots(booking_id,snapshot) VALUES($1,$2)`,
        [legacy.id, JSON.stringify({ duration: 'DAILY', unitRateCents: 3200, quantity: 1, totalCents: 3200, currency: 'USD' })]);
      await client.query(`INSERT INTO parking_booking_status_history(booking_id,new_status,actor_type,reason,version)
        VALUES($1,'CONFIRMED','SYSTEM','Historical exact cross-frontend compatibility fixture',1)`, [legacy.id]);
    }
    assert.ok(legacy.assigned_spot_label, 'Historical exact compatibility fixture must have a physical assignment.');
    await client.query(`UPDATE parking_bookings SET lookup_credential_hash=$2,email=$3,
        first_name='Legacy',last_name='Driver'
      WHERE id=$1`, [legacy.id, await bcrypt.hash(legacyLookupCredential, 4), customerEmail]);
    await client.query('COMMIT');
    location.legacy = legacy;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  return location;
}

async function main() {
  stripeGateway.setTestAdapter({
    checkout: { sessions: { create: async () => {
      throw apiError('STRIPE_TEST_OUTAGE', 'Secure checkout could not be reached. No payment was recorded.', 503);
    } } }
  });
  const location = await makeCanonicalFixture();
  const backend = app.listen(0, '127.0.0.1');
  await new Promise(resolve => backend.once('listening', resolve));
  const apiPort = backend.address().port;
  const customerWeb = staticServer(customerRoot, apiPort);
  const adminWeb = staticServer(adminRoot, apiPort);
  await listen(customerWeb, 5180);
  await listen(adminWeb, 5181);
  let driver;
  const sessions = [];
  try {
    if (!process.env.WEBDRIVER_URL) {
      driver = spawn(geckodriver, ['--port', webdriverUrl.port || '4458'], { stdio: ['ignore', 'pipe', 'pipe'] });
    }
    let webdriverReady = false;
    for (let index = 0; index < 80; index += 1) {
      try {
        if ((await fetch(`${webdriverBase}/status`)).ok) { webdriverReady = true; break; }
      } catch (_) { /* retry */ }
      await delay(100);
    }
    assert.equal(webdriverReady, true, `WebDriver did not become ready at ${webdriverBase}.`);
    const command = async (endpoint, method = 'GET', body) => {
      const response = await fetch(`${webdriverBase}${endpoint}`, { method, headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const payload = await response.json();
      if (!response.ok || (payload.value?.error && payload.value?.stacktrace !== undefined)) throw new Error(JSON.stringify(payload));
      return payload.value;
    };
    const createBrowser = async () => {
      const created = await command('/session', 'POST', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } });
      sessions.push(created.sessionId);
      const prefix = endpoint => `/session/${created.sessionId}${endpoint}`;
      const current = await command(prefix('/window'));
      const opened = await command(prefix('/window/new'), 'POST', { type: 'tab' });
      const context = handle => {
        const activate = () => command(prefix('/window'), 'POST', { handle });
        const execute = async script => { await activate(); return command(prefix('/execute/sync'), 'POST', { script, args: [] }); };
        const waitFor = async (script, message) => {
          for (let index = 0; index < 160; index += 1) { if (await execute(script)) return; await delay(100); }
          throw new Error(`${message}: ${JSON.stringify(await execute('return {url:location.href,text:document.body.innerText.slice(0,2000)}'))}`);
        };
        return {
          execute, waitFor,
          navigate: async url => { await activate(); return command(prefix('/url'), 'POST', { url }); },
          resize: async (width, height) => { await activate(); return command(prefix('/window/rect'), 'POST', { width, height }); },
          screenshot: async file => { await activate(); fs.writeFileSync(file, Buffer.from(await command(prefix('/screenshot')), 'base64')); }
        };
      };
      return { customer: context(current), admin: context(opened.handle) };
    };

    const { customer, admin } = await createBrowser();
    await customer.navigate('http://127.0.0.1:5180/');
    await customer.waitFor("return Boolean(document.querySelector('[data-parking-type=\"BOBTAIL\"]'))", 'Customer canonical lot did not load');

    async function createCustomerReservation(email, suffix, arrivalOffsetMinutes = 30, expectedMode = 'ZONE_CAPACITY', screenshots = {}) {
      const arrival = new Date(Date.now() + arrivalOffsetMinutes * 60000);
      const departure = new Date(arrival.getTime() + 4 * 3600000);
      const a = localParts(arrival, location.timezone); const d = localParts(departure, location.timezone);
      await customer.execute(`document.querySelector('[data-parking-type="BOBTAIL"]').click();return true`);
      await customer.waitFor("return Boolean(document.querySelector('[data-duration=\"DAILY\"]'))", 'Daily product did not render');
      await customer.execute(`document.querySelector('[data-duration="DAILY"]').click();
        const values=${JSON.stringify({ arrivalDate: `${a.year}-${a.month}-${a.day}`, arrivalTime: `${a.hour}:${a.minute}`, departureDate: `${d.year}-${d.month}-${d.day}`, departureTime: `${d.hour}:${d.minute}` })};
        for(const [id,value] of Object.entries(values)){const input=document.querySelector('#'+id);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}
        document.querySelector('#searchForm').requestSubmit();return true`);
      await customer.waitFor("return location.hash==='#offers' && !document.querySelector('#continueDriver').disabled", 'Customer quote did not become actionable');
      if (screenshots.offers) await customer.screenshot(screenshots.offers);
      await customer.execute("document.querySelector('#continueDriver').click();return true");
      await customer.waitFor("return location.hash==='#review' && !document.querySelector('#driverStep').hidden", 'Customer review did not open');
      await customer.execute(`const form=document.querySelector('#bookingForm');const values=${JSON.stringify({ firstName: 'Cross', lastName: `Driver ${suffix}`, mobilePhone: '+16155550999', email, companyName: 'Cross Frontend Test', tractorUnitNumber: `CROSS-${suffix}`, licensePlate: `CR${suffix}`, licensePlateState: 'TN', trailerNumber: '', specialInstructions: 'Synthetic disposable E2E' })};for(const [name,value] of Object.entries(values))form.elements[name].value=value;form.elements.termsAccepted.checked=true;form.elements.cancellationTermsAccepted.checked=true;return true`);
      if (screenshots.review) await customer.screenshot(screenshots.review);
      await customer.execute(`window.__crossAttempt=null;window.__crossOriginalFetch=window.fetch;window.fetch=async(...args)=>{
        const response=await window.__crossOriginalFetch(...args);const url=String(args[0]||'');
        if(url.includes('/booking-attempts'))response.clone().json().then(value=>{window.__crossAttempt=value.bookingAttempt||null;}).catch(()=>{});
        return response;};return true`);
      await customer.execute("document.querySelector('#bookingForm').requestSubmit();return true");
      await customer.waitFor("return location.hash==='#review' && document.body.innerText.includes('Secure checkout could not be reached. No payment was recorded.')", 'Synthetic Stripe failure did not fail safely');
      await customer.waitFor("return Boolean(window.__crossAttempt?.lookupCredential)", 'Customer payment attempt credentials were not retained for secure recovery');
      const attempt = await customer.execute('window.fetch=window.__crossOriginalFetch;return window.__crossAttempt');
      let pending;
      for (let index = 0; index < 80 && !pending; index += 1) {
        pending = (await pool.query(`SELECT id,status,payment_status FROM parking_bookings
          WHERE email=$1 ORDER BY id DESC LIMIT 1`, [email])).rows[0];
        if (!pending) await delay(100);
      }
      assert.deepEqual({ status: pending?.status, payment: pending?.payment_status }, { status: 'PENDING', payment: 'DRAFT' });
      await admin.execute(`window.__crossDemoResult=null;window.ParkingAdminApi.createDemoPaymentAuthorization(${JSON.stringify(pending.id)})
        .then(value=>{window.__crossDemoResult={value};}).catch(error=>{window.__crossDemoResult={error:error?.message||String(error)};});return true`);
      await admin.waitFor("return Boolean(window.__crossDemoResult)", 'Owner demo authorization did not complete');
      const demoResult = await admin.execute('return window.__crossDemoResult');
      assert.ok(demoResult.value?.demoAuthorization?.url, demoResult.error || 'Owner demo authorization returned no URL');
      await customer.navigate(`http://127.0.0.1:5180/${new URL(demoResult.value.demoAuthorization.url).hash}`);
      await customer.waitFor("return Boolean(document.querySelector('[data-complete-demo]'))", 'Customer Demo authorization did not render');
      await customer.execute("document.querySelector('[data-complete-demo]').click();return true");
      await customer.waitFor("return document.querySelector('#paymentStep')?.innerText.includes('Demo reservation confirmed')", 'Customer Demo reservation confirmation did not render');
      if (screenshots.confirmation) {
        await customer.execute("window.scrollTo(0,0);return true"); await delay(100);
        await customer.screenshot(screenshots.confirmation);
      }
      const row = (await pool.query('SELECT id,reservation_number,assignment_mode_snapshot,assigned_spot_label,status,payment_status FROM parking_bookings WHERE email=$1 ORDER BY id DESC LIMIT 1', [email])).rows[0];
      assert.equal(row?.assignment_mode_snapshot, expectedMode);
      assert.deepEqual({ status: row?.status, payment: row?.payment_status }, { status: 'CONFIRMED', payment: 'DEMO_BYPASSED' });
      if (expectedMode === 'EXACT_SPOT') assert.ok(row.assigned_spot_label); else assert.equal(row.assigned_spot_label, null);
      await customer.navigate('http://127.0.0.1:5180/#lookup');
      await customer.waitFor("return Boolean(document.querySelector('#lookupForm'))", 'Secure reservation recovery did not open');
      await customer.execute(`const form=document.querySelector('#lookupForm');form.elements.reservationNumber.value=${JSON.stringify(attempt.reservationNumber)};form.elements.lookupCredential.value=${JSON.stringify(attempt.lookupCredential)};form.requestSubmit();return true`);
      await customer.waitFor(`return location.hash==='#reservations'&&document.querySelector('#managementContent')?.innerText.includes(${JSON.stringify(row.reservation_number)})`, 'Secure reservation recovery did not bind the Demo reservation');
      return row;
    }

    const first = location.legacy;
    const originalSpace = first.assigned_spot_label;

    await customer.execute("document.querySelector('[data-route=\"lookup\"]').click();return true");
    await customer.waitFor("return location.hash==='#lookup' && Boolean(document.querySelector('#lookupForm'))", 'Legacy lookup did not open');
    await customer.execute(`const form=document.querySelector('#lookupForm');form.elements.reservationNumber.value=${JSON.stringify(first.reservation_number)};form.elements.lookupCredential.value=${JSON.stringify(legacyLookupCredential)};form.requestSubmit();return true`);
    await customer.waitFor(`return location.hash==='#reservations' && document.querySelector('#managementContent')?.innerText.includes(${JSON.stringify(originalSpace)})`, 'Historical exact reservation did not render through customer lookup');

    await admin.navigate('http://127.0.0.1:5181/');
    await admin.waitFor("return Boolean(document.querySelector('#loginForm'))", 'Admin login did not render');
    await admin.execute(`document.querySelector('#loginUser').value='lifecycle-test-staff';document.querySelector('#loginPass').value=${JSON.stringify(password)};document.querySelector('#loginForm').requestSubmit();return true`);
    await admin.waitFor("return document.querySelector('.main h2')?.textContent==='Overview'", 'STAFF overview did not load');
    assert.equal(await admin.execute("return !document.querySelector('[data-nav=\"Lot Setup\"]') && !document.querySelector('[data-nav=\"Team\"]') && !document.querySelector('[data-nav=\"Business Settings\"]')"), true);
    await admin.execute("document.querySelector('[data-nav=\"Reservations\"]').click();return true");
    await admin.execute(`document.querySelector('#reservationQuery').value=${JSON.stringify(first.reservation_number)};document.querySelector('#reservationSearch').requestSubmit();return true`);
    await admin.waitFor(`return Boolean(document.querySelector('[data-booking-id="${first.id}"]'))`, 'Synthetic reservation search failed');
    await admin.execute(`window.__crossBookingDetail=null;window.ParkingAdminApi.booking(${JSON.stringify(first.id)})
      .then(value=>{window.__crossBookingDetail={value};}).catch(error=>{window.__crossBookingDetail={error:error?.message||String(error)};});return true`);
    await admin.waitFor('return Boolean(window.__crossBookingDetail)', 'Authenticated Admin reservation detail request did not complete');
    const directDetail = await admin.execute('return window.__crossBookingDetail');
    assert.equal(String(directDetail.value?.booking?.id), String(first.id), directDetail.error || 'Admin reservation detail returned the wrong reservation');
    await admin.execute(`document.querySelector('[data-booking-id="${first.id}"]').click();return true`);
    await admin.waitFor(`return [...document.querySelectorAll('.snapshot-item')].some(item=>item.querySelector('span')?.textContent==='Historical position'&&item.querySelector('b')?.textContent===${JSON.stringify(originalSpace)})`, 'Admin did not show the customer-assigned space');
    await admin.screenshot('/tmp/parkingops-admin-exact-detail.png');
    await admin.execute("document.querySelector('#standaloneBookingNote').value='Cross frontend standalone note';document.querySelector('#bookingNoteForm').requestSubmit();return true");
    await admin.waitFor("return [...document.querySelectorAll('.calendar-event span')].some(item=>item.textContent==='Cross frontend standalone note')", 'Standalone note did not persist');
    await admin.execute("document.querySelector('[data-load-alternatives]').click();return true");
    await admin.waitFor("return document.querySelectorAll('#replacementSpot option').length>1", 'No authoritative alternative was returned');
    await admin.execute("const select=document.querySelector('#replacementSpot');select.selectedIndex=1;document.querySelector('#reassignmentReason').value='Cross frontend move';document.querySelector('#reassignmentForm').requestSubmit();return true");
    await admin.waitFor(`return [...document.querySelectorAll('.snapshot-item')].some(item=>item.querySelector('span')?.textContent==='Historical position'&&item.querySelector('b')?.textContent!==${JSON.stringify(originalSpace)})`, 'Reassignment did not refresh');
    const moved = (await pool.query('SELECT assigned_spot_label,version FROM parking_bookings WHERE id=$1', [first.id])).rows[0];
    assert.notEqual(moved.assigned_spot_label, originalSpace);
    await admin.execute("document.querySelector('[data-logout]').click();return true");
    await admin.waitFor("return Boolean(document.querySelector('#loginForm'))", 'Admin logout did not return to login');
    await admin.execute(`document.querySelector('#loginUser').value='area-capacity-test-owner';document.querySelector('#loginPass').value=${JSON.stringify(ownerPassword)};document.querySelector('#loginForm').requestSubmit();return true`);
    await admin.waitFor("return document.querySelector('.user-badge')?.innerText.includes('OWNER')", 'OWNER session did not load');
    await admin.execute("document.querySelector('[data-nav=\"Overview\"]').click();return true");
    await admin.waitFor("return document.querySelector('.main h2')?.textContent==='Overview'", 'OWNER overview did not load');
    await admin.screenshot('/tmp/parkingops-admin-area-dashboard.png');
    // Preserve every exact assignment row as history, then retire the active
    // synthetic exact fixtures before the area-capacity block scenario. The
    // lifecycle integration suite already proved their operational release;
    // this keeps a future legacy assignment from conflicting with an
    // intentionally open-ended visual block in the disposable browser run.
    await pool.query(`UPDATE reservation_spot_assignments assignment
      SET released_at=now(),release_reason='Synthetic legacy E2E fixture retired'
      FROM parking_bookings booking
      WHERE booking.id=assignment.booking_id AND booking.location_id=$1
        AND booking.assignment_mode_snapshot='EXACT_SPOT' AND assignment.released_at IS NULL`, [location.id]);

    // Every new canonical booking is area-based; exact-space behavior above is
    // exercised only through a synthetic historical reservation.
    await customer.navigate(`http://127.0.0.1:5180/?mode=area-${encodeURIComponent(runId)}#parking`);
    await customer.waitFor("return Boolean(document.querySelector('[data-parking-type=\"BOBTAIL\"]')) && document.querySelector('#searchAssignmentNote')?.innerText.includes('parking area')", 'Area-capacity canonical lot did not load');
    await customer.screenshot('/tmp/parkingops-customer-area-search.png');
    const areaBooking = await createCustomerReservation(areaEmail, 'AREA', 30, 'ZONE_CAPACITY', {
      offers: '/tmp/parkingops-customer-area-offers.png',
      review: '/tmp/parkingops-customer-area-review.png',
      confirmation: '/tmp/parkingops-customer-area-confirmation.png'
    });
    const areaCapabilityRow = (await pool.query(`SELECT booking.*,location.self_service_enabled,
        location.check_in_early_minutes,location.check_in_late_minutes,location.cancellation_cutoff_hours
      FROM parking_bookings booking JOIN parking_locations location ON location.id=booking.location_id
      WHERE booking.id=$1`, [areaBooking.id])).rows[0];
    assert.equal(publicBookingActions(areaCapabilityRow).canCheckIn, true, JSON.stringify(publicBookingActions(areaCapabilityRow)));
    await customer.navigate('http://127.0.0.1:5180/#map');
    await customer.waitFor("return location.hash==='#map' && document.querySelectorAll('.map-space.is-permitted-area').length===2 && document.querySelectorAll('.map-space.is-assigned').length===0", 'Customer area map did not highlight the permitted physical area');
    await customer.execute("window.scrollTo(0,0);return true"); await delay(100);
    await customer.screenshot('/tmp/parkingops-customer-area.png');
    await customer.resize(500, 900); await delay(200);
    await customer.screenshot('/tmp/parkingops-customer-area-narrow-map.png');
    await customer.resize(1366, 768); await delay(200);
    await customer.navigate('http://127.0.0.1:5180/#reservations');
    await customer.waitFor(`return Boolean(document.querySelector('[data-view-recent="${areaBooking.reservation_number}"]'))`, 'Customer area reservation did not appear in recent reservations');
    await customer.execute(`if(!document.querySelector('[data-self-action="check-out"]'))document.querySelector('[data-view-recent="${areaBooking.reservation_number}"]')?.click();return true`);
    await customer.waitFor("return document.querySelector('#managementContent')?.innerText.toUpperCase().includes('PARKING AREA') && Boolean(document.querySelector('[data-self-action=\"check-in\"]'))", 'Customer area management did not render');
    await customer.execute("window.scrollTo(0,0);return true"); await delay(100);
    await customer.screenshot('/tmp/parkingops-customer-area-lookup.png');
    await customer.execute("document.querySelector('[data-self-action=\"check-in\"]').click();return true");
    await customer.waitFor("return document.querySelector('#selfServiceDialog').open", 'Area check-in confirmation did not open');
    await customer.execute("document.querySelector('[data-confirm-self=\"check-in\"]').click();return true");
    await customer.waitFor(`return document.querySelector('#managementContent')?.innerText.toUpperCase().includes('CHECKED_IN')||document.querySelector('[data-recent-card="${areaBooking.reservation_number}"] .status-chip')?.innerText.toUpperCase().includes('CHECKED IN')`, 'Area self-service check-in did not complete');

    await admin.execute("document.querySelector('[data-nav=\"Live Lot\"]').click();return true");
    await admin.waitFor("return document.querySelector('.main h2')?.textContent==='Live Lot' && Boolean(document.querySelector('[data-refresh]'))", 'Admin Live Lot did not open for area verification');
    await admin.execute("document.querySelector('[data-refresh]').click();return true");
    await admin.waitFor("return !document.body.innerText.includes('Loading authoritative ParkingOps data') && [...document.querySelectorAll('.lot-summary>div')].some(item=>item.innerText.toUpperCase().includes('DAILY AVAILABLE')&&item.querySelector('strong')?.textContent==='1')", 'Admin area-capacity metrics did not reflect customer check-in');
    assert.equal(await admin.execute("return document.querySelectorAll('.operational-map-space.occupied').length"), 0, 'Area commitment painted a fake exact occupied stall');
    await admin.screenshot('/tmp/parkingops-admin-area.png');
    await admin.resize(500, 900); await delay(200);
    await admin.execute("document.querySelector('.main').scrollIntoView({block:'start'});return true"); await delay(100);
    await admin.screenshot('/tmp/parkingops-admin-area-narrow-live-lot.png');
    await admin.resize(1366, 768); await admin.execute("window.scrollTo(0,0);return true"); await delay(200);
    await admin.execute("[...document.querySelectorAll('.operational-map-space.available')].find(item=>item.textContent.trim().startsWith('B-')).click();return true");
    await admin.waitFor("return Boolean(document.querySelector('#blockSpaceForm'))", 'OWNER physical-space block control did not render');
    await admin.execute("document.querySelector('#blockSpaceReason').value='Synthetic visual capacity block';document.querySelector('#blockSpaceForm').requestSubmit();return true");
    await admin.waitFor("return document.querySelectorAll('.operational-map-space.blocked').length===1 && [...document.querySelectorAll('.lot-summary>div')].some(item=>item.innerText.toUpperCase().includes('DAILY AVAILABLE')&&item.querySelector('strong')?.textContent==='0')", 'Physical block did not reduce area capacity');
    await admin.screenshot('/tmp/parkingops-admin-area-blocked.png');
    await admin.execute("document.querySelector('.operational-map-space.blocked').click();return true");
    await admin.waitFor("return Boolean(document.querySelector('[data-unblock-space]'))", 'OWNER physical-space unblock control did not render');
    await admin.execute("document.querySelector('[data-unblock-space]').click();return true");
    await admin.waitFor("return document.querySelectorAll('.operational-map-space.blocked').length===0 && [...document.querySelectorAll('.lot-summary>div')].some(item=>item.innerText.toUpperCase().includes('DAILY AVAILABLE')&&item.querySelector('strong')?.textContent==='1')", 'Unblock did not restore area capacity');

    await customer.execute(`document.querySelector('[data-view-recent="${areaBooking.reservation_number}"]').click();return true`);
    await customer.waitFor("return Boolean(document.querySelector('[data-self-action=\"check-out\"]'))", 'Checked-in reservation did not reopen for check-out');
    await customer.execute("document.querySelector('[data-self-action=\"check-out\"]').click();return true");
    await customer.waitFor("return document.querySelector('#selfServiceDialog').open", 'Area check-out confirmation did not open');
    await customer.execute("document.querySelector('[data-confirm-self=\"check-out\"]').click();return true");
    await customer.waitFor(`return document.querySelector('#managementContent')?.innerText.toUpperCase().includes('CHECKED OUT')||document.querySelector('[data-recent-card="${areaBooking.reservation_number}"] .status-chip')?.innerText.toUpperCase().includes('CHECKED OUT')`, 'Area self-service checkout did not complete');

    await admin.execute("document.querySelector('[data-nav=\"Reservations\"]').click();return true");
    await admin.execute(`document.querySelector('#reservationQuery').value=${JSON.stringify(areaBooking.reservation_number)};document.querySelector('#reservationSearch').requestSubmit();return true`);
    await admin.waitFor(`return Boolean(document.querySelector('[data-booking-id="${areaBooking.id}"]'))`, 'Area reservation search failed');
    await admin.execute(`window.__crossAreaDetail=null;window.ParkingAdminApi.booking(${JSON.stringify(areaBooking.id)})
      .then(value=>{window.__crossAreaDetail={value};}).catch(error=>{window.__crossAreaDetail={error:error?.message||String(error)};});return true`);
    await admin.waitFor('return Boolean(window.__crossAreaDetail)', 'Authenticated Admin area-reservation detail request did not complete');
    const directAreaDetail = await admin.execute('return window.__crossAreaDetail');
    assert.equal(String(directAreaDetail.value?.booking?.id), String(areaBooking.id), directAreaDetail.error || 'Admin area-reservation detail returned the wrong reservation');
    await admin.execute(`document.querySelector('[data-booking-id="${areaBooking.id}"]').click();return true`);
    await admin.waitFor("return [...document.querySelectorAll('.snapshot-item')].some(item=>item.querySelector('span')?.textContent==='Parking area') && document.querySelector('.operational-actions')?.innerText.includes('No numbered position is assigned')", 'Admin area reservation detail did not branch from exact assignment');
    assert.equal(await admin.execute("return Boolean(document.querySelector('[data-load-alternatives]'))"), false);
    await admin.screenshot('/tmp/parkingops-admin-area-detail.png');

    await admin.execute("document.querySelector('[data-nav=\"Customers\"]').click();return true");
    await admin.waitFor("return Number(document.querySelector('.report-kpi strong')?.textContent)>200 && !document.querySelector('[data-customers-next]').disabled", 'Authoritative Customers did not expose scalable totals/pages');
    await admin.screenshot('/tmp/parkingops-admin-customers.png');
    await admin.execute("document.querySelector('[data-customers-next]').click();return true");
    await admin.waitFor("return document.querySelector('.panel-head')?.textContent?.includes('2') || document.body.innerText.includes('Customer page 2')", 'Customers next page did not load');
    await admin.execute("document.querySelector('[data-nav=\"Business Settings\"]').click();return true");
    await admin.waitFor("return !document.querySelector('#configuration').hidden && Boolean(document.querySelector('#tab-policies'))", 'Business Settings did not load');
    await admin.execute("document.querySelector('#tab-policies').click();return true");
    await admin.waitFor("return !document.querySelector('#config-policies').hidden", 'Booking Policies did not open');
    assert.equal(await admin.execute("return Boolean(document.querySelector('#bookingPoliciesForm [name=\"assignment_mode\"]'))"), false, 'Booking Policies exposed an exact-space toggle');
    assert.equal(await admin.execute("return document.querySelector('#config-policies').innerText.includes('Term-based customer reservations')"), true);
    await admin.screenshot('/tmp/parkingops-admin-booking-policies.png');
    assert.equal(await admin.execute('return localStorage.length'), 0, 'Admin wrote operational localStorage');
    assert.deepEqual(await admin.execute('return window.__PARKING_ADMIN_ERRORS'), []);
    console.log(JSON.stringify({ legacyExactCustomerLookup: 'passed', adminSameSpace: originalSpace, reassignedSpace: moved.assigned_spot_label,
      areaCustomerBooking: 'highlighted with no exact assignment', areaCheckIn: 'capacity metric only',
      screenshots: ['/tmp/parkingops-customer-area-search.png', '/tmp/parkingops-customer-area-offers.png',
        '/tmp/parkingops-customer-area-review.png', '/tmp/parkingops-customer-area-confirmation.png',
        '/tmp/parkingops-customer-area.png', '/tmp/parkingops-customer-area-narrow-map.png',
        '/tmp/parkingops-customer-area-lookup.png', '/tmp/parkingops-admin-area-dashboard.png',
        '/tmp/parkingops-admin-exact-detail.png', '/tmp/parkingops-admin-area.png',
        '/tmp/parkingops-admin-area-blocked.png', '/tmp/parkingops-admin-area-detail.png',
        '/tmp/parkingops-admin-area-narrow-live-lot.png', '/tmp/parkingops-admin-customers.png',
        '/tmp/parkingops-admin-booking-policies.png'],
      note: 'persisted', areaCheckOut: 'released',
      legacyExact: 'synthetic historical read and reassignment', customers: '>200 paginated', calendarTimezone: location.timezone }));
  } finally {
    stripeGateway.clearTestAdapter();
    for (const session of sessions) await fetch(`${webdriverBase}/session/${session}`, { method: 'DELETE' }).catch(() => {});
    driver?.kill('SIGTERM');
    await Promise.all([close(backend), close(customerWeb), close(adminWeb)]).catch(() => {});
    await pool.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
