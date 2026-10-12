-- User-management updates carry a hidden optimistic version so stale owner
-- actions cannot silently overwrite a role or access-status change.
ALTER TABLE parking_admin_users
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

ALTER TABLE parking_admin_users
  DROP CONSTRAINT IF EXISTS parking_admin_users_version_check;
ALTER TABLE parking_admin_users
  ADD CONSTRAINT parking_admin_users_version_check CHECK (version >= 1);
