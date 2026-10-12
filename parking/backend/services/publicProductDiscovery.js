'use strict';

const { SUPPORTED_PUBLIC_DURATIONS } = require('./publicParkingProducts');

function validPrice(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function publicPlanName(value) {
  const name = String(value || '').trim();
  return name && !/weekly/i.test(name) ? name : 'Parking rate';
}

function configuredCustomerRow(row, now = Date.now()) {
  const startsAt = row.rule_starts_at ? new Date(row.rule_starts_at).getTime() : null;
  const endsAt = row.rule_ends_at ? new Date(row.rule_ends_at).getTime() : null;
  return row.layout_status === 'PUBLISHED'
    && row.element_type === 'PARKING_SPOT'
    && row.inventory_active === true
    && row.zone_active === true
    && row.zone_public_visible === true
    && row.category_active === true
    && row.element_active === true
    && row.element_public_visible === true
    && row.parking_purpose === 'CUSTOMER'
    && row.space_public_bookable === true
    && row.spot_active === true
    && row.spot_public_bookable === true
    && row.classification_state === 'COMPLETE'
    && row.rate_plan_id != null
    && String(row.rate_plan_id) === String(row.assigned_rate_plan_id)
    && row.rule_active === true
    && String(row.rule_location_id) === String(row.inventory_location_id)
    && String(row.rule_category_id) === String(row.inventory_category_id)
    && (row.rule_zone_id == null || String(row.rule_zone_id) === String(row.inventory_zone_id))
    && (startsAt === null || startsAt <= now)
    && (endsAt === null || endsAt > now);
}

function discoverCategoryProducts(rows, categories, now = Date.now()) {
  const byCategory = new Map((categories || []).map(category => [category.code, new Map()]));
  for (const row of rows || []) {
    const products = byCategory.get(row.code);
    if (!products || !configuredCustomerRow(row, now)) continue;
    for (const [code, enabled, rawPrice] of [
      ['DAILY', row.daily_eligible, row.daily_rate_cents],
      ['WEEKLY', row.weekly_eligible, row.weekly_rate_cents],
      ['MONTHLY', row.monthly_eligible, row.monthly_rate_cents]
    ]) {
      if (!enabled) continue;
      const unitRateCents = validPrice(rawPrice);
      if (unitRateCents === null) continue;
      const current = products.get(code);
      if (!current || unitRateCents < current.unitRateCents) {
        products.set(code, { code, unitRateCents, ratePlan: publicPlanName(row.plan_name) });
      }
    }
  }
  return (categories || []).map(category => {
    const products = byCategory.get(category.code) || new Map();
    const discovered = SUPPORTED_PUBLIC_DURATIONS.flatMap(code => products.has(code) ? [products.get(code)] : []);
    const offeredDurations = discovered.map(({ code, unitRateCents }) => ({ code, unitRateCents }));
    return {
      ...category,
      ratePlan: discovered[0]?.ratePlan || null,
      offeredDurations,
      startingRateCents: offeredDurations.length ? Math.min(...offeredDurations.map(item => item.unitRateCents)) : null,
      pricingAvailable: offeredDurations.length > 0
    };
  });
}

async function catalogCategoryOffers(client, locationId, categories) {
  const result = await client.query(`SELECT c.code,layout.status layout_status,element.element_type,
      z.location_id inventory_location_id,i.zone_id inventory_zone_id,i.category_id inventory_category_id,i.active inventory_active,
      z.active zone_active,z.public_visible zone_public_visible,c.active category_active,
      element.active element_active,element.public_visible element_public_visible,element.parking_purpose,
      element.space_public_bookable,element.daily_eligible,element.weekly_eligible,element.monthly_eligible,element.rate_plan_id assigned_rate_plan_id,
      spot.active spot_active,spot.public_bookable spot_public_bookable,spot.classification_state,
      rule.id rate_plan_id,rule.location_id rule_location_id,rule.zone_id rule_zone_id,rule.category_id rule_category_id,
      rule.active rule_active,rule.starts_at rule_starts_at,rule.ends_at rule_ends_at,
      rule.plan_name,rule.daily_rate_cents,rule.weekly_rate_cents,rule.monthly_rate_cents
    FROM parking_inventory i
    JOIN parking_zones z ON z.id=i.zone_id
    JOIN parking_categories c ON c.id=i.category_id
    JOIN parking_lot_layouts layout ON layout.location_id=$1 AND layout.status='PUBLISHED'
    JOIN parking_layout_elements element ON element.layout_id=layout.id AND element.inventory_id=i.id
      AND element.element_type='PARKING_SPOT'
    JOIN parking_spots spot ON spot.id=element.parking_spot_id
    JOIN parking_rate_rules rule ON rule.id=element.rate_plan_id
    WHERE z.location_id=$1 AND c.code=ANY($2::text[])`, [locationId, categories.map(category => category.code)]);
  return discoverCategoryProducts(result.rows, categories);
}

module.exports = Object.freeze({ configuredCustomerRow, discoverCategoryProducts, catalogCategoryOffers });
