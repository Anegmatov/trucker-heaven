const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const pool = require('./db');
const config = require('./config');
const { runMigrations } = require('./migrations');
const publicParking = require('./routes/publicParking');
const adminAuth = require('./routes/adminAuth');
const adminParking = require('./routes/adminParking');
const adminCustomers = require('./routes/adminCustomers');
const adminDocuments = require('./routes/adminDocuments');
const adminReservationDesk = require('./routes/adminReservationDesk');
const publicDocuments = require('./routes/publicDocuments');
const customerLookup = require('./routes/customerLookup');
const privateDocuments = require('./routes/privateDocuments');
const customerAccounts = require('./routes/customerAccounts');
const stripeWebhook = require('./routes/stripeWebhook');
const stripeGateway = require('./services/stripeGateway');
const privateDocumentStorage = require('./services/privateDocumentStorage');
const customerAuth = require('./services/customerAuth');
const customerNotifications = require('./services/customerNotifications');
const { expirePendingBookings } = require('./services/bookingWorkflow');
const { expireQuoteHolds } = require('./services/exactSpaceService');
const { releaseEndedSubscriptions } = require('./services/paymentLifecycle');
const demoPaymentBypass = require('./services/demoPaymentBypass');
const { apiError, safeLog } = require('./utils');

/*
 * Builds the Parking API as a plain Express app and exports it. Requiring this
 * file has no side effects: no database connection, no migrations, no timers.
 * `init()` connects and migrates, `startBackgroundJobs()` runs the periodic
 * sweep, and server.js (or a parent app that mounts this module) calls them.
 */
const app = express();
app.disable('x-powered-by');
if (config.trustProxyHops > 0) app.set('trust proxy', config.trustProxyHops);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || config.corsAllowedOrigins.includes(origin)) return callback(null, true);
    return callback(apiError('CORS_ORIGIN_DENIED', 'Origin is not allowed', 403));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Idempotency-Key', 'X-CSRF-Token']
}));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: config.rateLimits.general, standardHeaders: true, legacyHeaders: false }));
// Set private response policy before any body parser can reject a request so
// validation errors on customer and admin routes cannot be cached either.
app.use('/api/customer/parking/v1', privateResponse);
app.use('/api/admin', privateResponse);
// Stripe requires the exact raw bytes for signature verification. This route
// must stay ahead of the ordinary JSON parser.
app.post('/api/payments/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), stripeWebhook);
app.use(express.json({ limit: config.jsonBodyLimit }));
app.use((req, _res, next) => {
  req.cookies = Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(value => {
    const separator = value.indexOf('=');
    return [value.slice(0, separator).trim(), decodeURIComponent(value.slice(separator + 1))];
  }));
  next();
});
function privateResponse(_req, res, next) {
  res.set({
    'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
    Pragma: 'no-cache'
  });
  next();
}
app.get('/health', (_req, res) => res.json({ ok: true, module: 'parking' }));
app.get('/ready', async (_req, res) => {
  try {
    const schema = (await pool.query(`SELECT
      to_regclass('public.parking_customer_billing_periods') IS NOT NULL
      AND to_regclass('public.parking_customer_payment_adjustments') IS NOT NULL
      AND to_regclass('public.parking_customer_import_batches') IS NOT NULL customer_ledger,
      to_regclass('public.parking_booking_price_overrides') IS NOT NULL
      AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
        AND table_name='parking_bookings' AND column_name='booking_source')
      AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
        AND table_name='parking_bookings' AND column_name='created_by_admin_user_id')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='parking_customer_notification_outbox_event_type_check'
        AND pg_get_constraintdef(oid) LIKE '%ADMIN_PAYMENT_LINK_CREATED%') reservation_desk`)).rows[0];
    if (!schema?.customer_ledger) throw new Error('Customer ledger migration is not ready');
    if (!schema?.reservation_desk) throw new Error('Reservation Desk migration is not ready');
    const legacyImport = (await pool.query(`SELECT
      to_regclass('public.parking_customer_legacy_parking_records') IS NOT NULL
      AND to_regclass('public.parking_customer_legacy_anomalies') IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name='parking_customer_billing_periods'
          AND column_name='legacy_source_row'
      ) legacy_import`)).rows[0];
    if (!legacyImport?.legacy_import) throw new Error('Customer legacy import safety migration is not ready');
    if (config.demoPaymentBypass.enabled) {
      const demoSchema = (await pool.query(`SELECT
        to_regclass('public.parking_demo_payment_grants') IS NOT NULL demo_payment_bypass`)).rows[0];
      if (!demoSchema?.demo_payment_bypass) throw new Error('Demo payment bypass migration is not ready');
    }
    res.json({
      ready: true,
      release: {
        commit: process.env.RENDER_GIT_COMMIT || null,
        serviceId: process.env.RENDER_SERVICE_ID || null,
        deploymentId: process.env.RENDER_DEPLOY_ID || null
      },
      dependencies: {
        database: true,
        customerLedger: true,
        customerLegacyImport: true,
        reservationDesk: true,
        stripeCheckout: stripeGateway.configured(),
        stripeWebhook: stripeGateway.webhookConfigured(),
        stripeMode: stripeGateway.mode(),
        customerReturnUrl: config.customerAppUrlConfigured,
        documentStorage: privateDocumentStorage.configured(),
        customerEmailNotifications: customerNotifications.emailConfigured(),
        customerSmsNotifications: customerNotifications.smsConfigured()
      }
    });
  } catch (_) {
    res.status(503).json({ ready: false, dependencies: { database: false } });
  }
});
app.use('/api/public/parking/v1', publicParking);
app.use('/api/public/parking/v1', publicDocuments);
app.use('/api/customer/parking/v1/lookup', customerLookup);
if (config.documents.provider === 'LOCAL') app.use('/api/private-documents', privateDocuments);
app.use('/api/customer/parking/v1', customerAccounts);
app.use('/api/admin/auth', adminAuth);
app.use('/api/admin/parking/v1', adminDocuments);
app.use('/api/admin/parking/v1', adminCustomers);
app.use('/api/admin/parking/v1', adminReservationDesk);
app.use('/api/admin/parking/v1', adminParking);
app.use((_req, _res, next) => next(apiError('NOT_FOUND', 'Route not found', 404)));
app.use((error, _req, res, _next) => {
  const invalidJson = error?.type === 'entity.parse.failed';
  safeLog(invalidJson ? 'INVALID_JSON' : (error.code || 'server.error'), error);
  res.status(invalidJson ? 400 : (error.status || 500)).json({ error: {
    code: invalidJson ? 'INVALID_JSON' : (error.code || 'INTERNAL_ERROR'),
    message: invalidJson ? 'Request body must be valid JSON.' : (error.status ? error.message : 'An unexpected error occurred'),
    details: error.details
  } });
});

// ---- Startup and background work (explicit; nothing runs at require time) ----
let initialized = null;
async function init({ migrate = true, log = () => {} } = {}) {
  if (!initialized) {
    initialized = (async () => {
      await pool.query('SELECT 1');
      if (migrate) await runMigrations(pool, { log });
    })().catch(error => { initialized = null; throw error; });
  }
  return initialized;
}

let sweepRunning = false;
let lastChargeRollForward = 0;
async function sweep() {
  if (sweepRunning) return;
  sweepRunning = true;
  const client = await pool.connect();
  try {
    try {
      await client.query('BEGIN');
      await expirePendingBookings(client);
      await expireQuoteHolds(client);
      await releaseEndedSubscriptions(client);
      await customerAuth.cleanupExpired(client);
      await require('./services/customerDocuments').expirePendingUploads(client);
      await demoPaymentBypass.expireUnused(client);
      await client.query(`DELETE FROM parking_customer_lookup_grants
        WHERE expires_at<now()-interval '1 day' OR revoked_at<now()-interval '1 day'`);
      await client.query(`DELETE FROM parking_document_access_grants
        WHERE expires_at<now()-interval '1 day' OR used_at<now()-interval '1 day'`);
      await client.query('DELETE FROM parking_admin_sessions WHERE expires_at<=now()');
      await client.query('COMMIT');
      await customerNotifications.dispatchOutbox(pool);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      safeLog('background_sweep.error', error);
    }
    // Pay-on-site charges roll forward in their own transaction (at most every 10 minutes) so a bad
    // record can never block expiry, cleanup or customer messages.
    if (Date.now() - lastChargeRollForward > 600000) {
      lastChargeRollForward = Date.now();
      try {
        await client.query('BEGIN');
        await require('./services/onSiteBooking').ensureOnSiteMonthlyPeriods(client);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        safeLog('on_site_charges.error', error);
      }
    }
  } finally {
    client.release();
    sweepRunning = false;
  }
}

let sweepTimer = null;
function startBackgroundJobs() {
  if (sweepTimer) return sweepTimer;
  sweepTimer = setInterval(sweep, config.pendingExpiryIntervalMs);
  sweepTimer.unref();
  sweep();
  return sweepTimer;
}
function stopBackgroundJobs() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
async function close() {
  stopBackgroundJobs();
  await pool.end();
}

module.exports = app;
module.exports.init = init;
module.exports.runMigrations = runMigrations;
module.exports.startBackgroundJobs = startBackgroundJobs;
module.exports.stopBackgroundJobs = stopBackgroundJobs;
module.exports.sweep = sweep;
module.exports.close = close;
module.exports.pool = pool;
module.exports.config = config;
