CREATE TABLE kitchen_devices (
  token_hash CHAR(64) PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  admin_user_id BIGINT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  device_name VARCHAR(200) NOT NULL DEFAULT 'Silk Road Kitchen',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE admin_push_subscriptions ADD COLUMN kitchen_device_hash CHAR(64)
  REFERENCES kitchen_devices(token_hash) ON DELETE CASCADE;
