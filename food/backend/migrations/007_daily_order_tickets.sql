ALTER TABLE orders ADD COLUMN IF NOT EXISTS daily_ticket_date DATE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS daily_ticket_number INTEGER;

WITH numbered AS (
  SELECT id, (created_at AT TIME ZONE 'America/Chicago')::date AS ticket_date,
    ROW_NUMBER() OVER (PARTITION BY (created_at AT TIME ZONE 'America/Chicago')::date ORDER BY created_at, id)::integer AS ticket_number
  FROM orders
)
UPDATE orders o SET daily_ticket_date=numbered.ticket_date, daily_ticket_number=numbered.ticket_number
FROM numbered WHERE o.id=numbered.id AND (o.daily_ticket_date IS NULL OR o.daily_ticket_number IS NULL);

ALTER TABLE orders ALTER COLUMN daily_ticket_date SET NOT NULL;
ALTER TABLE orders ALTER COLUMN daily_ticket_number SET NOT NULL;
ALTER TABLE orders ADD CONSTRAINT orders_daily_ticket_unique UNIQUE (daily_ticket_date, daily_ticket_number);

CREATE TABLE IF NOT EXISTS order_daily_ticket_counters (
  ticket_date DATE PRIMARY KEY,
  next_ticket_number INTEGER NOT NULL CHECK (next_ticket_number > 0)
);

INSERT INTO order_daily_ticket_counters (ticket_date, next_ticket_number)
SELECT daily_ticket_date, MAX(daily_ticket_number) + 1 FROM orders GROUP BY daily_ticket_date
ON CONFLICT (ticket_date) DO UPDATE SET next_ticket_number=GREATEST(order_daily_ticket_counters.next_ticket_number, EXCLUDED.next_ticket_number);
