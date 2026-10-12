-- Migration 016's generic constraint discovery did not match the original
-- parking_lot_layouts_status_check on all PostgreSQL renderings.  Retain the
-- immutable lifecycle check and remove only the obsolete two-state check.
ALTER TABLE parking_lot_layouts
  DROP CONSTRAINT IF EXISTS parking_lot_layouts_status_check;
