const test = require('node:test');
const assert = require('node:assert/strict');
const { publicTerms, bookingActions } = require('../services/publicBookingContract');

test('public terms are versioned from configured effective content', () => {
  const location = { payment_instructions: 'Pay at the office.', arrival_instructions: 'Check in with the office.', cancellation_cutoff_hours: 2 };
  const terms = publicTerms(location);
  assert.equal(terms.available, true);
  assert.match(terms.version, /^[a-f0-9]{16}$/);
  assert.deepEqual(terms.parking.content, ['Pay at the office.', 'Check in with the office.']);
  assert.equal(publicTerms({ cancellation_cutoff_hours: 2 }).available, false);
});

test('booking capabilities are authoritative for cancellation and check-in lifecycle', () => {
  const arrival = Date.parse('2030-01-02T12:00:00Z');
  const base = {
    status: 'CONFIRMED', arrival_at: new Date(arrival).toISOString(), departure_at: new Date(arrival + 86400000).toISOString(),
    cancellation_cutoff_hours: 2, check_in_early_minutes: 60, check_in_late_minutes: 120,
    self_service_enabled: true, assignment_mode_snapshot: 'CUSTOMER_SELECTED_SPOT', parking_spot_id: 62
  };
  const beforeWindow = bookingActions(base, arrival - 3 * 3600000);
  assert.equal(beforeWindow.canCancel, true); assert.equal(beforeWindow.canCheckIn, false);
  assert.equal(beforeWindow.opensAt, new Date(arrival - 3600000).toISOString());
  const open = bookingActions(base, arrival);
  assert.equal(open.canCheckIn, true); assert.equal(open.canCheckOut, false);
  const checkedIn = bookingActions({ ...base, status: 'CHECKED_IN' }, arrival);
  assert.equal(checkedIn.canCheckOut, true); assert.equal(checkedIn.canCancel, false);
});

test('parking-area reservations self-serve without an exact numbered-space assignment', () => {
  const now = Date.parse('2030-01-02T12:00:00Z');
  const base = {
    status: 'CONFIRMED', assignment_mode_snapshot: 'ZONE_CAPACITY', inventory_id: 28,
    arrival_at: new Date(now - 60000).toISOString(), departure_at: new Date(now + 3600000).toISOString(),
    check_in_early_minutes: 60, check_in_late_minutes: 120, cancellation_cutoff_hours: 0,
    self_service_enabled: true, parking_spot_id: null
  };
  const confirmed = bookingActions(base, now);
  assert.equal(confirmed.canCheckIn, true);
  assert.equal(confirmed.canCheckOut, false);
  const checkedIn = bookingActions({ ...base, status: 'CHECKED_IN' }, now);
  assert.equal(checkedIn.canCheckOut, true);
});

test('open-ended Monthly parking can self check-in during its arrival window', () => {
  const arrival = Date.parse('2030-01-02T12:00:00Z');
  const monthly = {
    status: 'CONFIRMED', parking_product: 'MONTHLY', arrival_at: new Date(arrival).toISOString(), departure_at: null,
    cancellation_cutoff_hours: 2, check_in_early_minutes: 60, check_in_late_minutes: 120,
    self_service_enabled: true, assignment_mode_snapshot: 'CUSTOMER_SELECTED_SPOT', parking_spot_id: 62
  };
  assert.equal(bookingActions(monthly, arrival).canCheckIn, true);
  assert.equal(bookingActions(monthly, arrival + 3 * 3600000).canCheckIn, false, 'the arrival window still closes');
});
