-- Active-order changes are revisions. The original order_items snapshots remain immutable.
CREATE TABLE order_item_adjustments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  line_key TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('UPSERT', 'REMOVE')),
  base_order_item_id BIGINT REFERENCES order_items(id) ON DELETE RESTRICT,
  menu_item_id BIGINT REFERENCES menu_items(id) ON DELETE SET NULL,
  item_name_snapshot TEXT NOT NULL DEFAULT '',
  description_snapshot TEXT NOT NULL DEFAULT '',
  unit_price_cents INTEGER NOT NULL DEFAULT 0 CHECK (unit_price_cents >= 0),
  modifier_total_cents INTEGER NOT NULL DEFAULT 0 CHECK (modifier_total_cents >= 0),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 99),
  customer_item_notes TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  actor_user_id BIGINT REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX order_item_adjustments_order_line_idx ON order_item_adjustments(order_id, line_key, id DESC);
CREATE TRIGGER order_item_adjustments_append_only
BEFORE UPDATE OR DELETE ON order_item_adjustments
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_change();
