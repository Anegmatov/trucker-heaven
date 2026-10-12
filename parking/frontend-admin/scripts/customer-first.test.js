'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const reservationDesk = fs.readFileSync(path.join(root, 'reservation-desk.js'), 'utf8');
const liveModel = fs.readFileSync(path.join(root, '..', 'backend', 'services', 'liveLotReadModel.js'), 'utf8');
const adminParking = fs.readFileSync(path.join(root, '..', 'backend', 'routes', 'adminParking.js'), 'utf8');
const exactSpace = fs.readFileSync(path.join(root, '..', 'backend', 'services', 'exactSpaceService.js'), 'utf8');
const adminDesk = fs.readFileSync(path.join(root, '..', 'backend', 'routes', 'adminReservationDesk.js'), 'utf8');

test('Live Lot carries the canonical customer id and makes Open Customer the occupied-space primary action', () => {
  assert.match(liveModel, /current_customer\.id=current_booking\.customer_id/);
  assert.match(liveModel, /publicId: row\.current_customer_public_id \|\| null/);
  assert.match(liveModel, /publicId: current\.customer_public_id/);
  assert.match(app, /class="btn primary full open-customer-cta" data-customer-id="\$\{escapeHtml\(customer\.publicId\)\}"/);
  assert.match(app, /class="customer-primary-name" data-customer-id="\$\{escapeHtml\(customer\.publicId\)\}"/);
  assert.match(app, /data-live-lot-move="\$\{escapeHtml\(currentReservation\.id\)\}"/);
  assert.match(app, /data-desk-space-id=.*New Booking/);
  assert.match(app, /data-live-lot-move=.*Move Customer/);
  assert.match(app, /data-live-lot-end=.*End Parking/);
  assert.match(app, /api\.spotAlternatives\(bookingId\)/);
  assert.match(app, /api\.reassignSpot\(move\.bookingId/);
  assert.doesNotMatch(app, /data-move-booking/);
  assert.doesNotMatch(app, /customers?\.find\([^\n]*(name|displayName)/i);
});

test('visible navigation is simplified while operational destinations remain available to their existing actions', () => {
  assert.match(app, /const VISIBLE_OPERATIONS_SCREENS = \['Overview', 'Live Lot', 'Reservations', 'Customers', 'Summary'\]/);
  assert.match(app, /const VISIBLE_MANAGEMENT_SCREENS = \['Lot Setup', 'Business Settings', 'Team'\]/);
  assert.match(app, /renderNavigationGroup\('Operations', VISIBLE_OPERATIONS_SCREENS\)/);
  assert.match(app, /renderNavigationGroup\('Management', state\.user\?\.role === 'OWNER' \? VISIBLE_MANAGEMENT_SCREENS : \[\]\)/);
  assert.match(app, /Summary: renderSummary/);
  assert.match(app, /data-nav="Reservation Desk">New Booking/);
});

test('Reservations lead with Lot and Customer and use canonical links for both relationships', () => {
  assert.ok(app.includes('<th>Lot #</th><th>Customer</th><th>Plate / Unit</th><th>Type</th><th>Dates</th><th>Payment</th><th>Status</th>'));
  assert.match(adminParking, /customer\.public_id customer_public_id/);
  assert.match(adminParking, /s\.id assigned_spot_id/);
  assert.match(app, /data-open-space-id="\$\{escapeHtml\(booking\.assigned_spot_id\)\}"/);
  assert.match(app, /data-customer-id="\$\{escapeHtml\(booking\.customer_public_id\)\}"/);
  assert.match(app, /state\.screen = 'Live Lot';[\s\S]*loadSpaceDetail\(id\)/);
});

test('Overview is an attention page with customer, document, parking, and compact summary handoffs', () => {
  assert.match(app, /What requires action right now\?/);
  assert.match(app, /Overdue Payments/);
  assert.match(app, /Documents to Review/);
  assert.match(app, /Parking Attention/);
  assert.match(app, /Parking Summary/);
  assert.match(app, /api\.customers\(\{ payment: 'OVERDUE', limit: 100 \}\)/);
  assert.match(app, /data-overdue-customers/);
  assert.match(app, /api\.documents\(\{ status: 'PENDING_REVIEW' \}\)/);
  assert.match(app, /\['OVERDUE', 'PAID_ALLOCATION_REVIEW'\]/);
  assert.match(app, /\['Daily Active', activeByProduct\('DAILY'\)\]/);
  assert.match(app, /overviewBadge\(overdueCustomers\.length, 'pastdue'\)/);
  assert.match(app, /documentByCustomerAndType\.has\(key\)/);
  assert.match(app, /overviewBadge\(actionableDocuments\.length, 'reserved'\)/);
  assert.match(app, /class="calendar-event clickable-row" data-customer-id="\$\{escapeHtml\(document\.customerPublicId\)\}" data-customer-focus="documents"/);
  assert.match(app, /— \$\{escapeHtml\(documentTypeLabel\(document\.type\)\)\} review<\/button>/);
  assert.match(app, /loadCustomerDetail\(element\.dataset\.customerId, element\.dataset\.customerFocus \|\| ''\)/);
  assert.match(app, /id="customerDocuments" tabindex="-1"/);
  assert.match(app, /overviewBadge\(parkingAttention\.length, 'pastdue'\)/);
  assert.match(app, /No overdue payments\./);
  assert.match(app, /No documents require review\./);
  assert.match(app, /No parking issues requiring attention\./);
  assert.match(app, /operations-strip overview-today-strip" aria-label="Parking summary"/);
  assert.match(app, /parkingSummary\.map\(\(\[label, value\]\) => `<div class="dashboard-kpi">/);
  assert.doesNotMatch(app, /overview-attention-strip/);
  assert.doesNotMatch(app, /Today’s Departures/);
  assert.doesNotMatch(app, /Upcoming Arrivals/);
  assert.doesNotMatch(app, /Parking & Reservation Follow-up/);
  assert.doesNotMatch(app, /dashboard\.documentsPendingReview/);
});

test('New Booking follows the three-step customer-first pipeline and keeps prices out of position labels', () => {
  assert.match(reservationDesk, /\['Customer & Vehicle', 'Parking', reviewLabel\(\)\]/);
  assert.match(reservationDesk, /payOnSite\(\) \? 'Review' : 'Review & Payment'/);
  assert.match(reservationDesk, /<h2>NEW BOOKING<\/h2>/);
  assert.match(reservationDesk, /Name, phone, email, plate, unit, DOT or MC/);
  assert.match(reservationDesk, /field\('mcNumber', 'MC number'/);
  assert.match(reservationDesk, /<h3>\$\{escapeHtml\(reviewLabel\(\)\)\}<\/h3>/);
  assert.match(reservationDesk, /<p>BOOKING COMPLETE<\/p>/);
  assert.match(reservationDesk, /createReservationDeskCustomer/);
  assert.match(adminDesk, /router\.post\('\/reservation-desk\/customers'/);
  assert.match(adminDesk, /RESERVATION_DESK_CUSTOMER_SAVED/);
  assert.match(reservationDesk, /applyPreselectedSpace/);
  assert.doesNotMatch(reservationDesk, /Position \$\{escapeHtml\(position\.label\)\} · \$\{money\(position\.standardPriceCents\)\}/);
  assert.match(reservationDesk, /Insurance optional/);
  assert.match(reservationDesk, /Missing - upload optional/);
  assert.doesNotMatch(reservationDesk, /Insurance required|Required before payment link|must pass secure storage inspection first/);
  assert.doesNotMatch(reservationDesk, /booking\.product === 'MONTHLY' && !insurance \? 'disabled'/);
  assert.match(reservationDesk, /option value="WEEKLY"/);
  assert.match(reservationDesk, /WEEKLY: 'Weekly'/);
  assert.match(reservationDesk, /\$100 every 7 days until parking is ended\./);
  assert.match(reservationDesk, /if \(!openEndedTerm\(event\.currentTarget\.elements\.duration\.value\)\) keys\.push\('departureLocal'\)/);
  assert.match(reservationDesk, /parking\.duration === 'WEEKLY' \? '.*every 7 days/);
  assert.match(reservationDesk, /booking\.product === 'WEEKLY' && !booking\.departureAt/);
  assert.match(adminDesk, /bookingDeparture: openEnded \? null : local\.end/);
  assert.match(adminDesk, /weeklyCheckoutPlan/);
  assert.match(app, /Upcoming \/ Reserved · zone capacity/);
  assert.match(reservationDesk, /function openForSpace/);
  assert.match(reservationDesk, /async function openReservation/);
});

test('Move candidates share final reassignment eligibility and only valid map targets are interactive', () => {
  assert.match(adminParking, /eligibleReassignmentSpots\(pool, booking, current\)/);
  assert.match(exactSpace, /async function eligibleReassignmentSpots/);
  assert.match(exactSpace, /replacementSpotId, lock: true/);
  assert.match(app, /moveUnavailable \? 'move-unavailable' : ''/);
  assert.match(app, /moveUnavailable \? 'disabled' : ''/);
  assert.match(css, /\.operational-map-space\.move-destination\{[^}]*var\(--brand-green\)/);
  assert.match(css, /\.operational-map-space\.move-unavailable\{[^}]*opacity:\.28/);
});

test('Move preserves the reservation term and confirmed future assignments (paid or pay-on-site) are visible as Reserved', () => {
  assert.match(exactSpace, /\(\$6='DAILY' AND e\.daily_eligible\)/);
  assert.match(exactSpace, /\(\$6='WEEKLY' AND e\.weekly_eligible\)/);
  assert.match(exactSpace, /\(\$6='MONTHLY' AND e\.monthly_eligible\)/);
  assert.match(liveModel, /b\.payment_status IN \('PAID','NOT_REQUIRED','DEMO_BYPASSED'\)[\s\S]*a\.reserved_arrival_at>\$2/);
  assert.match(liveModel, /paymentStatus: row\.payment_status \|\| null/);
  assert.match(app, /const futureReserved = currentReservation\?\.status === 'CONFIRMED'/);
  assert.match(app, /<strong>RESERVED<\/strong><span> Starts/);
  assert.match(app, /<dt>Start date<\/dt>/);
});

test('Demo QA controls are server and Owner gated and never present as a normal public payment choice', () => {
  assert.match(reservationDesk, /state\.bootstrap\.demoPayment\?\.enabled/);
  assert.match(reservationDesk, /hasPermission\('reservation\.demo_bypass'\)/);
  assert.match(reservationDesk, /booking\.paymentStatus === 'DRAFT'/);
  assert.match(reservationDesk, /Create one-time QA Demo Link/);
  assert.match(reservationDesk, /DEMO \/ NO PAYMENT/);
  assert.match(reservationDesk, /Financially paid: NO/);
  assert.match(reservationDesk, /Not included in revenue/);
  assert.match(app, /DEMO_BYPASSED: 'Demo Payment'/);
  assert.match(app, /paymentDisplay\(booking\.payment_status\)/);
  assert.match(app, /Financially paid:<\/b> NO · This QA reservation is excluded from revenue/);
});

test('Overview overdue amount drills into a visibly filtered customer list', () => {
  assert.match(app, /data-overdue-customers/);
  assert.match(app, /payment: 'OVERDUE'/);
  assert.match(app, /customerFocusPayment = 'OVERDUE'/);
  assert.match(app, /first\.classList\.add\('is-focused-result'\)/);
});

test('Customers use the canonical operational filters and workspace separates current from reserved parking', () => {
  const adminCustomers = fs.readFileSync(path.join(root, '..', 'backend', 'routes', 'adminCustomers.js'), 'utf8');
  assert.match(app, /Name, phone, email, plate, unit, DOT\/MC/);
  assert.match(app, /data-customer-filter="\$\{name\}"/);
  assert.match(app, /filterButton\('status', 'ACTIVE', 'Active'\)/);
  assert.match(app, /filterButton\('documents', 'REVIEW', 'Documents'\)/);
  assert.match(app, /filterButton\('parking', 'UNASSIGNED', 'Unassigned'\)/);
  assert.ok(app.includes('<th>CUSTOMER</th><th>PARKING</th><th>VEHICLE</th><th>PAYMENT</th><th>DOCUMENTS</th>'));
  assert.match(adminCustomers, /\['CURRENT', 'UPCOMING', 'UNASSIGNED', 'PAST_ONLY', 'NONE'\]/);
  assert.match(adminCustomers, /document\.verification_status='PENDING_REVIEW'/);
  assert.match(app, /<div class="panel-head">Current Parking<\/div>/);
  assert.match(app, /<div class="panel-head">Upcoming Parking<\/div>/);
  assert.match(app, /data-customer-move=/);
  assert.match(app, /data-customer-end=/);
  assert.match(app, /data-customer-payment/);
  assert.match(app, /data-open-space-id=/);
  assert.doesNotMatch(app, /<dt>Source<\/dt>/);
  assert.doesNotMatch(app, /Legacy Evidence Anomalies/);
});

test('Reservation detail exposes a near-top customer section and canonical Customers navigation', () => {
  const customerSection = app.indexOf('class="reservation-customer-section"');
  const statusGrid = app.indexOf('<div class="grid-4">', customerSection);
  assert.ok(customerSection > -1 && statusGrid > customerSection, 'Customer section must precede reservation status snapshots.');
  assert.match(app, /data-customer-id="\$\{escapeHtml\(account\.publicId\)\}">Open Customer<\/button>/);
  assert.match(app, /event\.stopPropagation\(\);\s*state\.screen = 'Customers'; loadCustomerDetail\(element\.dataset\.customerId, element\.dataset\.customerFocus \|\| ''\)/);
});

test('Trucker Heaven theme uses official allocation fills and status-only markers', () => {
  assert.match(css, /\/\* Trucker Heaven branded operations system\./);
  assert.match(css, /--brand-blue:#2855a5/);
  assert.match(css, /--brand-green:#95b85a/);
  assert.match(css, /--bg:#f4f7f8/);
  assert.match(css, /\.operational-map-space\.allocation-monthly-bobtail\{[^}]*background:#63ad42!important/);
  assert.match(css, /\.operational-map-space\.allocation-monthly-truck-trailer\{[^}]*background:#2855a5!important/);
  assert.match(css, /\.operational-map-space\.allocation-car-hauler\{[^}]*background:#7a3db8!important/);
  assert.match(css, /\.operational-map-space\.allocation-daily\{[^}]*background:#f4cf23!important/);
  assert.match(css, /\.operational-map-space\.allocation-shop\{[^}]*background:#d43c32!important/);
  assert.match(css, /\.operational-map-space\.allocation-company\{[^}]*background:#718089!important/);
  assert.doesNotMatch(css, /\.operational-map-space\.(?:available|occupied|blocked)\{[^}]*background:/);
  assert.match(css, /\.space-details-drawer\{[^}]*background:var\(--glass-strong\)/);
  assert.doesNotMatch(css, /\/\* Daylight operations theme:/);
  assert.doesNotMatch(css, /\/\* Focused premium blue-glass tone\./);
  assert.doesNotMatch(css, /--bg:#c9d8e5/);
  assert.doesNotMatch(css, /background:linear-gradient\(110deg,rgb\(5 34 65\/\.94\),rgb\(13 65 106\/\.87\)\)/);
});
