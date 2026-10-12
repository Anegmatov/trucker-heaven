const config = require('../config');
const { apiError } = require('../utils');
const crypto = require('crypto');

const allowed = Object.freeze({
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png'
});

let testAdapter = null;
let s3 = null;
let aws = null;

function extension(filename) {
  const match = String(filename || '').trim().toLowerCase().match(/(\.[a-z0-9]+)$/);
  return match ? match[1] : '';
}

function validateUpload(filename, mimeType, sizeBytes, documentLabel = 'Document') {
  const ext = extension(filename);
  const expected = allowed[ext];
  const mime = String(mimeType || '').toLowerCase();
  const size = Number(sizeBytes);
  if (!expected || expected !== mime) {
    throw apiError('DOCUMENT_TYPE_NOT_ALLOWED', `Upload a PDF, JPG/JPEG, or PNG ${String(documentLabel).toLowerCase()} file.`, 415);
  }
  if (!Number.isSafeInteger(size) || size < 1 || size > config.documents.maxBytes) {
    throw apiError('DOCUMENT_SIZE_INVALID', `${documentLabel} files must be no larger than ${Math.floor(config.documents.maxBytes / 1048576)} MB.`);
  }
  return { extension: ext, mimeType: expected, sizeBytes: size };
}

function configured() {
  return Boolean(testAdapter || config.documents.provider === 'LOCAL' || (config.documents.provider === 'S3' && config.documents.bucket));
}

function uploadHeaders(mimeType) {
  return {
    'Content-Type': mimeType,
    'x-amz-server-side-encryption': 'AES256'
  };
}

function requireStorage() {
  if (testAdapter) return testAdapter;
  if (config.documents.provider === 'LOCAL') return require('./localDocumentStorage').adapter;
  if (!configured()) {
    throw apiError('DOCUMENT_STORAGE_NOT_CONFIGURED', 'Private insurance-document storage is not configured. Please contact ParkingOps.', 503);
  }
  if (!s3) {
    const { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    aws = { PutObjectCommand, HeadObjectCommand, GetObjectCommand, getSignedUrl };
    s3 = new S3Client({
      region: config.documents.region,
      ...(config.documents.endpoint ? { endpoint: config.documents.endpoint } : {}),
      forcePathStyle: config.documents.forcePathStyle
    });
  }
  return {
    async signedUpload({ key, mimeType, sizeBytes }) {
      const command = new aws.PutObjectCommand({
        Bucket: config.documents.bucket,
        Key: key,
        ContentType: mimeType,
        ContentLength: sizeBytes,
        ServerSideEncryption: 'AES256'
      });
      const url = await aws.getSignedUrl(s3, command, { expiresIn: config.documents.uploadTtlSeconds });
      return { url, method: 'PUT', headers: uploadHeaders(mimeType), expiresInSeconds: config.documents.uploadTtlSeconds };
    },
    async inspect({ key }) {
      const head = await s3.send(new aws.HeadObjectCommand({ Bucket: config.documents.bucket, Key: key }));
      const object = await s3.send(new aws.GetObjectCommand({ Bucket: config.documents.bucket, Key: key }));
      const bytes = Buffer.from(await object.Body.transformToByteArray());
      return { sizeBytes: Number(head.ContentLength), mimeType: String(head.ContentType || '').toLowerCase(), bytes };
    },
    async signedRead({ key }) {
      const command = new aws.GetObjectCommand({ Bucket: config.documents.bucket, Key: key });
      const url = await aws.getSignedUrl(s3, command, { expiresIn: config.documents.readTtlSeconds });
      return { url, expiresInSeconds: config.documents.readTtlSeconds };
    },
    async readObject({ key }) {
      const object = await s3.send(new aws.GetObjectCommand({ Bucket: config.documents.bucket, Key: key }));
      return {
        body: object.Body,
        sizeBytes: object.ContentLength == null ? null : Number(object.ContentLength),
        mimeType: String(object.ContentType || '').toLowerCase()
      };
    }
  };
}

function detectedMime(input) {
  const bytes = Buffer.from(input || []);
  if (bytes.length >= 9 && bytes.subarray(0, 5).toString('ascii') === '%PDF-'
      && /%%EOF\s*$/.test(bytes.subarray(Math.max(0, bytes.length - 2048)).toString('latin1'))) return 'application/pdf';
  if (bytes.length >= 5 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return 'image/jpeg';
  if (bytes.length >= 20
      && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      && bytes.subarray(bytes.length - 8, bytes.length - 4).toString('ascii') === 'IEND') return 'image/png';
  return null;
}

async function signedUpload(input) {
  try {
    return await requireStorage().signedUpload(input);
  } catch (error) {
    if (error?.status) throw error;
    throw apiError('DOCUMENT_STORAGE_UNAVAILABLE', 'Secure document storage is temporarily unavailable. Please retry.', 503);
  }
}

async function inspectCompletedUpload(input) {
  let result;
  try {
    result = await requireStorage().inspect(input);
  } catch (error) {
    if (error?.status) throw error;
    throw apiError('DOCUMENT_STORAGE_UNAVAILABLE', 'Secure document storage could not verify this upload. Please retry.', 503);
  }
  if (!result || !Number.isSafeInteger(Number(result.sizeBytes)) || !result.mimeType) {
    throw apiError('DOCUMENT_STORAGE_UNAVAILABLE', 'Secure document storage could not verify this upload. Please retry.', 503);
  }
  const bytes = Buffer.from(result.bytes || result.prefix || []);
  if (bytes.length !== Number(result.sizeBytes)) {
    return { ...result, detectedMimeType: null, sha256Hex: null };
  }
  return {
    ...result,
    detectedMimeType: detectedMime(bytes),
    sha256Hex: crypto.createHash('sha256').update(bytes).digest('hex')
  };
}

async function signedRead(input) {
  return requireStorage().signedRead(input);
}

async function readObject(input) {
  const adapter = requireStorage();
  if (typeof adapter.readObject !== 'function') {
    throw apiError('DOCUMENT_STORAGE_READ_UNAVAILABLE', 'Secure document access is temporarily unavailable.', 503);
  }
  try {
    const object = await adapter.readObject(input);
    if (!object) throw apiError('DOCUMENT_STORAGE_READ_UNAVAILABLE', 'Secure document access is temporarily unavailable.', 503);
    return object;
  } catch (error) {
    if (error?.status) throw error;
    throw apiError('DOCUMENT_STORAGE_READ_UNAVAILABLE', 'Secure document access is temporarily unavailable.', 503);
  }
}

function providerName() {
  if (testAdapter) return 'TEST';
  return config.documents.provider === 'LOCAL' ? 'LOCAL' : 'S3';
}

function bucketName() {
  if (testAdapter) return testAdapter.bucket || 'parkingops-test-private';
  return config.documents.provider === 'LOCAL' ? 'local-disk' : config.documents.bucket;
}

function setTestAdapter(adapter) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Document-storage test adapters are available only when NODE_ENV=test');
  testAdapter = adapter;
  s3 = null;
  aws = null;
}

function clearTestAdapter() {
  testAdapter = null;
  s3 = null;
  aws = null;
}

module.exports = {
  allowed,
  validateUpload,
  uploadHeaders,
  configured,
  signedUpload,
  inspectCompletedUpload,
  signedRead,
  readObject,
  providerName,
  bucketName,
  setTestAdapter,
  clearTestAdapter
};
