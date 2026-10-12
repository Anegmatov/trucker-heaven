const config = require('../config');
const { apiError, token, digest, cleanText } = require('../utils');
const storage = require('./privateDocumentStorage');

const TYPES = Object.freeze({
  DRIVER_LICENSE: Object.freeze({ label: 'Driver License', prefix: 'driver-license' }),
  INSURANCE: Object.freeze({ label: 'Insurance', prefix: 'insurance' })
});

function canonicalType(value) {
  const type = String(value || '').trim().toUpperCase();
  if (type === 'VEHICLE_CARRIER_INSURANCE') return 'INSURANCE';
  if (!TYPES[type]) throw apiError('DOCUMENT_TYPE_NOT_ALLOWED', 'Choose Driver License or Insurance.', 415);
  return type;
}

function storedTypes(value) {
  const type = canonicalType(value);
  return type === 'INSURANCE' ? ['INSURANCE', 'VEHICLE_CARRIER_INSURANCE'] : [type];
}

function safeStatus(row) {
  if (!row) return null;
  return {
    type: canonicalType(row.document_type),
    status: row.verification_status === 'REPLACEMENT_REQUESTED' || row.verification_status === 'REJECTED'
      ? 'REPLACEMENT_REQUESTED'
      : row.verification_status === 'APPROVED' ? 'APPROVED' : 'RECEIVED',
    receivedAt: row.uploaded_at || null
  };
}

async function startUpload(client, { bookingId, documentType, filename, mimeType, sizeBytes }) {
  const type = canonicalType(documentType);
  const originalFilename = cleanText(filename, 180, 'File name', true);
  const validated = storage.validateUpload(originalFilename, mimeType, sizeBytes, TYPES[type].label);
  if (!storage.configured()) {
    throw apiError('DOCUMENT_STORAGE_NOT_CONFIGURED', 'Secure document upload is temporarily unavailable. Please contact ParkingOps.', 503);
  }
  const variants = storedTypes(type);
  const bookingLock = await client.query('SELECT id FROM parking_bookings WHERE id=$1 FOR UPDATE', [bookingId]);
  if (!bookingLock.rowCount) throw apiError('RESERVATION_NOT_FOUND', 'An eligible reservation was not found.', 404);
  const pending = (await client.query(`SELECT id,upload_expires_at FROM parking_customer_documents
    WHERE booking_id=$1 AND document_type=ANY($2::text[]) AND upload_status='PENDING_UPLOAD'
    ORDER BY id DESC LIMIT 1 FOR UPDATE`, [bookingId, variants])).rows[0] || null;
  if (pending && new Date(pending.upload_expires_at).getTime() > Date.now()) {
    throw apiError('DOCUMENT_UPLOAD_IN_PROGRESS', 'A secure upload for this document is already in progress. Finish it or try again after it expires.', 409);
  }
  await client.query(`UPDATE parking_customer_documents SET upload_status='FAILED'
    WHERE booking_id=$1 AND document_type=ANY($2::text[]) AND upload_status='PENDING_UPLOAD'`, [bookingId, variants]);
  const current = (await client.query(`SELECT * FROM parking_customer_documents
    WHERE booking_id=$1 AND document_type=ANY($2::text[]) AND upload_status='UPLOADED' AND superseded_at IS NULL
    ORDER BY revision DESC,id DESC LIMIT 1 FOR UPDATE`, [bookingId, variants])).rows[0] || null;
  const revision = Number((await client.query(`SELECT COALESCE(max(revision),0)+1 next_revision
    FROM parking_customer_documents WHERE booking_id=$1 AND document_type=ANY($2::text[])`,
  [bookingId, variants])).rows[0].next_revision);
  const publicId = `doc_${token(24)}`;
  const uploadToken = token(32);
  const storageKey = `${TYPES[type].prefix}/${token(32)}${validated.extension}`;
  const uploadExpiresAt = new Date(Date.now() + config.documents.uploadTtlSeconds * 1000).toISOString();
  const document = (await client.query(`INSERT INTO parking_customer_documents(
      public_id,booking_id,document_type,original_filename,declared_mime_type,size_bytes,
      storage_provider,storage_bucket,storage_key,upload_token_hash,upload_expires_at,revision,replaces_document_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [
    publicId, bookingId, type, originalFilename, validated.mimeType, validated.sizeBytes,
    storage.providerName(), storage.bucketName(), storageKey, digest(uploadToken), uploadExpiresAt,
    revision, current?.id || null
  ])).rows[0];
  const signed = await storage.signedUpload({ key: storageKey, mimeType: validated.mimeType, sizeBytes: validated.sizeBytes });
  return { document, uploadToken, uploadExpiresAt, signed };
}

async function completeUpload(client, { bookingId, uploadToken, documentPublicId = null }) {
  const rawToken = String(uploadToken || '');
  if (!rawToken) throw apiError('DOCUMENT_UPLOAD_INVALID', 'The secure upload authorization is invalid or expired.', 409);
  const values = [bookingId, digest(rawToken)];
  let publicIdSql = '';
  if (documentPublicId) { values.push(String(documentPublicId)); publicIdSql = ` AND public_id=$${values.length}`; }
  const document = (await client.query(`SELECT * FROM parking_customer_documents
    WHERE booking_id=$1 AND upload_token_hash=$2${publicIdSql} FOR UPDATE`, values)).rows[0];
  if (!document) throw apiError('DOCUMENT_NOT_FOUND', 'Document upload not found.', 404);
  if (document.upload_status === 'UPLOADED') return { document, alreadyCompleted: true };
  if (document.upload_status !== 'PENDING_UPLOAD' || new Date(document.upload_expires_at).getTime() <= Date.now()) {
    throw apiError('DOCUMENT_UPLOAD_INVALID', 'The secure upload authorization is invalid or expired.', 409);
  }
  const inspected = await storage.inspectCompletedUpload({ key: document.storage_key });
  const valid = inspected.sizeBytes === Number(document.size_bytes)
    && inspected.mimeType === document.declared_mime_type
    && inspected.detectedMimeType === document.declared_mime_type
    && /^[a-f0-9]{64}$/.test(String(inspected.sha256Hex || ''));
  if (!valid) {
    await client.query(`UPDATE parking_customer_documents SET upload_status='FAILED',detected_mime_type=$2 WHERE id=$1`,
      [document.id, inspected.detectedMimeType]);
    const error = apiError('DOCUMENT_CONTENT_INVALID', 'The uploaded file content does not match its allowed file type or size.', 415);
    error.documentRejectionPersisted = true;
    throw error;
  }
  if (document.replaces_document_id) {
    await client.query(`UPDATE parking_customer_documents SET superseded_at=now()
      WHERE id=$1 AND superseded_at IS NULL`, [document.replaces_document_id]);
  }
  const updated = (await client.query(`UPDATE parking_customer_documents SET upload_status='UPLOADED',
      verification_status='PENDING_REVIEW',detected_mime_type=$2,sha256_hex=$3,uploaded_at=now()
    WHERE id=$1 RETURNING *`, [document.id, inspected.detectedMimeType, inspected.sha256Hex])).rows[0];
  return { document: updated, alreadyCompleted: false };
}

async function expirePendingUploads(client) {
  const result = await client.query(`UPDATE parking_customer_documents SET upload_status='FAILED'
    WHERE upload_status='PENDING_UPLOAD' AND upload_expires_at<=now()`);
  return result.rowCount;
}

module.exports = { TYPES, canonicalType, storedTypes, safeStatus, startUpload, completeUpload, expirePendingUploads };
