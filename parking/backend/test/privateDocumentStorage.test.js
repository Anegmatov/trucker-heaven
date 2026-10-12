'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const storage = require('../services/privateDocumentStorage');

test('presigned S3 upload returns every browser header required by the signed request', () => {
  assert.deepEqual(storage.uploadHeaders('application/pdf'), {
    'Content-Type': 'application/pdf',
    'x-amz-server-side-encryption': 'AES256'
  });
});
