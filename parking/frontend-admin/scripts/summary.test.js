'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const api = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const adminParking = fs.readFileSync(path.join(root, '..', 'backend', 'routes', 'adminParking.js'), 'utf8');

test('Summary reconciles parking KPIs through the canonical Live Lot snapshot', () => {
  assert.match(adminParking, /router\.get\('\/summary'/);
  assert.match(adminParking, /liveLotReadModel\.snapshot\(pool, lot\.id, evaluatedAt\)/);
  assert.match(adminParking, /totalCustomerSpaces: Number\(liveSnapshot\.summary\.customerSpaces/);
  assert.match(adminParking, /available: Number\(liveSnapshot\.summary\.availableCustomerSpaces/);
  assert.match(adminParking, /occupied: Number\(liveSnapshot\.summary\.occupied/);
  assert.match(adminParking, /reserved: Number\(liveSnapshot\.summary\.reserved/);
  assert.match(app, /Total Customer Spaces/);
  assert.match(app, /Matches Live Lot/);
});

test('Summary payment totals use paid customer-ledger entries with their corrections exactly once', () => {
  assert.match(adminParking, /FROM parking_customer_payments payment/);
  assert.match(adminParking, /payment\.status='PAID'/);
  assert.match(adminParking, /payment\.payment_date<=\(\$1::timestamptz AT TIME ZONE \$2\)::date/);
  assert.match(adminParking, /LEFT JOIN parking_customer_payment_adjustments adjustment ON adjustment\.payment_id=payment\.id/);
  assert.match(adminParking, /payment\.amount_cents\+COALESCE\(sum\(adjustment\.amount_cents\),0\) amount_cents/);
  assert.match(adminParking, /payments_by_month/);
  assert.match(adminParking, /revenue_by_product/);
  assert.doesNotMatch(adminParking.slice(adminParking.indexOf("router.get('/summary'"), adminParking.indexOf("router.get('/dashboard'")), /TRUCK PARKING CLUB|FLEET|ACCOUNTING/i);
});

test('Summary renders compact KPI, mix, executive, and chart sections responsively', () => {
  assert.match(api, /summary\(\) \{ return request\('\/admin\/parking\/v1\/summary'\); \}/);
  assert.match(app, /Paid This Month/);
  assert.match(app, /Paid YTD/);
  assert.match(app, /Outstanding/);
  assert.match(app, /Parking Mix/);
  assert.match(app, /Executive Summary/);
  assert.match(app, /Payments by Month/);
  assert.match(app, /Revenue by Parking Type/);
  assert.match(css, /\.summary-kpi-grid/);
  assert.match(css, /@media\(max-width:800px\)/);
});
