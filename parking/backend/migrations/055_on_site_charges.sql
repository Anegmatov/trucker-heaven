-- Pay-on-site charges: confirmed pay-on-site reservations create ON_SITE billing periods so staff
-- see what each customer owes. A cancelled, expired or no-show reservation owes nothing, unless
-- staff already recorded money against it (then the charge stays so the money isn't shown as credit).
ALTER TABLE parking_customer_billing_periods DROP CONSTRAINT IF EXISTS parking_customer_billing_periods_source_check;
ALTER TABLE parking_customer_billing_periods ADD CONSTRAINT parking_customer_billing_periods_source_check
  CHECK (source IN ('BOOKING','STRIPE','LEGACY_EXCEL_IMPORT','ADMIN','ON_SITE'));

CREATE OR REPLACE VIEW parking_customer_billing_period_balances AS
SELECT period.id,period.public_id,period.customer_id,period.booking_id,period.period_start,
  due.amount_due_cents,period.due_date,period.currency,period.source,period.legacy_confidence,
  COALESCE(payment.paid_cents,0)::bigint paid_cents,
  GREATEST(due.amount_due_cents-COALESCE(payment.paid_cents,0),0)::bigint balance_cents,
  GREATEST(COALESCE(payment.paid_cents,0)-due.amount_due_cents,0)::bigint credit_cents,
  CASE
    WHEN due.amount_due_cents=0 THEN 'NOT_DUE'
    WHEN COALESCE(payment.paid_cents,0)>=due.amount_due_cents THEN 'PAID'
    WHEN COALESCE(payment.paid_cents,0)>0 THEN 'PARTIAL'
    WHEN period.due_date<current_date THEN 'OVERDUE'
    ELSE 'DUE'
  END status,
  period.created_at,period.updated_at
FROM parking_customer_billing_periods period
LEFT JOIN parking_bookings booking ON booking.id=period.booking_id
LEFT JOIN LATERAL (
  SELECT COALESCE(sum(base.amount_cents),0)+COALESCE(sum(base.adjustment_cents),0) paid_cents
  FROM (
    SELECT payment.amount_cents::bigint,COALESCE(sum(adjustment.amount_cents),0)::bigint adjustment_cents
    FROM parking_customer_payments payment
    LEFT JOIN parking_customer_payment_adjustments adjustment ON adjustment.payment_id=payment.id
    WHERE payment.billing_period_id=period.id AND payment.status='PAID'
    GROUP BY payment.id,payment.amount_cents
  ) base
) payment ON true
CROSS JOIN LATERAL (
  SELECT CASE WHEN period.source='ON_SITE' AND booking.status IN ('CANCELLED','EXPIRED','NO_SHOW')
      AND COALESCE(payment.paid_cents,0)=0
    THEN 0 ELSE period.amount_due_cents END::integer amount_due_cents
) due;
