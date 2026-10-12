-- PostgreSQL assigns the original unnamed scope check a generated name because
-- parking_closures already has other unnamed CHECK constraints. Remove both
-- possible generated names before retaining the category-aware replacement.
ALTER TABLE parking_closures DROP CONSTRAINT IF EXISTS parking_closures_check;
ALTER TABLE parking_closures DROP CONSTRAINT IF EXISTS parking_closures_check1;
ALTER TABLE parking_closures DROP CONSTRAINT IF EXISTS parking_closures_scope_check;
ALTER TABLE parking_closures ADD CONSTRAINT parking_closures_scope_check CHECK (location_id IS NOT NULL OR zone_id IS NOT NULL OR inventory_id IS NOT NULL OR category_id IS NOT NULL);
