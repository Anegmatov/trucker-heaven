ALTER TABLE menu_items
  ADD COLUMN dietary_information TEXT NOT NULL DEFAULT '',
  ADD COLUMN dietary_information_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN allergen_information TEXT NOT NULL DEFAULT '',
  ADD COLUMN allergen_information_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT menu_items_verified_dietary_information_check
    CHECK (NOT dietary_information_verified OR BTRIM(dietary_information) <> ''),
  ADD CONSTRAINT menu_items_verified_allergen_information_check
    CHECK (NOT allergen_information_verified OR BTRIM(allergen_information) <> '');

CREATE TABLE menu_modifier_groups (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  menu_item_id BIGINT NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  minimum_selections INTEGER NOT NULL DEFAULT 0 CHECK (minimum_selections BETWEEN 0 AND 50),
  maximum_selections INTEGER NOT NULL DEFAULT 1 CHECK (maximum_selections BETWEEN 1 AND 50),
  display_order INTEGER NOT NULL DEFAULT 0 CHECK (display_order >= 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (minimum_selections <= maximum_selections)
);
CREATE INDEX menu_modifier_groups_item_order_idx
  ON menu_modifier_groups(menu_item_id, is_active, display_order, id);

CREATE TABLE menu_modifier_options (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  modifier_group_id BIGINT NOT NULL REFERENCES menu_modifier_groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price_delta_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_delta_cents BETWEEN 0 AND 1000000),
  display_order INTEGER NOT NULL DEFAULT 0 CHECK (display_order >= 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX menu_modifier_options_group_order_idx
  ON menu_modifier_options(modifier_group_id, is_active, display_order, id);

ALTER TABLE order_items
  DROP CONSTRAINT IF EXISTS order_items_check;
ALTER TABLE order_items
  DROP CONSTRAINT IF EXISTS order_items_line_total_cents_check;
ALTER TABLE order_items
  ADD COLUMN modifier_total_cents INTEGER NOT NULL DEFAULT 0 CHECK (modifier_total_cents >= 0),
  ADD CONSTRAINT order_items_configured_line_total_check
    CHECK (line_total_cents = (unit_price_cents + modifier_total_cents) * quantity);

CREATE TABLE order_item_modifiers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_item_id BIGINT NOT NULL REFERENCES order_items(id) ON DELETE RESTRICT,
  modifier_group_id BIGINT REFERENCES menu_modifier_groups(id) ON DELETE SET NULL,
  modifier_option_id BIGINT REFERENCES menu_modifier_options(id) ON DELETE SET NULL,
  group_name_snapshot TEXT NOT NULL,
  option_name_snapshot TEXT NOT NULL,
  price_delta_cents INTEGER NOT NULL CHECK (price_delta_cents >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX order_item_modifiers_order_item_idx ON order_item_modifiers(order_item_id, id);

CREATE TRIGGER menu_modifier_groups_set_updated_at
BEFORE UPDATE ON menu_modifier_groups
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER menu_modifier_options_set_updated_at
BEFORE UPDATE ON menu_modifier_options
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER order_item_modifiers_append_only
BEFORE UPDATE OR DELETE ON order_item_modifiers
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_change();
