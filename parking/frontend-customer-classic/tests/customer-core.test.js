'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../customer-core.js');
const lifecycle = require('../lifecycle.js');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const entry = number => ({ reservationNumber: number, lookupCredential: `credential-${number}`, updatedAt: '2030-01-01T00:00:00Z', status: 'CONFIRMED' });
const trip = { categoryCode: 'BOBTAIL', duration: 'DAILY', arrivalLocal: '2026-08-04T15:00', departureLocal: '2026-08-05T15:00' };
const available = { categoryCode: 'BOBTAIL', available: true, pricingAvailable: true, assignmentMode: 'EXACT_SPOT', numberedSpacesAvailable: 2 };

test('explicit missing recent reservation returns null', () => {
  assert.equal(core.activeRecentEntry([entry('A')], 'MISSING'), null);
});
test('recent reservation falls back only without an explicit number', () => {
  assert.equal(core.activeRecentEntry([entry('A')]).reservationNumber, 'A');
});
test('switching reservation identity clears credential and contact', () => {
  const result = core.transitionReservationSession({ booking: { reservationNumber: 'A' }, credential: 'secret-a', contact: 'a@test' }, { reservationNumber: 'B', status: 'CONFIRMED' });
  assert.equal(result.credential, ''); assert.equal(result.contact, ''); assert.equal(result.changed, true);
});
test('same reservation refresh can retain its own credential and contact', () => {
  const result = core.transitionReservationSession({ booking: { reservationNumber: ' a ' }, credential: 'secret-a', contact: 'a@test' }, { reservationNumber: 'A', status: 'CHECKED_IN' });
  assert.equal(result.credential, 'secret-a'); assert.equal(result.contact, 'a@test'); assert.equal(result.changed, false);
});
test('new booking cannot inherit an older credential', () => {
  const result = core.transitionReservationSession({ booking: { reservationNumber: 'A' }, credential: 'secret-a' }, { reservationNumber: 'B', status: 'CONFIRMED' }, '');
  assert.equal(result.credential, '');
});
test('operation gate rejects a slower reservation A after B begins', () => {
  const gate = core.createOperationGate(); const a = gate.begin('A'); const b = gate.begin('B');
  assert.equal(gate.current(b, 'B'), true); assert.equal(gate.current(a, 'A'), false);
});
test('operation gate checks normalized expected identity', () => {
  const gate = core.createOperationGate(); const token = gate.begin(' thp-1 ');
  assert.equal(gate.current(token, 'THP-1'), true); assert.equal(gate.current(token, 'THP-2'), false);
});

test('stopping polling during an in-flight fetch prevents callbacks', async () => {
  let resolve; const pending = new Promise(done => { resolve = done; }); const callbacks = []; const timers = [];
  const poller = lifecycle.createAssignmentPoller({ fetchBooking: () => pending, onBooking: value => callbacks.push(value), onCheck: () => callbacks.push('check'), setTimer: callback => { timers.push(callback); return callback; }, clearTimer: () => {} });
  poller.start(); const running = timers.shift()(); poller.stop('navigation'); resolve({ status: 'CONFIRMED', assignmentMode: 'EXACT_SPOT' }); await running;
  assert.deepEqual(callbacks, []); assert.equal(poller.isRunning(), false);
});
test('inactive polling cannot schedule another request after await', async () => {
  let active = true; let resolve; const pending = new Promise(done => { resolve = done; }); const timers = [];
  const poller = lifecycle.createAssignmentPoller({ fetchBooking: () => pending, isActive: () => active, setTimer: callback => { timers.push(callback); return callback; }, clearTimer: () => {} });
  poller.start(); const running = timers.shift()(); active = false; resolve({ status: 'CONFIRMED', assignmentMode: 'EXACT_SPOT' }); await running;
  assert.equal(timers.length, 0); assert.equal(poller.isRunning(), false);
});
test('polling stops on assigned and terminal statuses', () => {
  assert.equal(lifecycle.shouldPollAssignment({ status: 'CONFIRMED', assignmentMode: 'EXACT_SPOT' }), true);
  assert.equal(lifecycle.shouldPollAssignment({ status: 'CANCELLED', assignmentMode: 'EXACT_SPOT' }), false);
  assert.equal(lifecycle.shouldPollAssignment({ status: 'CONFIRMED', assignmentMode: 'EXACT_SPOT', assignedSpotLabel: '127' }), false);
});

test('empty availability validates as an empty completed result', () => {
  assert.deepEqual(core.validateAvailabilityResults({ results: [] }, 'BOBTAIL'), []);
  assert.ok(app.includes('SUCCESS_EMPTY') && app.includes("navigate('offers')"));
});
test('BOBTAIL search never accepts TRACTOR_TRAILER result', () => {
  assert.deepEqual(core.validateAvailabilityResults({ results: [{ ...available, categoryCode: 'TRACTOR_TRAILER' }] }, 'BOBTAIL'), []);
});
test('TRACTOR_TRAILER search never accepts BOBTAIL result', () => {
  assert.deepEqual(core.validateAvailabilityResults({ results: [available] }, 'TRACTOR_TRAILER'), []);
});
test('unknown and internal categories are filtered publicly', () => {
  assert.deepEqual(core.filterPublicCategories([{ code: 'SHOP' }, { code: 'INTERNAL' }]), []);
  assert.equal(core.validateBooking({ reservationNumber: 'A', status: 'CONFIRMED', category: 'Shop Parking' }).category, 'Parking type unavailable');
});
test('public category labels are fixed customer labels', () => {
  const values = core.filterPublicCategories([{ code: 'BOBTAIL', name: 'Wrong' }, { code: 'TRACTOR_TRAILER', name: 'Wrong' }]);
  assert.deepEqual(values.map(value => value.name), ['Bobtail Parking', 'General Truck Parking']);
});
test('trip fingerprint changes for category, arrival, departure, and duration edits', () => {
  const base = core.tripFingerprint(trip);
  for (const changed of [{ ...trip, categoryCode: 'TRACTOR_TRAILER' }, { ...trip, arrivalLocal: '2026-08-04T16:00' }, { ...trip, departureLocal: '2026-08-06T15:00' }]) assert.notEqual(core.tripFingerprint(changed), base);
});
test('stale trip response token is rejected after invalidation', () => {
  const gate = core.createOperationGate(); const old = gate.begin(core.tripFingerprint(trip)); gate.invalidate(); assert.equal(gate.current(old, core.tripFingerprint(trip)), false);
});
test('offer identity includes authoritative fields and trip', () => {
  assert.notEqual(core.offerKey({ ...available, ratePlanId: 'one' }, 'trip'), core.offerKey({ ...available, ratePlanId: 'two' }, 'trip'));
});
test('quote errors are distinct from quote loading', () => {
  assert.notEqual(core.QUOTE_STATUS.ERROR, core.QUOTE_STATUS.LOADING); assert.ok(app.includes('PRICE RETRIEVAL FAILED'));
});
test('booking continuation rejects missing, errored, stale, mismatched, and unavailable quotes', () => {
  const fingerprint = core.tripFingerprint(trip); const key = core.offerKey(available, fingerprint);
  const base = { trip, selected: { ...available, tripFingerprint: fingerprint, offerKey: key }, quote: { status: core.QUOTE_STATUS.SUCCESS, tripFingerprint: fingerprint, offerKey: key, data: { quoteToken: 'token', quote: { totalCents: 1000 } } } };
  assert.equal(core.bookingCanContinue(base), true);
  assert.equal(core.bookingCanContinue({ ...base, quote: { ...base.quote, status: core.QUOTE_STATUS.ERROR } }), false);
  assert.equal(core.bookingCanContinue({ ...base, quote: { ...base.quote, tripFingerprint: 'old' } }), false);
  assert.equal(core.bookingCanContinue({ ...base, quote: { ...base.quote, offerKey: 'other' } }), false);
  assert.equal(core.bookingCanContinue({ ...base, selected: { ...base.selected, available: false } }), false);
  assert.equal(core.bookingCanContinue({ ...base, quote: { ...base.quote, data: null } }), false);
});
test('expired quote disables continuation', () => {
  const fingerprint = core.tripFingerprint(trip); const key = core.offerKey(available, fingerprint);
  assert.equal(core.bookingCanContinue({ trip, selected: { ...available, tripFingerprint: fingerprint, offerKey: key }, quote: { status: 'SUCCESS', tripFingerprint: fingerprint, offerKey: key, data: { quoteToken: 'q', expiresAt: '2000-01-01T00:00:00Z', quote: { totalCents: 1 } } } }), false);
});

test('humanTime produces grammatically ordered date text', () => {
  assert.match(core.humanTime('2026-08-04T20:00:00Z', 'America/Chicago'), /^August 4, 2026 at 3:00 PM CDT$/);
  assert.ok(!core.humanTime('2026-08-04T20:00:00Z', 'America/Chicago').includes('August 4 at 2026'));
});
test('recent reservation time uses its stored timezone', () => {
  const value = core.humanTime('2026-08-04T20:00:00Z', 'America/Chicago'); assert.match(value, /3:00 PM CDT/); assert.ok(app.includes('entry.timezone'));
});
test('lot timezone creates input values independent of browser timezone', () => {
  assert.equal(core.zonedInputValue('2026-08-04T20:00:00Z', 'America/Chicago'), '2026-08-04T15:00');
});
test('Monthly requires only a start while Daily keeps a valid date span', () => {
  assert.equal(core.productIntervalError('DAILY', '2026-10-15T12:00', '2026-11-14T12:00', 28), '');
  assert.equal(core.productIntervalError('MONTHLY', '2026-03-07T12:00', '', 28), '');
  assert.equal(core.productIntervalError('MONTHLY', '', '', 28), 'Enter a valid start date and time.');
  assert.equal(core.tripFingerprint({ ...trip, duration: '' }), '');
  assert.equal(core.tripFingerprint({ categoryCode: 'TRACTOR_TRAILER', arrivalLocal: '2026-09-01T09:00', duration: 'MONTHLY' }), 'TRACTOR_TRAILER|MONTHLY|2026-09-01T09:00|OPEN_ENDED');
});
test('money rejects malformed and unsafe values', () => {
  for (const value of [NaN, Infinity, '100', Number.MAX_SAFE_INTEGER + 1]) assert.equal(core.money(value), 'Unavailable');
});

test('PENDING does not render as confirmed', () => {
  const view = core.reservationStatusView({ status: 'pending', assignmentMode: 'EXACT_SPOT' }); assert.equal(view.heading, 'Reservation received'); assert.equal(view.tone, 'warning'); assert.equal(view.passValid, false);
});
test('confirmed parking-area booking needs no exact assignment for map or self-service', () => {
  const booking = core.validateBooking({
    reservationNumber: 'AREA-1', status: 'CONFIRMED', assignmentMode: 'ZONE_CAPACITY',
    category: 'General Truck Parking', parkingArea: { id: 'pa_area', name: 'General Truck Parking' },
    assignedSpotLabel: null, map: { elements: [] }, selfServiceEnabled: true
  });
  const view = core.reservationStatusView(booking);
  assert.equal(view.exact, false);
  assert.equal(view.showParkingArea, true);
  assert.equal(view.areaName, 'General Truck Parking');
  assert.equal(view.mapValid, true);
  assert.equal(view.canCheckIn, true);
  assert.match(view.description, /highlighted General Truck Parking area/);
  assert.ok(app.includes('is-permitted-area') && css.includes('.map-space.is-permitted-area'));
  assert.ok(html.includes('Pick your space'));
});
test('legacy booking without a mode remains exact only when an assigned label exists', () => {
  assert.equal(core.validateBooking({ reservationNumber: 'LEGACY-1', status: 'CONFIRMED', assignedSpotLabel: '42' }).assignmentMode, 'EXACT_SPOT');
  assert.equal(core.validateBooking({ reservationNumber: 'LEGACY-2', status: 'CONFIRMED' }).assignmentMode, 'ZONE_CAPACITY');
});
test('CANCELLED does not expose active pass map or actions', () => {
  const view = core.reservationStatusView({ status: 'cancelled', assignedSpotLabel: '127', map: {}, selfServiceEnabled: true }); assert.equal(view.passValid, false); assert.equal(view.mapValid, false); assert.equal(view.canCancel, false); assert.equal(view.assignedSpace, 'Released / inactive');
});
test('COMPLETED and CHECKED_OUT never say ready for arrival', () => {
  for (const status of ['COMPLETED', 'CHECKED_OUT']) { const view = core.reservationStatusView({ status }); assert.ok(!`${view.heading} ${view.description}`.includes('Ready for arrival')); assert.equal(view.canPrint, false); }
});
test('UNKNOWN does not assume success', () => {
  const view = core.reservationStatusView({ status: 'something-new' }); assert.equal(view.status, 'UNKNOWN'); assert.equal(view.passValid, false); assert.equal(view.tone, 'neutral');
});
test('terminal statuses expose no invalid customer actions', () => {
  for (const status of ['CANCELLED', 'REJECTED', 'EXPIRED', 'COMPLETED']) { const view = core.reservationStatusView({ status, selfServiceEnabled: true, assignedSpotLabel: '1' }); assert.equal(view.canCancel || view.canCheckIn || view.canCheckOut || view.mapValid, false); }
});
test('mutation uses authoritative response and supports authoritative refresh fallback', () => {
  assert.equal(core.mutationBooking({ booking: { reservationNumber: 'A', status: 'CANCELLED' } }).status, 'CANCELLED');
  assert.equal(core.mutationBooking({}, { reservationNumber: 'A', status: 'CHECKED_OUT' }).status, 'CHECKED_OUT');
});

test('remembered entries omit public token and track storage source', () => {
  const remembered = lifecycle.entryFromBooking({ reservationNumber: 'A', status: 'CONFIRMED', publicToken: 'do-not-store', timezone: 'America/Chicago' }, 'secret', '', Date.parse('2030-01-01T00:00:00Z'), 'remembered');
  assert.equal(remembered.publicToken, undefined); assert.equal(remembered.source, 'remembered'); assert.equal(remembered.remembered, true);
});
test('recent reservation storage preserves assignment mode and public area but no internal zone', () => {
  const stored = lifecycle.entryFromBooking({
    reservationNumber: 'AREA-2', status: 'CONFIRMED', assignmentMode: 'ZONE_CAPACITY',
    parkingArea: { name: 'General Truck Parking' }, category: 'General Truck Parking', timezone: 'America/Chicago'
  }, 'secret');
  assert.equal(stored.assignmentMode, 'ZONE_CAPACITY');
  assert.equal(stored.parkingArea, 'General Truck Parking');
  assert.equal(stored.zone, undefined);
});
test('session storage is the default entry source', () => {
  const session = lifecycle.entryFromBooking({ reservationNumber: 'A', status: 'CONFIRMED' }, 'secret', '', Date.parse('2030-01-01T00:00:00Z'));
  assert.equal(session.source, 'session'); assert.equal(session.remembered, false);
});
test('terminal retention is seven days and active retention is thirty days', () => {
  const now = Date.parse('2030-02-01T00:00:00Z');
  assert.equal(lifecycle.sanitizeRecent([{ ...entry('OLD'), status: 'CANCELLED', updatedAt: '2030-01-01T00:00:00Z' }], now).length, 0);
  assert.equal(lifecycle.sanitizeRecent([{ ...entry('ACTIVE'), status: 'CONFIRMED', updatedAt: '2030-01-20T00:00:00Z' }], now).length, 1);
});
test('recent refresh code never activates a reservation', () => {
  const body = app.slice(app.indexOf('async function refreshRecentReservation'), app.indexOf('async function refreshRecentReservations'));
  assert.ok(!body.includes('updateActiveBooking')); assert.ok(!body.includes('state.activeBooking'));
});

test('customer product choices consume authoritative offers and never infer the selected term from per-space eligibility', () => {
  assert.match(app, /core\.filterSupportedDurations\(categoryFor\(\)\?\.offeredDurations\)/);
  assert.match(app, /result\.available && result\.pricingAvailable/);
  const durationChange = app.slice(app.indexOf('function setDuration'), app.indexOf('function selectOffer'));
  assert.doesNotMatch(durationChange, /dailyEligible|monthlyEligible|daily_eligible|monthly_eligible/);
  assert.match(app, /spot\.monthlyEligible/);
  assert.match(durationChange, /invalidateSearchState/);
  assert.match(durationChange, /state\.selectedDuration = duration/);
  assert.match(durationChange, /renderCanonicalLot\(\)/);
  assert.doesNotMatch(durationChange, /renderCanonical\(\)/);
  assert.doesNotMatch(app, /durationHint|derivedDuration/);
});

test('Monthly quote must match the customer-selected authoritative position', () => {
  const monthlyTrip = { ...trip, duration: 'MONTHLY', departureLocal: '2026-09-03T15:00' };
  const selected = { ...available, assignmentMode: 'CUSTOMER_SELECTED_SPOT', selectedSpotId: 145 };
  const response = {
    quote: { duration: 'MONTHLY', totalCents: 45000 }, categoryCode: 'BOBTAIL',
    assignmentMode: 'CUSTOMER_SELECTED_SPOT', selectedMonthlyPosition: { id: 145, label: '145' },
    arrival: '2026-08-04T20:00:00Z', departure: '2026-09-03T20:00:00Z',
    arrivalLocal: monthlyTrip.arrivalLocal, departureLocal: monthlyTrip.departureLocal
  };
  assert.equal(core.validateQuote(response, monthlyTrip, selected), response);
  assert.equal(core.validateQuote({ ...response, selectedMonthlyPosition: { id: 146, label: '146' } }, monthlyTrip, selected), null);
});

test('Monthly checkout continuation requires the held position to match the selected position', () => {
  const monthlyTrip = { ...trip, duration: 'MONTHLY', departureLocal: '2026-09-03T15:00' };
  const fingerprint = core.tripFingerprint(monthlyTrip);
  const selected = { ...available, assignmentMode: 'CUSTOMER_SELECTED_SPOT', tripFingerprint: fingerprint };
  selected.offerKey = core.offerKey(selected, fingerprint);
  const model = {
    trip: monthlyTrip, selected, selectedMonthlySpot: { id: 145, label: '145' },
    quote: { status: core.QUOTE_STATUS.SUCCESS, tripFingerprint: fingerprint, offerKey: selected.offerKey,
      data: { quoteToken: 'held-quote', selectedMonthlyPosition: { id: 145, label: '145' }, quote: { totalCents: 45000 } } }
  };
  assert.equal(core.bookingCanContinue(model), true);
  assert.equal(core.bookingCanContinue({ ...model, selectedMonthlySpot: { id: 146, label: '146' } }), false);
});

test('Customer-selected Monthly confirmation is not treated as legacy automatic assignment', () => {
  const booking = core.validateBooking({
    reservationNumber: 'MONTHLY-145', status: 'CONFIRMED', assignmentMode: 'CUSTOMER_SELECTED_SPOT',
    assignedSpotLabel: '145', category: 'General Truck Parking', map: { elements: [] }, selfServiceEnabled: true
  });
  const view = core.reservationStatusView(booking);
  assert.equal(view.monthlySelected, true);
  assert.equal(view.legacyExact, false);
  assert.equal(view.pollAssignment, false);
  assert.match(view.description, /Space 145 is reserved for you/);
});

test('Company / Carrier name is conditionally required for Monthly and explained in the real customer form', () => {
  assert.match(html, /Company \/ Carrier name/);
  assert.doesNotMatch(html, /name="companyName"[^>]*required/);
  assert.match(app, /company\.required = monthly/);
  assert.match(html, /Owner-operators may enter their legal business name or their own operating name\./);
});

test('configured Daily, Weekly, and Monthly controls remain explicit for a one-day interval', () => {
  const lot = core.validateCanonicalLot({ lot: { timezone: 'America/Chicago', bookingPolicy: { minimumWeeklyDays: 7, minimumMonthlyDays: 28 }, categories: [{
    code: 'BOBTAIL', offeredDurations: [{ code: 'DAILY', unitRateCents: 1900 }, { code: 'WEEKLY', unitRateCents: 10000 }, { code: 'MONTHLY', unitRateCents: 15000 }]
  }] } });
  assert.deepEqual(lot.categories[0].offeredDurations.map(item => item.code), ['DAILY', 'WEEKLY', 'MONTHLY']);
  assert.equal(core.productIntervalError('DAILY', '2030-01-01T10:00', '2030-01-02T10:00', lot.bookingPolicy.minimumMonthlyDays), '');
  assert.equal(core.productIntervalError('WEEKLY', '2030-01-01T10:00', '2030-01-08T10:00', 28, lot.bookingPolicy.minimumWeeklyDays), '');
  assert.match(app, /offers\.map\(offer => `<button/);
});

test('Monthly-only and no-Monthly categories retain honest discovery states', () => {
  const monthlyOnly = core.filterPublicCategories([{ code: 'BOBTAIL', offeredDurations: [{ code: 'MONTHLY', unitRateCents: 15000 }] }]);
  assert.deepEqual(monthlyOnly[0].offeredDurations.map(item => item.code), ['MONTHLY']);
  assert.match(app, /offered\[0\] \|\| ''/);
  assert.match(app, /Monthly parking is not configured for this parking type/);
});

test('editing dates cannot mutate explicit product state and 30-day Daily remains Daily', () => {
  const inputHandler = app.slice(app.indexOf('function onDocumentInput'), app.indexOf('function bindMapPointerAndKeyboard'));
  assert.doesNotMatch(inputHandler, /selectedDuration\s*=/);
  const daily = { ...trip, departureLocal: '2026-09-03T15:00' };
  assert.match(core.tripFingerprint(daily), /\|DAILY\|/);
  assert.equal(core.productIntervalError(daily.duration, daily.arrivalLocal, daily.departureLocal, 28), '');
});

test('customer duration allowlist supports Daily, Weekly, and Monthly only', () => {
  assert.deepEqual(core.SUPPORTED_CUSTOMER_DURATIONS, ['DAILY', 'WEEKLY', 'MONTHLY']);
  assert.equal(core.supportedDuration('WEEKLY'), 'WEEKLY');
  assert.deepEqual(core.filterSupportedDurations([
    { code: 'DAILY', unitRateCents: 1900 },
    { code: 'WEEKLY', unitRateCents: 10000 },
    { code: 'MONTHLY', unitRateCents: 25000 }
  ]).map(item => item.code), ['DAILY', 'WEEKLY', 'MONTHLY']);
});

test('unknown-only catalog and availability responses become unavailable', () => {
  const catalog = core.filterPublicCategories([{ code: 'BOBTAIL', offeredDurations: [{ code: 'YEARLY', unitRateCents: 10000 }], startingRateCents: 10000 }]);
  assert.deepEqual(catalog[0].offeredDurations, []);
  assert.equal(catalog[0].startingRateCents, null);
  const results = core.validateAvailabilityResults({ results: [{ ...available, offeredDurations: [{ code: 'YEARLY', unitRateCents: 10000 }] }] }, 'BOBTAIL', 'DAILY');
  assert.equal(results[0].pricingAvailable, false);
  assert.deepEqual(results[0].offeredDurations, []);
});

test('Daily, Weekly, and Monthly retain their authoritative prices', () => {
  const offers = core.filterSupportedDurations([{ code: 'DAILY', unitRateCents: 1900 }, { code: 'WEEKLY', unitRateCents: 10000 }, { code: 'MONTHLY', unitRateCents: 25000 }]);
  assert.deepEqual(offers, [{ code: 'DAILY', unitRateCents: 1900 }, { code: 'WEEKLY', unitRateCents: 10000 }, { code: 'MONTHLY', unitRateCents: 25000 }]);
});

test('unsupported quote and booking durations are never shown as a supported product', () => {
  const response = { quote: { duration: 'YEARLY', totalCents: 10000 }, arrival: '2030-01-01T00:00:00Z', departure: '2031-01-01T00:00:00Z', categoryCode: 'BOBTAIL' };
  assert.equal(core.validateQuote(response, { ...trip, duration: 'DAILY' }, available), null);
  assert.equal(core.validateBooking({ reservationNumber: 'A', status: 'CONFIRMED', category: 'Bobtail', price: { duration: 'YEARLY', totalCents: 10000 } }).price.duration, null);
  assert.equal(lifecycle.entryFromBooking({ reservationNumber: 'A', status: 'CONFIRMED', category: 'Bobtail', price: { duration: 'YEARLY' } }, 'secret').parkingPeriod, null);
});

test('product changes participate in the trip identity and clear quote state', () => {
  const daily = { ...trip, duration: 'DAILY' };
  const monthly = { categoryCode: trip.categoryCode, arrivalLocal: trip.arrivalLocal, duration: 'MONTHLY' };
  assert.notEqual(core.tripFingerprint(daily), core.tripFingerprint(monthly));
  const durationChange = app.slice(app.indexOf('function setDuration'), app.indexOf('function selectOffer'));
  assert.match(durationChange, /invalidateSearchState/);
  assert.doesNotMatch(durationChange, /minimumMonthlyDays/);
  assert.match(app, /quoteToken: state\.quote\.data\?\.quoteToken/);
});

test('map entrance prefers route element then derives the 143/142 gap', () => {
  const map = { route: { entranceElementKey: 'gate' }, elements: [{ elementKey: 'gate', elementType: 'ENTRANCE', x: 80, y: 40, width: 10, height: 2 }] };
  assert.equal(core.resolveEntrance(map).source, 'route');
  const derived = core.resolveEntrance({ elements: [{ elementType: 'PARKING_SPOT', label: '143', x: 84, y: 30, width: 10, height: 3 }, { elementType: 'PARKING_SPOT', label: '142', x: 84, y: 44, width: 10, height: 3 }] });
  assert.equal(derived.source, 'spaces'); assert.equal(derived.y, 38.5);
});
test('map does not invent an entrance without safe geometry', () => {
  assert.equal(core.resolveEntrance({ elements: [] }), null);
});
test('route line renders only authoritative validated points', () => {
  assert.deepEqual(core.authoritativeRoutePoints({ route: { validated: false, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] } }), []);
  assert.equal(core.authoritativeRoutePoints({ route: { validated: true, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] } }).length, 2);
  assert.ok(!app.includes('accessX') && !app.includes('CUSTOMER_MAP_RANGE_LABELS'));
});
test('route element keys are resolved for visible styling', () => {
  const keys = core.routeElementKeys({ route: { entranceElementKey: 'entrance', arrivalRouteElementKeys: ['lane'] } }); assert.equal(keys.has('lane'), true); assert.ok(css.includes('.map-element.is-route'));
});
test('detail zoom reveals public stall numbers and assigned labels remain visible', () => {
  assert.ok(css.includes('.customer-map:not(.is-detail-zoom) .map-space:not(.is-assigned) span'));
  assert.ok(css.includes('.customer-map .map-space.is-assigned span { visibility: visible; }'));
});
test('fit resets zoom and map app resets scroll position', () => {
  assert.equal(core.nextMapZoom(2, 'fit'), 1); assert.ok(app.includes('target.scrollLeft = 0; target.scrollTop = 0'));
});
test('pointer pan cannot start on map controls', () => {
  assert.equal(core.canStartMapPan({ zoom: 2, button: 0, fromControl: true }), false); assert.equal(core.canStartMapPan({ zoom: 2, button: 0, fromControl: false }), true);
});
test('keyboard map pan zoom and fit are mapped', () => {
  assert.deepEqual(core.mapKeyboardAction('+', 1), { zoom: 'in' }); assert.deepEqual(core.mapKeyboardAction('Home', 2), { zoom: 'fit' }); assert.deepEqual(core.mapKeyboardAction('ArrowRight', 2), { pan: 'ArrowRight' });
});

test('lookup route exists independently of canonical lot loading', () => {
  assert.ok(html.includes('id="lookupView"')); assert.ok(app.indexOf('state.initialized = true') < app.lastIndexOf('loadCanonicalLot()'));
});
test('pay-on-site booking confirms directly and Monthly insurance remains optional', () => {
  const checkoutFlow = app.slice(app.indexOf('async function reserveParking'), app.indexOf('function bookingIsMonthly'));
  assert.ok(checkoutFlow.includes("request('/bookings'"));
  assert.doesNotMatch(checkoutFlow, /assertPaymentConfiguration|checkout-sessions/);
  assert.match(checkoutFlow, /insuranceFile && created\.publicToken/);
  assert.match(html, /Insurance card \(optional now\)/);
  assert.doesNotMatch(html, /Required for Monthly parking/);
});
test('Demo completion has no ordinary public control and requires server validation of a fragment token', () => {
  assert.doesNotMatch(html, /Skip Payment|Complete Demo Reservation|data-complete-demo/);
  assert.ok(app.includes("request('/payments/demo/authorization'"));
  assert.ok(app.includes("request('/payments/demo/confirm'"));
  assert.ok(app.includes('QA / DEMO SESSION ONLY'));
  assert.ok(app.includes('Financially paid'));
  assert.ok(app.includes("window.history.replaceState({ route: 'demo-payment' }, '', '#demo-payment')"));
  const route = app.slice(app.indexOf("rawRoute.startsWith('demo-payment')"), app.indexOf("rawRoute.startsWith('payment-return')"));
  assert.match(route, /await renderDemoPayment\(rawRoute\)/);
});
test('Demo reservation status is operationally active but explicitly not financially paid', () => {
  const view = core.reservationStatusView({ status: 'CONFIRMED', paymentStatus: 'DEMO_BYPASSED',
    parkingProduct: 'MONTHLY', assignmentMode: 'CUSTOMER_SELECTED_SPOT', assignedSpotLabel: '164' });
  assert.equal(view.active, true);
  assert.equal(view.financiallyPaid, false);
  assert.equal(view.label, 'DEMO / NO PAYMENT');
  assert.match(view.description, /No card was charged/);
});
test('My Parking and standalone documents use email + phone lookup and a read-only cookie grant', () => {
  assert.ok(html.includes('href="#my-parking"'));
  assert.ok(html.includes('href="#upload-documents"'));
  assert.ok(html.includes('id="myParkingView"'));
  assert.ok(html.includes('id="uploadDocumentsView"'));
  assert.ok(html.includes('id="lookupView"'));
  const routeViews = app.slice(app.indexOf('const routeViews'), app.indexOf('function hideAllRouteViews'));
  assert.ok(routeViews.includes("'#myParkingView'") && routeViews.includes("'#uploadDocumentsView'"));
  assert.ok(app.includes("accountRequest('/lookup'"));
  assert.ok(app.includes("accountRequest('/lookup/summary'"));
  assert.ok(app.includes("credentials: 'include'"));
  for (const field of ['name="email"', 'name="phone"']) assert.ok(app.includes(field));
  for (const field of ['name="name"', 'name="licensePlate"']) assert.ok(!app.includes(field));
  assert.ok(app.includes("['current','Current']"));
  assert.ok(app.includes("['payments','Payments']"));
  assert.ok(app.includes("['documents','Documents']"));
  assert.ok(app.includes('data-document-type-choice="DRIVER_LICENSE"') && app.includes('data-document-type-choice="INSURANCE"'));
  assert.ok(app.includes("lookupMutation('/documents/complete'"));
  assert.ok(app.includes('state.accountGrantDocumentType !== uploadState.type'));
  assert.ok(app.includes('id="uploadReservationSelect"'));
  assert.ok(app.includes("replacing ? 'Replace' : 'Upload'"));
  assert.ok(!app.includes('data-account-document='));
  assert.ok(!app.includes("accountRequest('/auth/start'"));
  assert.ok(!app.includes('verification code'));
  for (const control of ['data-account-billing', 'data-account-receipt', 'data-account-cancel-monthly', 'data-account-remove-vehicle']) assert.ok(!app.includes(control));
  assert.ok(!html.includes('type="password"'));
  assert.ok(css.includes('@media(max-width:420px)'));
});
test('My Parking presents a null Monthly end date as ongoing', () => {
  const reservationCard = app.slice(app.indexOf('function accountReservationCard'), app.indexOf('function accountEmpty'));
  assert.match(reservationCard, /monthly && !item\.endsAt \? 'Ongoing \(due on the 1st\)' : accountDate\(item\.endsAt\)/);
  assert.match(reservationCard, /item\.space \? `Space \$\{item\.space\}`/);
});
test('unknown non-local hosts fail closed instead of targeting production', () => {
  const source = fs.readFileSync(path.join(root, 'config.js'), 'utf8'); const window = { location: { hostname: 'preview-123.onrender.com' } }; vm.runInNewContext(source, { window, URL }); assert.equal(window.PARKING_CONFIG.apiBase, ''); assert.equal(window.PARKING_CONFIG.configured, false);
});
test('exact production host and explicit runtime configuration are supported', () => {
  const runtime = fs.readFileSync(path.join(root, 'render-runtime.js'), 'utf8'); const configSource = fs.readFileSync(path.join(root, 'config.js'), 'utf8');
  const window = { location: { hostname: 'trucker-heaven-parking-a437.onrender.com' }, PARKING_API_BASE: 'https://explicit.test/api', PARKING_SUPPORT_PHONE_DISPLAY: '615 470 5075' };
  vm.runInNewContext(runtime, { window, Set }); vm.runInNewContext(configSource, { window, URL }); assert.equal(window.PARKING_CONFIG.apiBase, 'https://explicit.test/api'); assert.equal(window.PARKING_CONFIG.supportPhoneDisplay, '615-470-5075'); assert.equal(window.PARKING_CONFIG.supportPhone, '6154705075');
});
test('confirmation polling updates dedicated regions instead of full-page rerendering', () => {
  const start = app.slice(app.indexOf('function startAssignmentPolling'), app.indexOf('async function checkAssignmentStatus'));
  assert.ok(start.includes('updateConfirmationDynamic')); assert.ok(!start.includes('renderConfirmationView'));
});
