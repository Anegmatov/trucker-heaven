BEGIN;

ALTER TABLE parking_customer_notification_outbox
  DROP CONSTRAINT IF EXISTS parking_customer_notification_outbox_event_type_check;
ALTER TABLE parking_customer_notification_outbox
  ADD CONSTRAINT parking_customer_notification_outbox_event_type_check
    CHECK (event_type IN (
      'RESERVATION_CONFIRMED','MONTHLY_RENEWED','MONTHLY_PAYMENT_FAILED',
      'CANCELLATION_CONFIRMED','INSURANCE_DOCUMENT_ISSUE','DOCUMENT_REPLACEMENT_REQUESTED',
      'ADMIN_RESERVATION_CREATED','ADMIN_PAYMENT_LINK_CREATED'
    ));

COMMIT;
