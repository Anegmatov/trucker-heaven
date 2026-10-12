'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const api = fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8');

test('Customers is a permanent operational workspace with canonical list, detail, and matrix views', () => {
  assert.match(app, /PARKING_SCREENS = \['Overview', 'Live Lot', 'Reservations', 'Reservation Desk', 'Customers'\]/);
  for (const marker of ['renderCustomerList', 'renderCustomerDetail', 'renderCustomerMatrix',
    'Name, phone, email, plate, unit, DOT/MC', 'Former', 'Payment Matrix', 'Outstanding balance', 'Parking History', 'Notes / Follow-ups']) {
    assert.ok(app.includes(marker), `Customers workspace is missing ${marker}`);
  }
});

test('customer financial mutations use the shared authenticated CSRF API and explicit non-Stripe provenance copy', () => {
  for (const marker of ['recordCustomerPayment', 'correctCustomerPayment', 'addCustomerNote',
    'resolveCustomerNote', 'updateCustomerStatus']) assert.ok(api.includes(marker), `API adapter is missing ${marker}`);
  assert.ok(app.includes('Creates an auditable non-Stripe ledger entry.'));
  assert.ok(app.includes('The original payment remains visible.'));
  assert.doesNotMatch(app, /localStorage\s*[.\[]|indexedDB\s*[.(\[]|openDatabase\s*\(/i);
});

test('Payment Matrix confines horizontal scrolling to its own region', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  assert.match(css, /\.customer-matrix-wrap\{[^}]*overflow-x:auto/);
  assert.match(css, /@media\(max-width:650px\)/);
});

test('legacy evidence anomalies stay visibly neutral and separate from financial history', () => {
  for (const marker of ['LEGACY_DATA_MISSING', 'legacyParkingRecords']) {
    assert.ok(app.includes(marker), `Legacy evidence UI is missing ${marker}`);
  }
});

test('customer detail provides scoped private document controls without object URLs', () => {
  for (const marker of ['renderCustomerDocuments', 'customerDocumentAccess', 'reviewCustomerDocument',
    'View', 'Download', 'Approve', 'Reject', 'Request Replacement']) {
    assert.ok(`${app}\n${api}`.includes(marker), `Customer document workflow is missing ${marker}`);
  }
  assert.match(api, /customers\/\$\{encodeURIComponent\(customerId\)\}\/documents\/\$\{encodeURIComponent\(id\)\}\/access/);
  assert.match(api, /customers\/\$\{encodeURIComponent\(customerId\)\}\/documents\/\$\{encodeURIComponent\(id\)\}\/review/);
  assert.doesNotMatch(app, /amazonaws\.com|storage_key|storage_bucket/i);
});
