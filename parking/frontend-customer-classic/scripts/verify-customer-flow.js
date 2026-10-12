'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
assert.ok(app.includes('Your ${durationName(state.trip?.duration)} parking is available. Continue to enter your details.')
  && app.includes('is held for you. Continue to enter your details.'),
'Daily/Weekly area-capacity and Monthly exact-position readiness copy must remain distinct.');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
for (const id of ['searchForm', 'bookingForm', 'lookupForm']) {
  assert.match(html, new RegExp(`<form[^>]+id=["']${id}["'][^>]+method=["']post["']`, 'i'), `${id} must not fall back to a GET that exposes customer data in the URL.`);
}
const lifecycle = fs.readFileSync(path.join(root, 'lifecycle.js'), 'utf8');
const core = fs.readFileSync(path.join(root, 'customer-core.js'), 'utf8');

const result = spawnSync(process.execPath, ['tests/customer-core.test.js'], { cwd: root, encoding: 'utf8' });
process.stdout.write(result.stdout); process.stderr.write(result.stderr);
assert.equal(result.status, 0, 'Customer behavioral tests must pass.');

for (const route of ['parking', 'offers', 'review', 'confirmation', 'pass', 'map', 'reservations', 'lookup']) assert.ok(html.includes(`#${route}`) || lifecycle.includes(`'${route}'`), `Missing route #${route}.`);
for (const marker of ['updateActiveBooking', 'reservationGate', 'tripFingerprint', 'SUCCESS_EMPTY', 'QUOTE_STATUS.ERROR', 'persistActiveReservation', 'authoritativeMutation', 'updateConfirmationDynamic']) assert.ok(app.includes(marker), `Customer runtime is missing ${marker}.`);
const areaRuntime = [app, core, lifecycle].join('\n');
for (const marker of ['YOUR PARKING AREA', 'parkingAreaName', 'ZONE_CAPACITY', 'is-permitted-area']) assert.ok(areaRuntime.includes(marker), `Customer area-capacity flow is missing ${marker}.`);
for (const marker of ['CUSTOMER_SELECTED_SPOT', '/monthly-positions', 'Choose Your Monthly Parking Position', 'selectedMonthlyPosition', '/quotes/release', 'held for you', '/booking-attempts', '/payments/stripe/checkout-sessions', '/documents/insurance/upload', "paymentStatus === 'PAID'"]) assert.ok(areaRuntime.includes(marker), `Customer monthly/payment flow is missing ${marker}.`);
for (const marker of ['upload-documents', 'DRIVER_LICENSE', 'INSURANCE', 'Take Photo', 'Choose File', "accountRequest('/lookup'", "lookupMutation('/documents/complete'", 'name="licensePlate"']) assert.ok(areaRuntime.includes(marker) || html.includes(marker), `Customer document/account flow is missing ${marker}.`);
assert.ok(!areaRuntime.includes('data-account-document='), 'My Parking must not expose customer document viewing controls.');
for (const forbidden of ["accountRequest('/auth/start'", 'verification code', 'select name="reservationNumber"', 'data-account-billing', 'data-account-receipt', 'data-account-cancel-monthly', 'data-account-remove-vehicle']) assert.ok(!app.includes(forbidden), `Customer lookup exposes a forbidden OTP or mutation marker: ${forbidden}`);
for (const marker of ['<b>Payment</b>', 'Continue to secure payment', '<legend>Documents</legend>', 'Upload proof of insurance (optional).', 'Optional for Monthly parking. You can upload now or later.']) assert.ok(html.includes(marker), `Customer payment/verification UI is missing ${marker}.`);
assert.ok(app.includes("state.trip.duration === 'MONTHLY' && insuranceFile"), 'Monthly Checkout must upload insurance only when the customer selected a file.');
assert.ok(!html.includes('Required for Monthly parking.'), 'Monthly document copy must not claim insurance is required.');
for (const marker of ['Company / Carrier name', 'Owner-operators may enter their legal business name or their own operating name.']) assert.ok(html.includes(marker), `Customer company field is missing ${marker}.`);
for (const forbidden of ['booking.lookupCredential || state.activeCredential', 'availability[0] || null', 'CUSTOMER_MAP_RANGE_LABELS', 'accessX =', "replace(',', ' at')"]) assert.ok(!app.includes(forbidden), `Unsafe customer pattern remains: ${forbidden}.`);
assert.ok(app.includes("source === 'remembered'") && app.includes('window.sessionStorage'), 'Session-default and opt-in remembered storage must both be implemented.');
console.log('Customer flow verification passed: behavioral tests plus route/state integration checks.');
