'use strict';

const assert = require('node:assert/strict');

const API_ORIGIN = 'https://trucker-heaven-parking-api-vkf9.onrender.com';
const DOCUMENTS_ORIGIN = 'https://trucker-heaven-parking-documents-prod.s3.us-east-2.amazonaws.com';
const EXPECTED_CSP = `default-src 'self'; connect-src 'self' ${API_ORIGIN} ${DOCUMENTS_ORIGIN}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`;

function verifyCustomerCsp(value) {
  const csp = String(value || '').trim();
  assert.equal(csp, EXPECTED_CSP, 'Customer CSP must preserve the exact security policy and allow only the production API and document bucket connections.');
  const connect = csp.match(/(?:^|;\s*)connect-src\s+([^;]+)/)?.[1].trim().split(/\s+/) || [];
  assert.deepEqual(connect, ["'self'", API_ORIGIN, DOCUMENTS_ORIGIN]);
  assert.ok(!connect.includes('*'), 'Customer CSP must not use a connect-src wildcard.');
  assert.ok(!connect.some(origin => origin.includes('*.amazonaws.com') || origin.includes('*.s3.amazonaws.com')),
    'Customer CSP must not allow a wildcard AWS or S3 origin.');
}

verifyCustomerCsp(EXPECTED_CSP);
for (const unsafe of [
  EXPECTED_CSP.replace(DOCUMENTS_ORIGIN, '*'),
  EXPECTED_CSP.replace(DOCUMENTS_ORIGIN, 'https://*.amazonaws.com'),
  EXPECTED_CSP.replace(DOCUMENTS_ORIGIN, `${DOCUMENTS_ORIGIN} https://example.com`)
]) assert.throws(() => verifyCustomerCsp(unsafe));

async function main() {
  const url = String(process.env.PARKING_CUSTOMER_DEPLOYED_URL || '').trim();
  if (!url) {
    console.log('Customer CSP exact-origin contract passed.');
    return;
  }
  const response = await fetch(url, { redirect: 'follow', cache: 'no-store' });
  assert.equal(response.status, 200, `Deployed customer returned ${response.status}`);
  verifyCustomerCsp(response.headers.get('content-security-policy'));
  console.log('Customer CSP exact-origin contract passed against production.');
}

main().catch(error => { console.error(error.message); process.exit(1); });

module.exports = { API_ORIGIN, DOCUMENTS_ORIGIN, EXPECTED_CSP, verifyCustomerCsp };
