'use strict';

// End-to-end check of the customer site in a real browser. Needs the API (with the published real
// lot) and `npm run serve:dist` running. Usage: PARKING_CUSTOMER_URL=http://127.0.0.1:5181 npm run verify:ui
let chromium;
try { ({ chromium } = require('playwright')); } catch (_) { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }
const base = (process.env.PARKING_CUSTOMER_URL || 'http://127.0.0.1:5181').replace(/\/$/, '');
const fill = async (page, values) => { for (const [k, v] of Object.entries(values)) await page.fill(`#${k}`, v); };
// Wait for the map to reload after changing the dates or term.
const settle = async page => { await page.waitForTimeout(600); await page.waitForSelector('#mapLoading', { state: 'hidden' }); };

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = page => { page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); };
  for (const width of [360, 768, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(`${base}/`, { waitUntil: 'networkidle' });
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
    if (scroll > width) throw new Error(`Horizontal scroll at ${width}px (${scroll}px)`);
    if (await page.locator('g.sp').count() !== 185) throw new Error('The lot map must draw all 185 numbered spaces');
    await page.close();
  }
  // Daily on a phone: tap a space, reserve from the bottom bar, and the space is held.
  let page = await browser.newPage({ viewport: { width: 390, height: 844 } }); watch(page);
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  const day = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
  const setDailyDates = async target => { await target.fill('#arrivalDate', day(9)); await target.fill('#departureDate', day(11)); await settle(target); };
  await setDailyDates(page);
  await page.waitForSelector('g.sp.is-open');
  const dailySpace = await page.locator('g.sp.is-open').first().getAttribute('data-space');
  await page.click(`g.sp[data-space="${dailySpace}"]`);
  await page.waitForSelector(`g.sp.is-mine[data-space="${dailySpace}"]`);
  await page.click('#mobileBar [data-reserve]'); await page.waitForSelector('#sheetSummary .price');
  await fill(page, { firstName: 'Ali', lastName: 'Driver', mobilePhone: '6155550101', email: 'ali.driver@example.test', licensePlate: 'ABC1234', licensePlateState: 'TN', tractorUnitNumber: 'T-101' });
  await page.click('#confirmButton');
  if (!(await page.isVisible('#termsAccepted-error'))) throw new Error('Terms must be required');
  await page.check('#termsAccepted'); await page.click('#confirmButton');
  await page.waitForSelector('.ticket', { timeout: 15000 });
  if (!(await page.textContent('.where strong')).includes(dailySpace)) throw new Error('Daily confirmation must show the picked space');
  const hash = await page.evaluate(() => location.hash);
  // Another driver looking at the same dates sees that space as taken.
  const rival = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage(); watch(rival);
  await rival.goto(`${base}/`, { waitUntil: 'networkidle' }); await setDailyDates(rival);
  await rival.waitForSelector(`g.sp.is-taken[data-space="${dailySpace}"]`);
  // Cancelling frees it again.
  const other = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage(); watch(other);
  await other.goto(`${base}/${hash}`, { waitUntil: 'networkidle' }); await other.waitForSelector('.ticket');
  await other.click('[data-cancel-open]'); await other.click('[data-cancel-confirm]'); await other.waitForSelector('.status.s-cancelled');
  await rival.reload({ waitUntil: 'networkidle' }); await setDailyDates(rival);
  await rival.waitForSelector(`g.sp.is-open[data-space="${dailySpace}"]`);
  // Weekly: picking a space gets a price for that space.
  await rival.locator('input[name=duration][value=WEEKLY]').check({ force: true });
  await settle(rival);
  await rival.locator('g.sp.is-open').first().click();
  await rival.waitForSelector('#pick .price');
  // Monthly on desktop: tap a space on the map, then book it.
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } }); watch(page);
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  await page.locator('input[name=duration][value=MONTHLY]').check({ force: true });
  await settle(page);
  const space = await page.locator('g.sp.is-open').first().getAttribute('data-space');
  await page.click(`g.sp[data-space="${space}"]`);
  await page.waitForSelector(`g.sp.is-mine[data-space="${space}"]`);
  await page.click('#pick [data-reserve]'); await page.waitForSelector('#sheetSummary .price');
  await fill(page, { firstName: 'Maria', lastName: 'Lopez', mobilePhone: '6155550199', email: 'maria@example.test', licensePlate: 'MON555', licensePlateState: 'TN', tractorUnitNumber: '77' });
  await page.check('#termsAccepted'); await page.click('#confirmButton');
  if (!(await page.isVisible('#companyName-error'))) throw new Error('Monthly company requirement not shown');
  await page.fill('#companyName', 'Lopez Freight LLC'); await page.click('#confirmButton');
  await page.waitForSelector('.ticket', { timeout: 15000 });
  if (!(await page.textContent('.where strong')).includes(space)) throw new Error('Confirmation must show the picked space');
  if (errors.length) throw new Error(`Browser errors: ${errors.join(' | ')}`);
  console.log(`Customer UI verified: 185-space lot map, Daily space ${dailySpace} held then freed, Weekly priced, Monthly space ${space} picked on the map and booked.`);
  await browser.close();
})().catch(error => { console.error(error.message); process.exit(1); });
