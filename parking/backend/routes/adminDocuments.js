const express = require('express');
const pool = require('../db');
const config = require('../config');
const { requireAdmin, csrf, permit } = require('../auth');
const { apiError, cleanText, token, digest } = require('../utils');
const storage = require('../services/privateDocumentStorage');
const customerDocuments = require('../services/customerDocuments');
const notifications = require('../services/customerNotifications');

const router = express.Router();
const accessCookieName = 'parking_document_access';
router.use(requireAdmin);

function accessCookieSettings() {
  return {
    httpOnly: true,
    secure: config.cookie.secure,
    sameSite: config.cookie.sameSite,
    path: '/api/admin/parking/v1/documents',
    maxAge: config.documents.readTtlSeconds * 1000
  };
}

function typeSql(alias = 'document') {
  return `CASE WHEN ${alias}.document_type='VEHICLE_CARRIER_INSURANCE' THEN 'INSURANCE' ELSE ${alias}.document_type END`;
}

async function scopedDocument(client, { documentId, customerPublicId = null, forUpdate = false }) {
  return (await client.query(`SELECT document.*
    FROM parking_customer_documents document
    JOIN parking_bookings booking ON booking.id=document.booking_id
    LEFT JOIN parking_customers customer ON customer.id=booking.customer_id
    WHERE document.public_id=$1
      AND document.upload_status='UPLOADED' AND document.superseded_at IS NULL
      AND ($2::text IS NULL OR customer.public_id=$2)
    ${forUpdate ? 'FOR UPDATE OF document' : ''}`, [documentId, customerPublicId])).rows[0];
}

router.get('/documents', permit('STAFF'), async (req, res, next) => {
  try {
    const status = String(req.query.status || '').trim().toUpperCase();
    if (status && !['PENDING_REVIEW', 'APPROVED', 'REJECTED', 'REPLACEMENT_REQUESTED'].includes(status)) {
      throw apiError('VALIDATION_ERROR', 'Choose a valid document status.');
    }
    const rows = await pool.query(`SELECT document.public_id,${typeSql()} document_type,document.upload_status,
        document.verification_status,document.policy_expires_at,document.created_at,document.uploaded_at,
        document.original_filename,document.revision,customer.public_id customer_public_id,
        booking.reservation_number,booking.first_name,booking.last_name,booking.company_name,
        booking.tractor_unit_number,booking.license_plate,booking.license_plate_state
      FROM parking_customer_documents document
      JOIN parking_bookings booking ON booking.id=document.booking_id
      LEFT JOIN parking_customers customer ON customer.id=booking.customer_id
      WHERE document.upload_status='UPLOADED' AND document.superseded_at IS NULL
        AND ($1::text='' OR document.verification_status=$1)
      ORDER BY CASE document.verification_status WHEN 'PENDING_REVIEW' THEN 0 WHEN 'REPLACEMENT_REQUESTED' THEN 1 ELSE 2 END,
        document.created_at DESC LIMIT 100`, [status]);
    res.json({ documents: rows.rows.map(row => ({
      id: row.public_id,
      customerPublicId: row.customer_public_id,
      type: row.document_type,
      uploadStatus: row.upload_status,
      verificationStatus: row.verification_status,
      policyExpiresAt: row.policy_expires_at,
      filename: row.original_filename,
      revision: Number(row.revision),
      createdAt: row.created_at,
      uploadedAt: row.uploaded_at,
      reservationNumber: row.reservation_number,
      customer: `${row.first_name} ${row.last_name}`,
      companyName: row.company_name,
      unitNumber: row.tractor_unit_number,
      licensePlate: row.license_plate,
      licensePlateState: row.license_plate_state
    })) });
  } catch (error) { next(error); }
});

async function grantAccess(req, res, next, forcedDisposition = null) {
  const client = await pool.connect();
  try {
    const disposition = forcedDisposition || String(req.body.disposition || '').trim().toUpperCase();
    if (!['INLINE','ATTACHMENT'].includes(disposition)) throw apiError('VALIDATION_ERROR', 'Choose View or Download.');
    await client.query('BEGIN');
    const document = await scopedDocument(client, {
      documentId: req.params.documentId,
      customerPublicId: req.params.customerPublicId || null,
      forUpdate: true
    });
    if (!document) throw apiError('DOCUMENT_NOT_FOUND', 'Document not found.', 404);
    const rawToken = token(32);
    const expiresAt = new Date(Date.now() + config.documents.readTtlSeconds * 1000).toISOString();
    await client.query(`INSERT INTO parking_document_access_grants(
        document_id,admin_user_id,token_hash,disposition,expires_at)
      VALUES($1,$2,$3,$4,$5)`, [document.id, req.admin.id, digest(rawToken), disposition, expiresAt]);
    await client.query('COMMIT');
    res.cookie(accessCookieName, rawToken, accessCookieSettings());
    res.json({ access: {
      path: `/api/admin/parking/v1/documents/${encodeURIComponent(document.public_id)}/content`,
      expiresAt,
      oneTime: true
    } });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
}

router.post('/documents/:documentId/access', permit('STAFF'), csrf, grantAccess);
router.post('/customers/:customerPublicId/documents/:documentId/access', permit('STAFF'), csrf, grantAccess);
// Compatibility for an admin page already open during deploy. The response
// now points to the protected API proxy and never contains an object URL.
router.post('/documents/:documentId/read', permit('STAFF'), csrf,
  (req, res, next) => grantAccess(req, res, next, 'INLINE'));

router.get('/documents/:documentId/content', permit('STAFF'), async (req, res, next) => {
  const client = await pool.connect();
  let document;
  try {
    await client.query('BEGIN');
    const grant = (await client.query(`SELECT grant_row.id grant_id,grant_row.disposition,document.*
      FROM parking_document_access_grants grant_row
      JOIN parking_customer_documents document ON document.id=grant_row.document_id
      WHERE grant_row.token_hash=$1 AND grant_row.admin_user_id=$2 AND document.public_id=$3
        AND grant_row.used_at IS NULL AND grant_row.expires_at>now()
        AND document.upload_status='UPLOADED' AND document.superseded_at IS NULL
      FOR UPDATE OF grant_row`, [digest(String(req.cookies?.[accessCookieName] || '')), req.admin.id, req.params.documentId])).rows[0];
    if (!grant) throw apiError('DOCUMENT_ACCESS_INVALID', 'Secure document access is invalid or expired.', 404);
    document = grant;
    await client.query('UPDATE parking_document_access_grants SET used_at=now() WHERE id=$1', [grant.grant_id]);
    await client.query(`INSERT INTO parking_document_access_audit(document_id,admin_user_id,action)
      VALUES($1,$2,$3)`, [grant.id, req.admin.id, grant.disposition === 'ATTACHMENT' ? 'DOWNLOADED' : 'VIEWED']);
    await client.query('COMMIT');
    res.clearCookie(accessCookieName, accessCookieSettings());
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    return next(error);
  }
  client.release();
  try {
    const object = await storage.readObject({ key: document.storage_key });
    const mimeType = document.detected_mime_type || document.declared_mime_type;
    const extension = mimeType === 'application/pdf' ? 'pdf' : mimeType === 'image/png' ? 'png' : 'jpg';
    const baseName = customerDocuments.canonicalType(document.document_type) === 'DRIVER_LICENSE'
      ? 'driver-license' : 'insurance';
    res.set({
      'Content-Type': mimeType,
      'Content-Disposition': `${document.disposition === 'ATTACHMENT' ? 'attachment' : 'inline'}; filename="${baseName}.${extension}"`,
      'Cache-Control': 'private, no-store, max-age=0',
      'Pragma': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    if (Number.isSafeInteger(object.sizeBytes)) res.set('Content-Length', String(object.sizeBytes));
    if (Buffer.isBuffer(object.body) || object.body instanceof Uint8Array) return res.end(Buffer.from(object.body));
    if (typeof object.body?.pipe === 'function') {
      object.body.once('error', next);
      return object.body.pipe(res);
    }
    if (typeof object.body?.transformToByteArray === 'function') {
      return res.end(Buffer.from(await object.body.transformToByteArray()));
    }
    throw apiError('DOCUMENT_STORAGE_READ_UNAVAILABLE', 'Secure document access is temporarily unavailable.', 503);
  } catch (error) { next(error); }
});

async function reviewDocument(req, res, next) {
  const client = await pool.connect();
  try {
    const status = String(req.body.status || '').trim().toUpperCase();
    if (!['APPROVED', 'REJECTED', 'REPLACEMENT_REQUESTED'].includes(status)) {
      throw apiError('VALIDATION_ERROR', 'Choose Approve, Reject, or Request Replacement.');
    }
    const note = cleanText(req.body.note, 500, 'Review note') || '';
    if (['REJECTED', 'REPLACEMENT_REQUESTED'].includes(status) && !note) {
      throw apiError('VALIDATION_ERROR', status === 'REJECTED'
        ? 'Explain why the document is rejected.' : 'Explain why a replacement is needed.');
    }
    const policyExpiresAt = req.body.policyExpiresAt ? String(req.body.policyExpiresAt) : null;
    if (policyExpiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(policyExpiresAt)) {
      throw apiError('VALIDATION_ERROR', 'Policy expiration must be YYYY-MM-DD.');
    }
    await client.query('BEGIN');
    const existing = await scopedDocument(client, {
      documentId: req.params.documentId,
      customerPublicId: req.params.customerPublicId || null,
      forUpdate: true
    });
    if (!existing) throw apiError('DOCUMENT_NOT_FOUND', 'Document not found.', 404);
    const document = (await client.query(`UPDATE parking_customer_documents SET
        verification_status=$2,policy_expires_at=$3,review_note=$4,reviewed_by_admin_user_id=$5,reviewed_at=now()
      WHERE id=$1 RETURNING *`, [existing.id, status, policyExpiresAt, note, req.admin.id])).rows[0];
    await client.query(`INSERT INTO parking_document_access_audit(document_id,admin_user_id,action)
      VALUES($1,$2,$3)`, [document.id, req.admin.id, status]);
    if (status === 'REPLACEMENT_REQUESTED') {
      const booking = (await client.query('SELECT * FROM parking_bookings WHERE id=$1', [document.booking_id])).rows[0];
      if (booking) await notifications.enqueueForBooking(client, booking, 'DOCUMENT_REPLACEMENT_REQUESTED', {
        documentType: customerDocuments.canonicalType(document.document_type)
      });
    }
    await client.query('COMMIT');
    res.json({ document: {
      type: customerDocuments.canonicalType(document.document_type),
      verificationStatus: document.verification_status,
      policyExpiresAt: document.policy_expires_at,
      reviewedAt: document.reviewed_at
    } });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
}

router.patch('/documents/:documentId/review', permit('STAFF'), csrf, reviewDocument);
router.patch('/customers/:customerPublicId/documents/:documentId/review', permit('STAFF'), csrf, reviewDocument);

module.exports = router;
