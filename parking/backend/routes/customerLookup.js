const express = require('express');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const config = require('../config');
const { digest } = require('../utils');
const lookup = require('../services/customerLookup');
const documents = require('../services/customerDocuments');

const router = express.Router();
const lookupPath = '/api/customer/parking/v1/lookup';
const lookupLimit = rateLimit({
  windowMs: config.customerLookup.windowSeconds * 1000,
  limit: config.customerLookup.attemptsPerWindow,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (_req, _res, next) => next(lookup.genericLookupError(429))
});

function cookieOptions() {
  return {
    httpOnly: true,
    secure: config.customerLookup.cookieSecure,
    sameSite: config.customerLookup.cookieSameSite,
    path: lookupPath,
    maxAge: config.customerLookup.ttlSeconds * 1000
  };
}

function documentView(row) {
  return {
    type: documents.canonicalType(row.document_type),
    uploadStatus: row.upload_status,
    status: ['REPLACEMENT_REQUESTED', 'REJECTED'].includes(row.verification_status)
      ? 'REPLACEMENT_REQUESTED' : 'RECEIVED'
  };
}

function uploadView(started) {
  return {
    document: documentView(started.document),
    upload: { ...started.signed, token: started.uploadToken, expiresAt: started.uploadExpiresAt }
  };
}

function checkedDocumentType(value) {
  const type = String(value || '').trim().toUpperCase();
  if (!['DRIVER_LICENSE', 'INSURANCE'].includes(type)) throw lookup.genericLookupError();
  return type;
}

function requireCsrf(req, grant) {
  if (!lookup.validCsrf(req, grant)) throw lookup.genericLookupError(403);
}

router.post('/', lookupLimit, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const documentType = req.body?.documentType == null ? null : checkedDocumentType(req.body.documentType);
    await client.query('BEGIN');
    const booking = await lookup.findMatchingBooking(client, req.body);
    const created = await lookup.createGrant(client, req, booking, documentType);
    const summary = await lookup.safeSummary(client, created.grant);
    await client.query('COMMIT');
    res.cookie(config.customerLookup.cookieName, created.rawToken, cookieOptions());
    res.json({
      summary,
      csrfToken: created.csrfToken,
      documentType: created.grant.document_type,
      expiresAt: created.expiresAt
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
});

router.get('/summary', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const grant = await lookup.grantFromRequest(client, req, { lock: true });
    const csrfToken = await lookup.rotateCsrf(client, grant);
    const summary = await lookup.safeSummary(client, grant);
    await client.query('COMMIT');
    res.json({ summary, csrfToken, documentType: grant.document_type, expiresAt: grant.expires_at });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
});

router.post('/logout', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const grant = await lookup.grantFromRequest(client, req, { lock: true });
    requireCsrf(req, grant);
    await client.query('UPDATE parking_customer_lookup_grants SET revoked_at=now() WHERE id=$1', [grant.id]);
    await client.query('COMMIT');
    res.clearCookie(config.customerLookup.cookieName, cookieOptions());
    res.status(204).end();
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
});

router.post('/documents/:documentType/upload', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const grant = await lookup.grantFromRequest(client, req, { lock: true });
    requireCsrf(req, grant);
    const documentType = checkedDocumentType(req.params.documentType);
    if (!grant.document_type || grant.document_type !== documentType) throw lookup.genericLookupError(403);
    const started = await documents.startUpload(client, {
      bookingId: grant.booking_id,
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
});

router.post('/documents/complete', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const grant = await lookup.grantFromRequest(client, req, { lock: true });
    requireCsrf(req, grant);
    if (!grant.document_type) throw lookup.genericLookupError(403);
    const pending = (await client.query(`SELECT document_type FROM parking_customer_documents
      WHERE booking_id=$1 AND document_type=$2 AND upload_token_hash=$3 FOR UPDATE`, [
      grant.booking_id, grant.document_type, digest(String(req.body.uploadToken || ''))
    ])).rows[0];
    if (!pending) throw lookup.genericLookupError();
    const completed = await documents.completeUpload(client, {
      bookingId: grant.booking_id,
      uploadToken: req.body.uploadToken
    });
    await client.query('COMMIT');
    res.json({ document: documentView(completed.document) });
  } catch (error) {
    if (error.documentRejectionPersisted) await client.query('COMMIT').catch(() => {});
    else await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
});

module.exports = router;
