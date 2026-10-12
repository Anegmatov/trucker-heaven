const pool = require('../db');
const stripeGateway = require('../services/stripeGateway');
const { processStripeEvent } = require('../services/paymentLifecycle');

async function stripeWebhook(req, res, next) {
  let client;
  try {
    const event = stripeGateway.constructWebhookEvent(req.body, req.get('stripe-signature'));
    stripeGateway.assertEventMode(event);
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const result = await processStripeEvent(client, event);
    await client.query('COMMIT');
    res.json({ received: true, duplicate: result.duplicate });
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) { /* transaction may not have started */ }
    }
    next(error);
  } finally {
    client?.release();
  }
}

module.exports = stripeWebhook;
