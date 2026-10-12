const express = require('express');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const config = require('../config');
const { apiError } = require('../utils');
const { authorizedBooking } = require('../services/customerBookingAccess');
const documents = require('../services/customerDocuments');

const router = express.Router();
const limit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: config.rateLimits.booking,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, _res, next) => next(apiError('PUBLIC_RATE_LIMITED', 'Too many document requests. Please try again later.', 429))
});

function uploadView(started) {
  return {
    document: { type: documents.canonicalType(started.document.document_type), uploadStatus: started.document.upload_status },
    upload: { ...started.signed, token: started.uploadToken, expiresAt: started.uploadExpiresAt }
  };
}

const UPLOAD_TYPES = Object.freeze({ insurance: 'INSURANCE', 'driver-license': 'DRIVER_LICENSE' });

// Drivers add their insurance or driver license from their reservation page (pay at the office),
// or Monthly insurance while an older online checkout is still open.
function uploadAllowed(booking, documentType) {
  if (booking.payment_status === 'NOT_REQUIRED') return ['CONFIRMED', 'CHECKED_IN'].includes(booking.status);
  return documentType === 'INSURANCE' && booking.parking_product === 'MONTHLY'
    && ['DRAFT', 'CHECKOUT_PENDING'].includes(booking.payment_status);
}

async function beginUpload(req, res, next) {
  const client = await pool.connect();
  try {
    const documentType = UPLOAD_TYPES[String(req.params.documentType || '').toLowerCase()];
    if (!documentType) throw apiError('DOCUMENT_TYPE_INVALID', 'Choose insurance or driver license.', 404);
    await client.query('BEGIN');
    const booking = await authorizedBooking(client, req.params.publicToken, req.body.lookupCredential, { lock: true });
    if (!uploadAllowed(booking, documentType)) {
      throw apiError('DOCUMENT_UPLOAD_CLOSED', 'Documents can be added while the reservation is confirmed or checked in.', 409);
    }
    const started = await documents.startUpload(client, {
      bookingId: booking.id,
      documentType,
      filename: req.body.filename,
      mimeType: req.body.mimeType,
      sizeBytes: req.body.sizeBytes
    });
    await client.query('COMMIT');
    res.status(201).json(uploadView(started));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
}

router.post('/bookings/:publicToken/documents/:documentType/upload', limit, beginUpload);

async function complete(req, res, next, documentPublicId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const booking = await authorizedBooking(client, req.params.publicToken, req.body.lookupCredential, { lock: true });
    const completed = await documents.completeUpload(client, {
      bookingId: booking.id,
      uploadToken: req.body.uploadToken,
      documentPublicId
    });
    await client.query('COMMIT');
    res.json({ document: {
      type: documents.canonicalType(completed.document.document_type),
      uploadStatus: completed.document.upload_status,
      status: completed.document.verification_status === 'APPROVED' ? 'APPROVED' : 'RECEIVED'
    } });
  } catch (error) {
    if (error.documentRejectionPersisted) await client.query('COMMIT').catch(() => {});
    else await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
}

router.post('/bookings/:publicToken/documents/complete', limit, (req, res, next) => complete(req, res, next));
// Backward-compatible completion path for an in-flight pre-deploy customer
// page. New customer responses and UI do not expose the document identifier.
router.post('/bookings/:publicToken/documents/:documentId/complete', limit,
  (req, res, next) => complete(req, res, next, req.params.documentId));

router.post('/bookings/:publicToken/documents/status', limit, async (req, res, next) => {
  try {
    const booking = await authorizedBooking(pool, req.params.publicToken, req.body.lookupCredential);
    const result = await pool.query(`SELECT document_type,verification_status,uploaded_at
      FROM parking_customer_documents
      WHERE booking_id=$1 AND upload_status='UPLOADED' AND superseded_at IS NULL
      ORDER BY uploaded_at DESC`, [booking.id]);
    res.json({ documents: result.rows.map(documents.safeStatus) });
  } catch (error) { next(error); }
});

module.exports = router;
