'use strict';

const { SUPPORTED_PUBLIC_DURATIONS } = require('./publicParkingProducts');

const PRODUCTS = Object.freeze({
  DAILY: Object.freeze({ eligibilityField: 'dailyEligible', priceField: 'daily_rate_cents', label: 'Daily parking' }),
  WEEKLY: Object.freeze({ eligibilityField: 'weeklyEligible', priceField: 'weekly_rate_cents', label: 'Weekly parking' }),
  MONTHLY: Object.freeze({ eligibilityField: 'monthlyEligible', priceField: 'monthly_rate_cents', label: 'Monthly parking' })
});

function ratePlanEffective(plan, now = Date.now()) {
  return Boolean(plan?.id && plan.active
    && (!plan.starts_at || new Date(plan.starts_at).getTime() <= now)
    && (!plan.ends_at || new Date(plan.ends_at).getTime() > now));
}

function eligibilityErrors(configuration, plan, { now = Date.now() } = {}) {
  const errors = [];
  const customer = configuration.purpose === 'CUSTOMER';
  const active = configuration.active === true;
  const enabled = {
    DAILY: configuration.dailyEligible === true,
    WEEKLY: configuration.weeklyEligible === true,
    MONTHLY: configuration.monthlyEligible === true
  };
  if (!customer) {
    if (Object.values(enabled).some(Boolean) || configuration.publicBookable || configuration.ratePlanId) {
      errors.push({ code: 'NON_CUSTOMER_BOOKING_CONFIGURATION', message: 'Shop, Company, Internal, and unresolved spaces cannot have customer booking products or a rate plan.' });
    }
    return errors;
  }
  if (Object.values(enabled).some(Boolean) && !plan) {
    errors.push({ code: 'RATE_PLAN_REQUIRED', message: 'Choose a compatible active rate plan before enabling parking products.' });
    return errors;
  }
  if (plan) {
    if (Number(plan.location_id) !== Number(configuration.locationId)
      || Number(plan.category_id) !== Number(configuration.categoryId)
      || (plan.zone_id !== null && Number(plan.zone_id) !== Number(configuration.zoneId))) {
      errors.push({ code: 'RATE_PLAN_INCOMPATIBLE', message: 'Choose a rate plan for this space type and parking area.' });
    }
    if (Object.values(enabled).some(Boolean) && !ratePlanEffective(plan, now)) {
      errors.push({ code: 'RATE_PLAN_INACTIVE', message: 'The assigned rate plan is inactive or outside its effective dates.' });
    }
    for (const [code, product] of Object.entries(PRODUCTS)) {
      if (enabled[code] && plan[product.priceField] == null) {
        errors.push({ code: `${code}_RATE_REQUIRED`, message: `${product.label} requires a configured ${code.toLowerCase()} price.` });
      }
    }
  }
  return errors;
}

function productEligible(configuration, plan, product, { now = Date.now() } = {}) {
  if (!SUPPORTED_PUBLIC_DURATIONS.includes(product)) return false;
  const definition = PRODUCTS[product];
  if (!definition) return false;
  return configuration.purpose === 'CUSTOMER'
    && configuration.active === true
    && configuration.publicBookable === true
    && configuration.classificationComplete === true
    && configuration[definition.eligibilityField] === true
    && ratePlanEffective(plan, now)
    && plan[definition.priceField] != null;
}

module.exports = Object.freeze({ PRODUCTS, ratePlanEffective, eligibilityErrors, productEligible });
