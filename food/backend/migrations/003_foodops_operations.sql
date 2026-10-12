ALTER TABLE site_settings
  ADD COLUMN timezone TEXT NOT NULL DEFAULT 'America/Chicago',
  ADD COLUMN public_description TEXT NOT NULL DEFAULT '',
  ADD COLUMN pickup_instructions TEXT NOT NULL DEFAULT '',
  ADD COLUMN dine_in_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN takeout_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN accepting_orders BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE daily_specials
  ADD COLUMN is_sold_out BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE gallery_items
  ADD COLUMN category TEXT NOT NULL DEFAULT 'food'
    CHECK (category IN ('food', 'lounge', 'facility'));

CREATE TABLE business_exceptions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exception_date DATE NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  opens_at TIME,
  closes_at TIME,
  is_closed BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (is_closed OR (opens_at IS NOT NULL AND closes_at IS NOT NULL))
);
CREATE INDEX business_exceptions_date_idx ON business_exceptions(exception_date);
CREATE TRIGGER business_exceptions_set_updated_at BEFORE UPDATE ON business_exceptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO site_settings (
  id, business_name, hero_title, hero_subtitle, address, phone, email, map_url,
  parent_site_url, public_description, pickup_instructions, timezone,
  dine_in_wording, takeout_wording, truck_parking_wording,
  order_payment_instructions, dine_in_enabled, takeout_enabled, accepting_orders
) VALUES (
  1,
  'Trucker Heaven Food & Lounge',
  'Food & Lounge',
  'Hot food and a practical place to reset inside the Trucker Heaven transportation ecosystem.',
  '8037 Eastgate Blvd, Mt. Juliet, TN 37122',
  '615-470-5075',
  '',
  'https://www.google.com/maps/search/?api=1&query=Trucker+Heaven+8037+Eastgate+Blvd+Mt+Juliet+TN',
  'https://trucker-heaven-main-website.onrender.com',
  'Food and lounge service for drivers, local customers, and visitors to the Trucker Heaven facility.',
  'Pick up at the Food & Lounge counter inside Trucker Heaven. Call the facility if you need arrival guidance.',
  'America/Chicago',
  'Dine in on site when the dining area is available.',
  'Order ahead and pick up at the Food & Lounge counter.',
  'Trucker Heaven parking is available through the dedicated Parking application.',
  'Payment is collected at pickup or on site.',
  TRUE,
  TRUE,
  TRUE
) ON CONFLICT (id) DO UPDATE SET
  business_name = CASE WHEN BTRIM(site_settings.business_name) = '' THEN EXCLUDED.business_name ELSE site_settings.business_name END,
  hero_title = CASE WHEN BTRIM(site_settings.hero_title) = '' THEN EXCLUDED.hero_title ELSE site_settings.hero_title END,
  hero_subtitle = CASE WHEN BTRIM(site_settings.hero_subtitle) = '' THEN EXCLUDED.hero_subtitle ELSE site_settings.hero_subtitle END,
  address = CASE WHEN BTRIM(site_settings.address) = '' THEN EXCLUDED.address ELSE site_settings.address END,
  phone = CASE WHEN BTRIM(site_settings.phone) = '' THEN EXCLUDED.phone ELSE site_settings.phone END,
  map_url = CASE WHEN BTRIM(site_settings.map_url) = '' THEN EXCLUDED.map_url ELSE site_settings.map_url END,
  parent_site_url = CASE WHEN BTRIM(site_settings.parent_site_url) = '' THEN EXCLUDED.parent_site_url ELSE site_settings.parent_site_url END,
  public_description = CASE WHEN BTRIM(site_settings.public_description) = '' THEN EXCLUDED.public_description ELSE site_settings.public_description END,
  pickup_instructions = CASE WHEN BTRIM(site_settings.pickup_instructions) = '' THEN EXCLUDED.pickup_instructions ELSE site_settings.pickup_instructions END,
  updated_at = NOW();
