ALTER TABLE parking_closures ADD COLUMN category_id bigint REFERENCES parking_categories(id);
ALTER TABLE parking_closures DROP CONSTRAINT parking_closures_check;
ALTER TABLE parking_closures ADD CONSTRAINT parking_closures_scope_check CHECK (location_id IS NOT NULL OR zone_id IS NOT NULL OR inventory_id IS NOT NULL OR category_id IS NOT NULL);
CREATE INDEX parking_closures_category_idx ON parking_closures(category_id) WHERE active;
