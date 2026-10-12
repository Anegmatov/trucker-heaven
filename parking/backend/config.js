const path = require('path');
// The module's own .env (never the process working directory); real deployments set variables directly.
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const { env, key } = require('./env');

function integer(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env(name);
  const value = raw == null || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key(name)} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function boolean(name, fallback = false) {
  const raw = env(name);
  if (raw == null || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${key(name)} must be true or false`);
}

function sameSite(name = 'COOKIE_SAME_SITE', fallback = 'lax') {
  const value = String(env(name) || fallback).toLowerCase();
  if (!['lax', 'strict', 'none'].includes(value)) throw new Error(`${key(name)} must be lax, strict, or none`);
  return value;
}

function origins() {
  return String(env('PARKING_CORS_ALLOWED_ORIGINS') || 'http://localhost:5180,http://localhost:5181,http://127.0.0.1:5180,http://127.0.0.1:5181')
    .split(',').map(value => value.trim()).filter(Boolean);
}

function applicationUrl(name, fallback) {
  const value = String(env(name) || fallback).replace(/\/$/, '');
  let parsed;
  try { parsed = new URL(value); } catch (_) { throw new Error(`${key(name)} must be an absolute http(s) URL`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${key(name)} must be an absolute http(s) URL`);
  return value;
}

const production = process.env.NODE_ENV === 'production';
const config = Object.freeze({
  production,
  // PORT is read by server.js only; a parent app that mounts this module listens itself.
  port: Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 3001,
  // The one database this module owns. Development falls back to a local parkingops database.
  databaseUrl: String(env('DATABASE_URL') || (production ? '' : 'postgres://localhost:5432/parkingops')),
  trustProxyHops: integer('TRUST_PROXY_HOPS', production ? 1 : 0, { min: 0, max: 10 }),
  corsAllowedOrigins: Object.freeze(origins()),
  customerAppUrl: applicationUrl('CUSTOMER_APP_URL', 'http://localhost:5181'),
  customerAppUrlConfigured: !production || Boolean(env('CUSTOMER_APP_URL')),
  adminAppUrl: applicationUrl('ADMIN_APP_URL', 'http://localhost:5180'),
  adminAppUrlConfigured: !production || Boolean(env('ADMIN_APP_URL')),
  jsonBodyLimit: env('JSON_BODY_LIMIT') || '100kb',
  cookie: Object.freeze({
    name: env('SESSION_COOKIE_NAME') || 'parking_admin_session',
    secure: boolean('PARKING_COOKIE_SECURE', production),
    sameSite: sameSite(),
    ttlSeconds: integer('SESSION_TTL_SECONDS', 28800, { min: 300, max: 2592000 }),
    tokenPepper: env('PARKING_SESSION_TOKEN_PEPPER') || ''
  }),
  // My Parking / Upload Documents: short-lived email+phone lookup grant (the only customer sign-in).
  customerLookup: Object.freeze({
    cookieName: env('CUSTOMER_LOOKUP_COOKIE_NAME') || 'parking_customer_lookup',
    cookieSecure: boolean('PARKING_CUSTOMER_COOKIE_SECURE', production),
    cookieSameSite: sameSite('CUSTOMER_COOKIE_SAME_SITE', production ? 'none' : 'lax'),
    pepper: env('PARKING_CUSTOMER_LOOKUP_PEPPER') || env('PARKING_SESSION_TOKEN_PEPPER') || '',
    ttlSeconds: integer('CUSTOMER_LOOKUP_TTL_SECONDS', 900, { min: 300, max: 3600 }),
    attemptsPerWindow: integer('CUSTOMER_LOOKUP_RATE_LIMIT_MAX', 8, { min: 1, max: 100 }),
    windowSeconds: integer('CUSTOMER_LOOKUP_RATE_LIMIT_WINDOW_SECONDS', 900, { min: 60, max: 86400 })
  }),
  notifications: Object.freeze({
    emailProvider: String(env('NOTIFICATION_EMAIL_PROVIDER') || '').trim().toUpperCase(),
    emailFrom: String(env('NOTIFICATION_EMAIL_FROM') || '').trim(),
    resendApiKey: env('RESEND_API_KEY') || '',
    smsProvider: String(env('NOTIFICATION_SMS_PROVIDER') || '').trim().toUpperCase(),
    twilioAccountSid: env('TWILIO_ACCOUNT_SID') || '',
    twilioAuthToken: env('TWILIO_AUTH_TOKEN') || '',
    twilioFrom: env('TWILIO_FROM_NUMBER') || ''
  }),
  rateLimits: Object.freeze({
    general: integer('GENERAL_RATE_LIMIT_MAX', 300, { min: 1 }),
    booking: integer('PUBLIC_BOOKING_RATE_LIMIT_MAX', 12, { min: 1 }),
    lookup: integer('PUBLIC_LOOKUP_RATE_LIMIT_MAX', 12, { min: 1 }),
    availability: integer('PUBLIC_AVAILABILITY_RATE_LIMIT_MAX', 60, { min: 1 }),
    quote: integer('PUBLIC_QUOTE_RATE_LIMIT_MAX', 30, { min: 1 })
  }),
  bookingPolicy: Object.freeze({
    minimumLeadMinutes: integer('PUBLIC_BOOKING_MINIMUM_LEAD_MINUTES', 0, { min: 0, max: 10080 }),
    maximumHorizonDays: integer('PUBLIC_BOOKING_MAXIMUM_HORIZON_DAYS', 3650, { min: 1, max: 3650 }),
    minimumWeeklyDays: integer('PARKING_PUBLIC_BOOKING_MINIMUM_WEEKLY_DAYS', 7, { min: 1, max: 27 }),
    maximumWeeklyDays: integer('PARKING_PUBLIC_BOOKING_MAXIMUM_WEEKLY_DAYS', 27, { min: 7, max: 365 }),
    minimumMonthlyDays: integer('PARKING_PUBLIC_BOOKING_MINIMUM_MONTHLY_DAYS', 28, { min: 1, max: 365 }),
    maximumDailyDays: integer('PUBLIC_BOOKING_MAXIMUM_DAILY_DAYS', 27, { min: 1, max: 365 }),
    maximumMonthlyDays: integer('PARKING_PUBLIC_BOOKING_MAXIMUM_MONTHLY_DAYS', 366, { min: 28, max: 3650 }),
    quoteTtlSeconds: integer('PUBLIC_QUOTE_TTL_SECONDS', 600, { min: 60, max: 86400 })
  }),
  // PAY_ON_SITE (default): bookings confirm immediately and customers pay at
  // Trucker Heaven; staff record payments in the customer ledger.
  // STRIPE: the previous online-checkout flow.
  paymentMode: (() => {
    const mode = String(env('PARKING_PAYMENT_MODE') || 'PAY_ON_SITE').trim().toUpperCase();
    if (!['PAY_ON_SITE', 'STRIPE'].includes(mode)) throw new Error('PARKING_PAYMENT_MODE must be PAY_ON_SITE or STRIPE');
    return mode;
  })(),
  stripe: Object.freeze({
    secretKey: env('STRIPE_SECRET_KEY') || '',
    webhookSecret: env('STRIPE_WEBHOOK_SECRET') || '',
    billingPortalConfigurationId: env('STRIPE_BILLING_PORTAL_CONFIGURATION_ID') || '',
    apiVersion: String(env('STRIPE_API_VERSION') || '2026-07-29.dahlia'),
    currency: String(env('STRIPE_CURRENCY') || 'usd').toLowerCase(),
    checkoutTtlSeconds: integer('STRIPE_CHECKOUT_TTL_SECONDS', 1800, { min: 1800, max: 86400 }),
    webhookGraceSeconds: integer('STRIPE_WEBHOOK_GRACE_SECONDS', 300, { min: 60, max: 3600 }),
    monthlyGraceDays: integer('MONTHLY_PAYMENT_GRACE_DAYS', 7, { min: 0, max: 60 })
  }),
  demoPaymentBypass: Object.freeze({
    enabled: boolean('DEMO_PAYMENT_BYPASS_ENABLED', false),
    ttlSeconds: integer('DEMO_PAYMENT_BYPASS_TTL_SECONDS', 300, { min: 60, max: 900 })
  }),
  documents: Object.freeze({
    provider: String(env('DOCUMENT_STORAGE_PROVIDER') || '').toUpperCase(),
    bucket: env('DOCUMENT_STORAGE_BUCKET') || '',
    region: env('DOCUMENT_STORAGE_REGION') || 'us-east-1',
    endpoint: env('DOCUMENT_STORAGE_ENDPOINT') || '',
    forcePathStyle: boolean('DOCUMENT_STORAGE_FORCE_PATH_STYLE', false),
    uploadTtlSeconds: integer('DOCUMENT_UPLOAD_TTL_SECONDS', 600, { min: 60, max: 3600 }),
    readTtlSeconds: integer('DOCUMENT_READ_TTL_SECONDS', 300, { min: 30, max: 900 }),
    maxBytes: integer('DOCUMENT_MAX_BYTES', 15728640, { min: 1024, max: 52428800 }),
    // DOCUMENT_STORAGE_PROVIDER=LOCAL keeps files on this server's disk instead of S3.
    localDirectory: env('DOCUMENT_STORAGE_DIR') || path.join(__dirname, 'private-documents'),
    // Origin that browsers use to reach this API ('' when the site proxies /api to it).
    localPublicUrl: String(env('DOCUMENT_STORAGE_PUBLIC_URL') || '').replace(/\/$/, ''),
    localSecret: env('DOCUMENT_STORAGE_SECRET') || ''
  }),
  pendingExpiryIntervalMs: integer('PENDING_EXPIRY_INTERVAL_MS', 60000, { min: 5000, max: 3600000 }),
  shutdownTimeoutMs: integer('SHUTDOWN_TIMEOUT_MS', 10000, { min: 1000, max: 120000 }),
  adminLockout: Object.freeze({
    threshold: integer('ADMIN_LOCKOUT_THRESHOLD', 5, { min: 1, max: 100 }),
    seconds: integer('ADMIN_LOCKOUT_SECONDS', 900, { min: 1, max: 86400 })
  })
});

if (config.bookingPolicy.minimumMonthlyDays > config.bookingPolicy.maximumMonthlyDays) {
  throw new Error('PARKING_PUBLIC_BOOKING_MINIMUM_MONTHLY_DAYS cannot exceed PARKING_PUBLIC_BOOKING_MAXIMUM_MONTHLY_DAYS');
}
if (config.bookingPolicy.minimumWeeklyDays > config.bookingPolicy.maximumWeeklyDays) {
  throw new Error('PARKING_PUBLIC_BOOKING_MINIMUM_WEEKLY_DAYS cannot exceed PARKING_PUBLIC_BOOKING_MAXIMUM_WEEKLY_DAYS');
}

if (production) {
  if (!config.databaseUrl) throw new Error('Production requires PARKING_DATABASE_URL');
  if (config.cookie.tokenPepper.length < 32) throw new Error('Production requires PARKING_SESSION_TOKEN_PEPPER with at least 32 characters');
  if (!config.cookie.secure) throw new Error('Production requires PARKING_COOKIE_SECURE=true');
  if (!config.customerLookup.cookieSecure) throw new Error('Production requires PARKING_CUSTOMER_COOKIE_SECURE=true');
  if (config.customerLookup.pepper.length < 32) throw new Error('Production requires PARKING_CUSTOMER_LOOKUP_PEPPER or PARKING_SESSION_TOKEN_PEPPER with at least 32 characters');
  if (!config.corsAllowedOrigins.length || config.corsAllowedOrigins.includes('*')) {
    throw new Error('Production requires explicit PARKING_CORS_ALLOWED_ORIGINS');
  }
}

module.exports = config;
