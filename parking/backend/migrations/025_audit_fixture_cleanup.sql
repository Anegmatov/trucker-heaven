-- Reassert the immutable audit function independently of trigger creation so
-- upgrades from a prerelease 024 definition converge on the fail-closed form.
CREATE OR REPLACE FUNCTION prevent_parking_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'parking audit records are immutable' USING ERRCODE='55000';
END;
$$ LANGUAGE plpgsql;
