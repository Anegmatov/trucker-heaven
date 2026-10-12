const { AppError } = require('./http');

const INVENTORY_MODES = Object.freeze({
  MANUAL: 'MANUAL',
  QUANTITY_TRACKED: 'QUANTITY_TRACKED',
});

function effectiveAvailability(item) {
  return item.is_available === true
    && (item.inventory_mode !== INVENTORY_MODES.QUANTITY_TRACKED || Number(item.available_quantity) > 0);
}

function insufficientAvailability(item, requestedQuantity) {
  const availableQuantity = Math.max(0, Number(item.available_quantity) || 0);
  return new AppError(
    409,
    'INSUFFICIENT_AVAILABILITY',
    `Only ${availableQuantity} ${item.name} ${availableQuantity === 1 ? 'is' : 'are'} currently available. Update your order to continue.`,
    {
      item: { id: String(item.id), name: item.name },
      requestedQuantity,
      availableQuantity,
    },
  );
}

async function applyInventoryDeltas(client, deltas) {
  const grouped = new Map();
  for (const entry of deltas) {
    const menuItemId = String(entry.menuItemId);
    const delta = Number(entry.delta) || 0;
    if (delta) grouped.set(menuItemId, (grouped.get(menuItemId) || 0) + delta);
  }
  const ids = [...grouped.keys()].sort((a, b) => Number(a) - Number(b));
  if (!ids.length) return;
  const locked = await client.query(`SELECT id,name,inventory_mode,available_quantity
    FROM menu_items WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE`, [ids]);
  const byId = new Map(locked.rows.map((row) => [String(row.id), row]));
  if (byId.size !== ids.length) throw new AppError(409, 'ITEM_UNAVAILABLE', 'One or more menu items are unavailable. Refresh and try again.');
  for (const id of ids) {
    const item = byId.get(id);
    const delta = grouped.get(id);
    if (delta > 0) {
      if (item.inventory_mode !== INVENTORY_MODES.QUANTITY_TRACKED) {
        throw new AppError(409, 'INVENTORY_MODE_CHANGED', `${item.name} inventory settings changed. Refresh and try again.`);
      }
      if (Number(item.available_quantity) < delta) throw insufficientAvailability(item, delta);
      await client.query('UPDATE menu_items SET available_quantity=available_quantity-$2 WHERE id=$1', [id, delta]);
    } else {
      await client.query('UPDATE menu_items SET available_quantity=COALESCE(available_quantity,0)+$2 WHERE id=$1', [id, -delta]);
    }
  }
}

async function inventoryReservationsForOrder(client, orderId) {
  const base = await client.query(`SELECT id,menu_item_id,inventory_reserved_quantity
    FROM order_items WHERE order_id=$1 ORDER BY id`, [orderId]);
  const adjustments = await client.query(`SELECT DISTINCT ON (line_key) line_key,operation,menu_item_id,inventory_reserved_quantity
    FROM order_item_adjustments WHERE order_id=$1 ORDER BY line_key,id DESC`, [orderId]);
  const lines = new Map(base.rows.map((row) => [`base-${row.id}`, row]));
  for (const adjustment of adjustments.rows) {
    if (adjustment.operation === 'REMOVE') lines.delete(adjustment.line_key);
    else lines.set(adjustment.line_key, adjustment);
  }
  return [...lines.values()]
    .filter((line) => Number(line.inventory_reserved_quantity) > 0 && line.menu_item_id)
    .map((line) => ({ menuItemId: line.menu_item_id, quantity: Number(line.inventory_reserved_quantity) }));
}

async function restoreOrderInventory(client, order) {
  if (order.inventory_restored_at) return false;
  const reservations = await inventoryReservationsForOrder(client, order.id);
  await applyInventoryDeltas(client, reservations.map((entry) => ({ menuItemId: entry.menuItemId, delta: -entry.quantity })));
  await client.query('UPDATE orders SET inventory_restored_at=NOW() WHERE id=$1 AND inventory_restored_at IS NULL', [order.id]);
  return true;
}

module.exports = {
  INVENTORY_MODES,
  effectiveAvailability,
  insufficientAvailability,
  applyInventoryDeltas,
  inventoryReservationsForOrder,
  restoreOrderInventory,
};
