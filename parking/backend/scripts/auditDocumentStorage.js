const crypto = require('crypto');
const pool = require('../db');
const config = require('../config');

if (!process.argv.includes('--audit')) {
  throw new Error('This read-only command requires --audit. It never deletes database rows or storage objects.');
}
if (config.documents.provider !== 'S3' || !config.documents.bucket) {
  throw new Error('Private S3 document storage is not configured.');
}

const verifyChecksums = process.argv.includes('--verify-checksums');
const prefixes = ['driver-license/', 'insurance/'];

async function listKeys(s3, ListObjectsV2Command) {
  const keys = new Set();
  for (const Prefix of prefixes) {
    let ContinuationToken;
    do {
      const page = await s3.send(new ListObjectsV2Command({
        Bucket: config.documents.bucket,
        Prefix,
        ...(ContinuationToken ? { ContinuationToken } : {})
      }));
      for (const object of page.Contents || []) if (object.Key) keys.add(object.Key);
      ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (ContinuationToken);
  }
  return keys;
}

async function bucketControls(s3, commands) {
  const controls = { publicAccessBlock: 'UNVERIFIED', policyStatus: 'UNVERIFIED' };
  try {
    const value = await s3.send(new commands.GetPublicAccessBlockCommand({ Bucket: config.documents.bucket }));
    const block = value.PublicAccessBlockConfiguration || {};
    controls.publicAccessBlock = ['BlockPublicAcls','IgnorePublicAcls','BlockPublicPolicy','RestrictPublicBuckets']
      .every(name => block[name] === true) ? 'PASS' : 'FAIL';
  } catch (_) { /* Some S3-compatible providers do not implement this API. */ }
  try {
    const value = await s3.send(new commands.GetBucketPolicyStatusCommand({ Bucket: config.documents.bucket }));
    controls.policyStatus = value.PolicyStatus?.IsPublic === false ? 'PASS'
      : value.PolicyStatus?.IsPublic === true ? 'FAIL' : 'UNVERIFIED';
  } catch (_) { /* Absence/unsupported is not proof that anonymous access is denied. */ }
  return controls;
}

async function main() {
  const {
    S3Client, ListObjectsV2Command, GetObjectCommand,
    GetPublicAccessBlockCommand, GetBucketPolicyStatusCommand
  } = require('@aws-sdk/client-s3');
  const s3 = new S3Client({
    region: config.documents.region,
    ...(config.documents.endpoint ? { endpoint: config.documents.endpoint } : {}),
    forcePathStyle: config.documents.forcePathStyle
  });
  const documents = (await pool.query(`SELECT storage_key,upload_status,size_bytes,sha256_hex
    FROM parking_customer_documents
    WHERE storage_provider='S3' AND storage_bucket=$1`, [config.documents.bucket])).rows;
  const objectKeys = await listKeys(s3, ListObjectsV2Command);
  const databaseKeys = new Set(documents.map(row => row.storage_key));
  const uploaded = documents.filter(row => row.upload_status === 'UPLOADED');
  const pending = documents.filter(row => row.upload_status === 'PENDING_UPLOAD');
  const failed = documents.filter(row => row.upload_status === 'FAILED');
  const report = {
    mode: 'READ_ONLY',
    databaseDocuments: documents.length,
    storageObjects: objectKeys.size,
    uploadedMissingObject: uploaded.filter(row => !objectKeys.has(row.storage_key)).length,
    pendingWithObject: pending.filter(row => objectKeys.has(row.storage_key)).length,
    pendingMissingObject: pending.filter(row => !objectKeys.has(row.storage_key)).length,
    failedWithObject: failed.filter(row => objectKeys.has(row.storage_key)).length,
    storageObjectWithoutDatabaseRow: [...objectKeys].filter(key => !databaseKeys.has(key)).length,
    uploadedWithoutChecksum: uploaded.filter(row => !row.sha256_hex).length,
    checksumVerification: verifyChecksums ? { checked: 0, mismatched: 0 } : 'NOT_REQUESTED',
    bucketControls: await bucketControls(s3, { GetPublicAccessBlockCommand, GetBucketPolicyStatusCommand })
  };
  if (verifyChecksums) {
    for (const document of uploaded.filter(row => row.sha256_hex && objectKeys.has(row.storage_key))) {
      const object = await s3.send(new GetObjectCommand({ Bucket: config.documents.bucket, Key: document.storage_key }));
      const bytes = Buffer.from(await object.Body.transformToByteArray());
      const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
      report.checksumVerification.checked += 1;
      if (bytes.length !== Number(document.size_bytes) || checksum !== document.sha256_hex) {
        report.checksumVerification.mismatched += 1;
      }
    }
  }
  console.log(JSON.stringify(report));
}

main().catch(error => {
  console.error(JSON.stringify({ error: error.code || error.name || 'DOCUMENT_STORAGE_AUDIT_FAILED' }));
  process.exitCode = 1;
}).finally(() => pool.end());
