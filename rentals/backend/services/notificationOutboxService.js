const crypto = require("crypto");

const NOTIFICATION_STATUSES = Object.freeze(["PENDING", "PROCESSING", "RETRY_WAIT", "SENT", "DEAD_LETTER", "SKIPPED"]);
const TEMPLATE_KEYS = Object.freeze({
  OFFICE_RESERVATION_CREATED: "OFFICE_RESERVATION_CREATED",
  CUSTOMER_REQUEST_RECEIVED: "CUSTOMER_REQUEST_RECEIVED",
  CUSTOMER_RESERVATION_CONFIRMED: "CUSTOMER_RESERVATION_CONFIRMED",
  CUSTOMER_RESERVATION_DECLINED: "CUSTOMER_RESERVATION_DECLINED",
  CUSTOMER_DRIVER_LICENSE_APPROVED: "CUSTOMER_DRIVER_LICENSE_APPROVED",
  CUSTOMER_DRIVER_LICENSE_REJECTED: "CUSTOMER_DRIVER_LICENSE_REJECTED",
  CUSTOMER_INSURANCE_APPROVED: "CUSTOMER_INSURANCE_APPROVED",
  CUSTOMER_INSURANCE_REJECTED: "CUSTOMER_INSURANCE_REJECTED",
  CUSTOMER_DOCUMENTS_APPROVED: "CUSTOMER_DOCUMENTS_APPROVED"
});

function sha256(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function safeTemplateParams(value = {}) { return typeof value === "object" && value && !Array.isArray(value) ? value : {}; }

async function enqueueNotification(client, { reservationId, eventType, businessEventKey, templateKey, templateParams = {} }) {
  const result = await client.query(
    `INSERT INTO notification_outbox
      (reservation_id, channel, event_type, business_event_key, template_key, template_params, content_hash)
     VALUES ($1, 'SMS', $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (business_event_key) DO UPDATE SET business_event_key = EXCLUDED.business_event_key
     RETURNING id, status, attempt_count`,
    [reservationId || null, eventType, businessEventKey, templateKey, JSON.stringify(safeTemplateParams(templateParams)), sha256(`${templateKey}:${JSON.stringify(safeTemplateParams(templateParams))}`)]
  );
  return result.rows[0];
}

function eventKey(reservationId, eventType, statusVersion = 0) {
  return `reservation:${Number(reservationId)}:${eventType}:${Number(statusVersion)}`;
}

async function enqueueReservationCreated(client, reservation, { manageUrl = null } = {}) {
  const version = Number(reservation.statusversion || 1);
  await enqueueNotification(client, { reservationId: reservation.reservationid, eventType: "RESERVATION_CREATED_OFFICE", businessEventKey: eventKey(reservation.reservationid, "RESERVATION_CREATED_OFFICE", version), templateKey: TEMPLATE_KEYS.OFFICE_RESERVATION_CREATED });
  // manageUrl carries the customer's private access code; the worker removes it once the text is sent.
  return enqueueNotification(client, { reservationId: reservation.reservationid, eventType: "RESERVATION_CREATED_CUSTOMER", businessEventKey: eventKey(reservation.reservationid, "RESERVATION_CREATED_CUSTOMER", version), templateKey: TEMPLATE_KEYS.CUSTOMER_REQUEST_RECEIVED, templateParams: manageUrl ? { manageUrl } : {} });
}

async function enqueueLifecycleNotification(client, reservation, operation) {
  const map = { CONFIRM: ["RESERVATION_CONFIRMED", TEMPLATE_KEYS.CUSTOMER_RESERVATION_CONFIRMED], DECLINE: ["RESERVATION_DECLINED", TEMPLATE_KEYS.CUSTOMER_RESERVATION_DECLINED] };
  const definition = map[operation];
  if (!definition) return null;
  return enqueueNotification(client, { reservationId: reservation.reservationid, eventType: definition[0], businessEventKey: eventKey(reservation.reservationid, definition[0], reservation.statusversion), templateKey: definition[1] });
}

async function enqueueDocumentReviewNotification(client, {
  reservationId,
  documentId,
  documentType,
  status,
  customerInstruction,
  bothApproved = false
}) {
  const type = String(documentType || "").toUpperCase();
  const reviewStatus = String(status || "").toUpperCase();
  const templateKey = `CUSTOMER_${type}_${reviewStatus}`;
  if (!["DRIVER_LICENSE", "INSURANCE"].includes(type)
    || !["APPROVED", "REJECTED"].includes(reviewStatus)
    || !Object.values(TEMPLATE_KEYS).includes(templateKey)) {
    throw new Error("Unsupported document review notification");
  }
  const eventType = `${type}_${reviewStatus}`;
  await enqueueNotification(client, {
    reservationId,
    eventType,
    businessEventKey: `reservation:${Number(reservationId)}:document:${Number(documentId)}:${reviewStatus}`,
    templateKey,
    templateParams: customerInstruction ? { customerInstruction } : {}
  });
  if (reviewStatus === "APPROVED" && bothApproved) {
    await enqueueNotification(client, {
      reservationId,
      eventType: "REQUIRED_DOCUMENTS_APPROVED",
      businessEventKey: `reservation:${Number(reservationId)}:documents-approved:${Number(documentId)}`,
      templateKey: TEMPLATE_KEYS.CUSTOMER_DOCUMENTS_APPROVED
    });
  }
}

async function readNotificationHistory(database, reservationId) {
  const result = await database.query(
    `SELECT event_type, status, attempt_count, last_error_code, created_at, updated_at, sent_at,
      (SELECT MAX(attempted_at) FROM notification_attempts WHERE notification_id = notification_outbox.id) AS last_attempted_at
     FROM notification_outbox WHERE reservation_id = $1 ORDER BY created_at ASC, id ASC`, [reservationId]
  );
  return result.rows.map((row) => ({ eventType: row.event_type, status: row.status, attemptCount: Number(row.attempt_count), lastAttemptedAt: row.last_attempted_at, sentAt: row.sent_at, safeDetail: row.last_error_code || null }));
}

module.exports = {
  NOTIFICATION_STATUSES,
  TEMPLATE_KEYS,
  enqueueDocumentReviewNotification,
  enqueueLifecycleNotification,
  enqueueNotification,
  enqueueReservationCreated,
  eventKey,
  readNotificationHistory,
  sha256
};
