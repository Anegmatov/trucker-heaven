const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'frontend-customer/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'frontend-customer/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'frontend-customer/styles.css'), 'utf8');
const config = fs.readFileSync(path.join(root, 'frontend-customer/config.js'), 'utf8');
const checks = [
  ['four-step customer journey', ['tripStep', 'parkingStep', 'driverStep', 'confirmation', 'setStep'].every(value => html.includes(value) || app.includes(value))],
  ['canonical published layout loading', app.includes("request('/canonical-lot')") && app.includes('state.layout = response.layout || null') && app.includes("request('/availability'") && app.includes('availability.layout')],
  ['designed no-layout fallback', app.includes('published parking map is not available') && app.includes('state.layout = response.layout || null')],
  ['Bobtail and General Truck choice cards', html.includes('Choose your parking type') && app.includes('Bobtail Parking') && app.includes('General Truck Parking') && app.includes('data-parking-type')],
  ['dynamic duration and rate presentation', app.includes('offeredDurations') && app.includes('startingRateCents') && app.includes('ratePlanName') && !`${html}\n${app}`.includes('$19') && !`${html}\n${app}`.includes('$250')],
  ['no hardcoded customer lot map', !html.includes('customerLotMap') && app.includes('renderLotMap') && app.includes('availabilityLayout')],
  ['availability and pricing separate', app.includes('pricingAvailable') && app.includes('Pricing is not configured for this booking period') && app.includes('numberedSpacesAvailable')],
  ['guided map does not select a space', app.includes('is-guided-available') && app.includes('matchesSelection') && !html.includes('Select a space') && !app.includes('selectedSpotId')],
  ['map controls and accessible guidance', app.includes('data-map-zoom') && app.includes('renderBookingMaps') && app.includes('customerMapPresentation') && app.includes('CUSTOMER_ENTRANCE_MARKER') && html.includes('map-summary') && css.includes('map-controls')],
  ['canonical direct booking flow', !html.includes('id="parkingArea"') && !app.includes("request('/parking-areas'") && !app.includes('currentParkingArea') && app.includes('currentParkingLot') && app.includes('state.trip = values')],
  ['human-readable timezone display', app.includes('Intl.DateTimeFormat') && app.includes('timeZoneName') && app.includes('area.timezone')],
  ['no customer-facing legacy location or zone wording', ['South Zone', 'North Zone', 'Select location', 'Choose location', 'Select zone', 'Choose zone', 'Parking location', 'Zone map'].every(value => !`${html}\n${app}`.includes(value))],
  ['booking and lookup contracts', app.includes("request('/bookings'") && app.includes("request('/bookings/lookup'") && app.includes('/cancel') && app.includes('Idempotency-Key')],
  ['server quote breakdown and dynamic confirmation', app.includes('quoteDetails') && app.includes('baseParkingCents') && app.includes('feesCents') && app.includes('taxCents') && app.includes('Pending confirmation') && app.includes('YOUR ASSIGNED PARKING SPACE')],
  ['durable private confirmation', app.includes('confirmationStorageKey') && app.includes('persistConfirmation') && app.includes('restoreSavedConfirmation') && app.includes('localStorage')],
  ['parent and support URLs configured', config.includes('parentSiteUrl') && config.includes('supportPhone') && html.includes('parentSiteLink')],
  ['responsive and accessible controls', css.includes('@media (max-width: 680px)') && css.includes('focus-visible') && html.includes('aria-live') && css.includes('overflow-x: hidden') && app.includes('closeDialog')]
];
for (const [name, passed] of checks) if (!passed) throw new Error(`Customer booking verification failed: ${name}`);
console.log(`Customer booking frontend verified: ${checks.length} checks.`);
