-- Existing deployments may contain the formerly supported MANAGER role.
-- Preserve configuration authority by upgrading it to OWNER before narrowing
-- the constraint to the two active roles.
UPDATE parking_admin_users SET role='OWNER' WHERE role='MANAGER';
ALTER TABLE parking_admin_users DROP CONSTRAINT IF EXISTS parking_admin_users_role_check;
ALTER TABLE parking_admin_users
  ADD CONSTRAINT parking_admin_users_role_check CHECK (role IN ('OWNER','STAFF'));
