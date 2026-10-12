const config = require('../config');
const { apiError } = require('../utils');

let testAdapter = null;
let client = null;

function configured() {
  return Boolean(testAdapter || config.stripe.secretKey);
}

function webhookConfigured() {
  return Boolean(testAdapter || config.stripe.webhookSecret);
}

function mode() {
  if (testAdapter) return 'test';
  if (config.stripe.secretKey.startsWith('sk_live_')) return 'live';
  if (config.stripe.secretKey.startsWith('sk_test_')) return 'test';
  return config.stripe.secretKey ? 'unknown' : 'missing';
}

function checkoutConfigured() {
  return configured() && webhookConfigured() && config.customerAppUrlConfigured;
}

function billingPortalConfigured() {
  return Boolean(testAdapter || (configured() && config.stripe.billingPortalConfigurationId));
}

function assertCheckoutConfigured() {
  if (!checkoutConfigured()) {
    throw apiError('PAYMENTS_NOT_CONFIGURED', 'Secure online checkout is temporarily unavailable. No payment was processed.', 503);
  }
}

function requireClient() {
  if (testAdapter) return testAdapter;
  if (!config.stripe.secretKey) {
    throw apiError('PAYMENTS_NOT_CONFIGURED', 'Online payments are not configured. Please contact ParkingOps.', 503);
  }
  if (!client) {
    // Loaded lazily so health/read-only parking APIs remain available when the
    // operator has not finished Stripe setup.
    const Stripe = require('stripe');
    client = new Stripe(config.stripe.secretKey, {
      apiVersion: config.stripe.apiVersion,
      maxNetworkRetries: 2
    });
  }
  return client;
}

async function createCheckoutSession(payload, idempotencyKey) {
  return requireClient().checkout.sessions.create(payload, { idempotencyKey });
}

async function createPortalSession(payload, idempotencyKey) {
  const stripe = requireClient();
  if (testAdapter?.billingPortal?.sessions?.create) {
    return testAdapter.billingPortal.sessions.create(payload, { idempotencyKey });
  }
  if (!config.stripe.billingPortalConfigurationId) {
    throw apiError('BILLING_PORTAL_NOT_CONFIGURED', 'Secure billing management is temporarily unavailable. Please contact ParkingOps.', 503);
  }
  return stripe.billingPortal.sessions.create({
    ...payload,
    // This must reference an operator-reviewed configuration with Stripe
    // subscription cancellation disabled. Parking cancellation stays inside
    // ParkingOps so exact-space release rules cannot be bypassed.
    configuration: config.stripe.billingPortalConfigurationId
  }, { idempotencyKey });
}

async function scheduleSubscriptionCancellation(subscriptionId, idempotencyKey) {
  const stripe = requireClient();
  if (testAdapter?.subscriptions?.update) {
    return testAdapter.subscriptions.update(subscriptionId, { cancel_at_period_end: true }, { idempotencyKey });
  }
  return stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true }, { idempotencyKey });
}

function constructWebhookEvent(rawBody, signature) {
  if (testAdapter?.constructWebhookEvent) return testAdapter.constructWebhookEvent(rawBody, signature);
  if (!config.stripe.webhookSecret) {
    throw apiError('STRIPE_WEBHOOK_NOT_CONFIGURED', 'Stripe webhook verification is not configured', 503);
  }
  if (!signature) throw apiError('STRIPE_SIGNATURE_INVALID', 'Stripe signature is required', 400);
  try {
    return requireClient().webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
  } catch (_) {
    throw apiError('STRIPE_SIGNATURE_INVALID', 'Stripe webhook signature is invalid', 400);
  }
}

function assertEventMode(event) {
  const expected = mode();
  if (!['live', 'test'].includes(expected)) return;
  if (typeof event?.livemode !== 'boolean' || event.livemode !== (expected === 'live')) {
    throw apiError('STRIPE_MODE_MISMATCH', 'Stripe event mode does not match the configured payment account', 400);
  }
}

function setTestAdapter(adapter) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Stripe test adapters are available only when NODE_ENV=test');
  testAdapter = adapter;
  client = null;
}

function clearTestAdapter() {
  testAdapter = null;
  client = null;
}

module.exports = {
  configured,
  webhookConfigured,
  checkoutConfigured,
  billingPortalConfigured,
  assertCheckoutConfigured,
  mode,
  assertEventMode,
  createCheckoutSession,
  createPortalSession,
  scheduleSubscriptionCancellation,
  constructWebhookEvent,
  setTestAdapter,
  clearTestAdapter
};
