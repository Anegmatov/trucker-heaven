const config = require('../config');
const { apiError, safeLog } = require('../utils');

let testAdapter = null;

function emailConfigured() {
  return Boolean(testAdapter || (config.notifications.emailProvider === 'RESEND'
    && config.notifications.resendApiKey && config.notifications.emailFrom));
}

function smsConfigured() {
  return Boolean(testAdapter || (config.notifications.smsProvider === 'TWILIO'
    && config.notifications.twilioAccountSid && config.notifications.twilioAuthToken
    && config.notifications.twilioFrom));
}

function configured(channel) {
  return String(channel).toUpperCase() === 'SMS' ? smsConfigured() : emailConfigured();
}

async function sendEmail({ to, subject, text }) {
  if (testAdapter) return testAdapter.send({ channel: 'EMAIL', to, subject, text });
  if (!emailConfigured()) throw apiError('AUTH_DELIVERY_NOT_CONFIGURED', 'Email sign-in is temporarily unavailable.', 503);
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${config.notifications.resendApiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: config.notifications.emailFrom, to: [to], subject, text })
  });
  if (!response.ok) throw apiError('NOTIFICATION_DELIVERY_FAILED', 'Email delivery is temporarily unavailable.', 503);
  return response.json().catch(() => ({}));
}

async function sendSms({ to, text }) {
  if (testAdapter) return testAdapter.send({ channel: 'SMS', to, text });
  if (!smsConfigured()) throw apiError('AUTH_DELIVERY_NOT_CONFIGURED', 'Text-message sign-in is temporarily unavailable.', 503);
  const account = encodeURIComponent(config.notifications.twilioAccountSid);
  const body = new URLSearchParams({ To: to, From: config.notifications.twilioFrom, Body: text });
  const auth = Buffer.from(`${config.notifications.twilioAccountSid}:${config.notifications.twilioAuthToken}`).toString('base64');
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${account}/Messages.json`, {
    method: 'POST',
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!response.ok) throw apiError('NOTIFICATION_DELIVERY_FAILED', 'Text-message delivery is temporarily unavailable.', 503);
  return response.json().catch(() => ({}));
}

async function sendLoginCode({ channel, destination, code, expiresMinutes }) {
  const text = `Your Trucker Heaven Parking sign-in code is ${code}. It expires in ${expiresMinutes} minutes. Never share this code.`;
  return String(channel).toUpperCase() === 'SMS'
    ? sendSms({ to: destination, text })
    : sendEmail({ to: destination, subject: 'Your My Parking sign-in code', text });
}

function payOnSiteMode() {
  return require('../config').paymentMode === 'PAY_ON_SITE';
}

function eventMessage(eventType, payload = {}) {
  const reference = payload.reservationNumber ? ` Reservation ${payload.reservationNumber}.` : '';
  switch (eventType) {
    case 'ADMIN_RESERVATION_CREATED': return {
      subject: 'Your Trucker Heaven parking reservation',
      text: payOnSiteMode()
        ? `Your Trucker Heaven parking reservation is confirmed. Pay at the Trucker Heaven office.${reference}`
        : `Your Trucker Heaven parking reservation was created and is awaiting secure payment.${reference}`
    };
    case 'ADMIN_PAYMENT_LINK_CREATED': return {
      subject: 'Secure payment for your parking reservation',
      text: `Complete secure payment for your Trucker Heaven parking reservation here: ${payload.checkoutUrl}.${reference} Payment is not recorded until Stripe verifies it.`
    };
    case 'RESERVATION_CONFIRMED': return payOnSiteMode()
      ? { subject: 'Your parking is confirmed', text: `Your Trucker Heaven parking is confirmed.${reference} Pay at the office: Daily and Weekly when you leave, Monthly on the 1st. 8037 Eastgate Blvd, Mt. Juliet, TN.${payload.manageUrl ? ` View or cancel: ${payload.manageUrl}` : ''} Questions: 615-470-5075.` }
      : { subject: 'Your parking is confirmed', text: `Your Trucker Heaven parking payment was verified and your parking is confirmed.${reference}` };
    case 'DEMO_RESERVATION_CONFIRMED': return { subject: 'Your Demo QA parking is confirmed', text: `Your Trucker Heaven operational Demo QA parking is confirmed. No payment was collected.${reference}` };
    case 'MONTHLY_RENEWED': return { subject: 'Monthly parking payment received', text: `Your Monthly parking renewal payment was received.${reference}` };
    case 'MONTHLY_PAYMENT_FAILED': return { subject: 'Monthly parking payment needs attention', text: `Your Monthly parking payment needs attention. Sign in to My Parking to review your billing status.${reference}` };
    case 'CANCELLATION_CONFIRMED': return payload.endOfTerm
      ? { subject: 'Monthly parking cancellation scheduled', text: `Your Monthly parking cancellation is scheduled for the end of the current paid period.${reference}` }
      : { subject: 'Parking cancellation confirmed', text: `Your parking cancellation is confirmed.${reference}` };
    case 'INSURANCE_DOCUMENT_ISSUE': return { subject: 'Insurance document needs attention', text: `Your insurance document needs attention. Sign in to My Parking for its current review status.${reference}` };
    case 'DOCUMENT_REPLACEMENT_REQUESTED': {
      const label = payload.documentType === 'DRIVER_LICENSE' ? 'driver license' : 'insurance document';
      return { subject: 'Parking document replacement requested', text: `A replacement ${label} is needed. Use Upload Documents or sign in to My Parking to submit it.${reference}` };
    }
    default: throw apiError('NOTIFICATION_EVENT_INVALID', 'Notification event is invalid', 500);
  }
}

async function enqueue(client, { customerId = null, bookingId = null, eventType, channel, destination, payload = {} }) {
  if (!destination) return null;
  const result = await client.query(`INSERT INTO parking_customer_notification_outbox(
      customer_id,booking_id,event_type,channel,destination,payload)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [customerId, bookingId, eventType, channel, destination, payload]);
  return Number(result.rows[0].id);
}

async function enqueueForBooking(client, booking, eventType, payload = {}) {
  const eventPayload = { reservationNumber: booking.reservation_number, ...payload };
  if (booking.email) return enqueue(client, { customerId: booking.customer_id, bookingId: booking.id,
    eventType, channel: 'EMAIL', destination: booking.email, payload: eventPayload });
  if (booking.mobile_phone) return enqueue(client, { customerId: booking.customer_id, bookingId: booking.id,
    eventType, channel: 'SMS', destination: booking.mobile_phone, payload: eventPayload });
  return null;
}

async function dispatchOutbox(pool, limit = 10) {
  let sent = 0;
  for (let index = 0; index < limit; index += 1) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query(`SELECT * FROM parking_customer_notification_outbox
        WHERE status='PENDING' AND next_attempt_at<=now() ORDER BY id
        LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
      if (!row) { await client.query('COMMIT'); break; }
      if (!configured(row.channel)) {
        // Messaging isn't set up: don't keep reservation access links around for more than a day.
        await client.query(`UPDATE parking_customer_notification_outbox SET
          payload=CASE WHEN created_at<now()-interval '1 day' THEN payload-'manageUrl' ELSE payload END,attempt_count=attempt_count+1,
          next_attempt_at=now()+interval '1 hour',last_error_code='TRANSPORT_NOT_CONFIGURED' WHERE id=$1`, [row.id]);
        await client.query('COMMIT');
        continue;
      }
      try {
        const message = eventMessage(row.event_type, row.payload);
        if (row.channel === 'SMS') await sendSms({ to: row.destination, text: message.text });
        else await sendEmail({ to: row.destination, subject: message.subject, text: message.text });
        // The manage link carries the reservation access code; keep it only until it is delivered.
        await client.query(`UPDATE parking_customer_notification_outbox SET status='SENT',sent_at=now(),
          attempt_count=attempt_count+1,last_error_code=NULL,payload=payload-'manageUrl' WHERE id=$1`, [row.id]);
        sent += 1;
      } catch (error) {
        const attempts = Number(row.attempt_count) + 1;
        await client.query(`UPDATE parking_customer_notification_outbox SET status=CASE WHEN $2>=5 THEN 'FAILED' ELSE 'PENDING' END,
          payload=CASE WHEN $2>=5 THEN payload-'manageUrl' ELSE payload END,
          attempt_count=$2,next_attempt_at=now()+((LEAST($2,5)*15)::text||' minutes')::interval,last_error_code=$3 WHERE id=$1`,
        [row.id, attempts, String(error.code || 'DELIVERY_FAILED').slice(0, 80)]);
        safeLog('customer_notification.delivery_failed', error);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      safeLog('customer_notification.dispatch_failed', error);
    } finally { client.release(); }
  }
  return sent;
}

function setTestAdapter(adapter) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Notification test adapters are available only when NODE_ENV=test');
  testAdapter = adapter;
}

function clearTestAdapter() { testAdapter = null; }

module.exports = {
  emailConfigured, smsConfigured, configured, sendLoginCode,
  enqueue, enqueueForBooking, dispatchOutbox, setTestAdapter, clearTestAdapter, eventMessage
};
