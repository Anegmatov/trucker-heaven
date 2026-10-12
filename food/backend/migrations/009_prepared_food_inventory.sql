ALTER TABLE menu_items
  ADD COLUMN inventory_mode TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN available_quantity INTEGER;

ALTER TABLE menu_items
  ADD CONSTRAINT menu_items_inventory_mode_check
    CHECK (inventory_mode IN ('MANUAL', 'QUANTITY_TRACKED')),
  ADD CONSTRAINT menu_items_available_quantity_check
    CHECK (available_quantity IS NULL OR available_quantity >= 0),
  ADD CONSTRAINT menu_items_tracked_quantity_required_check
    CHECK (inventory_mode <> 'QUANTITY_TRACKED' OR available_quantity IS NOT NULL);

ALTER TABLE order_items
  ADD COLUMN inventory_reserved_quantity INTEGER NOT NULL DEFAULT 0
    CHECK (inventory_reserved_quantity >= 0);

ALTER TABLE order_item_adjustments
  ADD COLUMN inventory_reserved_quantity INTEGER NOT NULL DEFAULT 0
    CHECK (inventory_reserved_quantity >= 0);

ALTER TABLE orders
  ADD COLUMN inventory_restored_at TIMESTAMPTZ;
