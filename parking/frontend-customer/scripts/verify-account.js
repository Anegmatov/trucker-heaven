'use strict';

// Browser check of the after-booking features: documents on the reservation page, self check-in/out
// (when the lot allows it), print, My Parking and the Upload a document page. Needs the API (with
// DOCUMENT_STORAGE_PROVIDER=LOCAL or S3) and `npm run serve:dist`.
// Usage: PARKING_CUSTOMER_URL=http://127.0.0.1:5181 SELF_SERVICE=1 node scripts/verify-account.js
let chromium;
try { ({ chromium } = require('playwright')); } catch (_) { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }
const base = (process.env.PARKING_CUSTOMER_URL || 'http://127.0.0.1:5181').replace(/\/$/, '');
const selfService = process.env.SELF_SERVICE === '1';
// A tiny valid PNG to upload.
const png = { name: 'license.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') };
const driver = { firstName: 'Dana', lastName: `Check${Date.now() % 100000}`, mobilePhone: '6155550177', email: `dana.${Date.now()}@example.test`, licensePlate: `DC${Date.now() % 10000}`, licensePlateState: 'TN', tractorUnitNumber: 'D-7' };

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) errors.push(m.text()); });
  const settle = async () => { await page.waitForTimeout(600); await page.waitForSelector('#mapLoading', { state: 'hidden' }); };

  // Book a Daily space starting soon.
  await page.goto(`${base}/`, { waitUntil: 'networkidle' }); await settle();
  await page.locator('g.sp.is-open').first().click();
  await page.waitForSelector('#holdTimer:text-matches("held for you", "i")');
  await page.click('#pick [data-reserve]'); await page.waitForSelector('#sheetSummary .price');
  for (const [field, value] of Object.entries(driver)) await page.fill(`#${field}`, value);
  await page.check('#termsAccepted'); await page.click('#confirmButton');
  await page.waitForSelector('.ticket', { timeout: 15000 });
  const reservationNumber = (await page.textContent('.resnum')).trim();

  // Documents card: upload a driver license with the reservation's access code.
  await page.waitForSelector('[data-doc-status="DRIVER_LICENSE"]:text("Not added")');
  await page.setInputFiles('[data-doc-upload="DRIVER_LICENSE"]', png);
  await page.waitForSelector('[data-doc-status="DRIVER_LICENSE"]:text("Received")', { timeout: 15000 });
  if (!(await page.isVisible('[data-print]'))) throw new Error('Print pass must be offered');

  // Self check-in and check-out, when the lot allows it.
  if (selfService) {
    await page.click('[data-check-in]'); await page.waitForSelector('.status.s-checked_in');
    await page.click('[data-check-out]'); await page.waitForSelector('.status:not(.s-checked_in)');
  } else if (await page.isVisible('[data-check-in]')) throw new Error('Check-in must stay hidden when the lot has it switched off');

  // My Parking: email and phone find the reservation and its document.
  await page.goto(`${base}/#my-parking`, { waitUntil: 'networkidle' });
  await page.fill('#accountForm [name=email]', driver.email);
  await page.fill('#accountForm [name=phone]', driver.mobilePhone);
  await page.click('#accountForm button[type=submit]');
  await page.waitForSelector('.account-tabs');
  for (const tab of ['current', 'upcoming', 'past']) {
    await page.click(`[data-account-tab="${tab}"]`);
    if (await page.locator(`.resnum:text("${reservationNumber}")`).count()) break;
  }
  if (!(await page.locator(`.resnum:text("${reservationNumber}")`).count())) throw new Error('My Parking must list the reservation');
  await page.click('[data-account-tab="documents"]');
  await page.waitForSelector('.account-list li:has-text("Driver license"):has-text("Received")');

  // Upload a document page: insurance, verified with email and phone.
  await page.click('.account-body a[href="#upload"]');
  await page.locator('[data-view="upload"] input[name=docType][value=INSURANCE]').check({ force: true });
  await page.fill('#uploadIdentityForm [name=email]', driver.email);
  await page.fill('#uploadIdentityForm [name=phone]', driver.mobilePhone);
  await page.click('#uploadIdentityForm button[type=submit]');
  await page.setInputFiles('#uploadForm [data-upload-file]:not([capture])', { ...png, name: 'insurance.png' });
  await page.click('#uploadForm button[type=submit]');
  await page.waitForSelector('[data-upload-again]', { timeout: 15000 });
  await page.goto(`${base}/#my-parking`, { waitUntil: 'networkidle' });
  await page.click('[data-account-tab="documents"]');
  await page.waitForSelector('.account-list li:has-text("Insurance"):has-text("Received")');
  await page.click('[data-account-signout]'); await page.waitForSelector('#accountForm');

  if (errors.length) throw new Error(`Browser errors: ${errors.join(' | ')}`);
  console.log(`After-booking features verified for ${reservationNumber}: documents upload, ${selfService ? 'self check-in/out, ' : ''}print, My Parking and Upload a document.`);
  await browser.close();
})().catch(error => { console.error(error.message); process.exit(1); });
