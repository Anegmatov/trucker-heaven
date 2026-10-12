CREATE TABLE catering_requests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_request_number TEXT NOT NULL UNIQUE
    CHECK (public_request_number ~ '^CAT-[0-9]{8}-[A-F0-9]{6}$'),
  full_name TEXT NOT NULL CHECK (BTRIM(full_name) <> ''),
  phone TEXT NOT NULL CHECK (BTRIM(phone) <> ''),
  email TEXT NOT NULL CHECK (BTRIM(email) <> ''),
  company TEXT NOT NULL DEFAULT '',
  event_date DATE NOT NULL,
  pickup_time TIME NOT NULL,
  guest_count INTEGER NOT NULL CHECK (guest_count BETWEEN 1 AND 10000),
  order_type TEXT NOT NULL CHECK (order_type IN ('PICKUP', 'DELIVERY')),
  interested_in TEXT[] NOT NULL DEFAULT '{}',
  special_notes TEXT NOT NULL DEFAULT '',
  preferred_contact_method TEXT NOT NULL
    CHECK (preferred_contact_method IN ('PHONE', 'EMAIL')),
  admin_notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'NEW'
    CHECK (status IN ('NEW', 'CONTACTED', 'QUOTING', 'CONFIRMED', 'DECLINED', 'COMPLETED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX catering_requests_status_created_idx
  ON catering_requests(status, created_at DESC);
CREATE INDEX catering_requests_event_date_idx
  ON catering_requests(event_date, pickup_time);
CREATE TRIGGER catering_requests_set_updated_at
  BEFORE UPDATE ON catering_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
