CREATE TABLE admin_push_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  admin_user_id BIGINT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  fcm_token TEXT NOT NULL UNIQUE,
  platform VARCHAR(20) NOT NULL CHECK (platform IN ('ANDROID')),
  device_name VARCHAR(200),
  locale VARCHAR(10) NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'ru')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (char_length(fcm_token) BETWEEN 20 AND 4096)
);

CREATE INDEX admin_push_subscriptions_enabled_idx
  ON admin_push_subscriptions (enabled, platform)
  WHERE enabled = TRUE;

